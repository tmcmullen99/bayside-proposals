/**
 * BPB Sprint 12C — /api/nurture-unsubscribe
 *
 * Flips clients.nurture_opted_out_at = NOW() for the given client_id.
 * Public endpoint — no auth — since it's reached by clicking a link in a
 * nurture email. The token is just the client_id UUID (low risk: leaking
 * a UUID to opt someone out of nurture emails is a minor abuse vector).
 *
 * Supports:
 *   GET  /api/nurture-unsubscribe?id=<uuid>   — click from email, redirects to confirmation page
 *   POST /api/nurture-unsubscribe?id=<uuid>   — RFC 8058 List-Unsubscribe-Post one-click (returns 200)
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORTAL_BASE_URL (optional)
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function optOut(env, clientId) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&deleted_at=is.null&select=id,name,email,nurture_opted_out_at`,
    {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ nurture_opted_out_at: new Date().toISOString() }),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    return { ok: false, error: errText };
  }
  const rows = await resp.json();
  if (!rows || rows.length === 0) return { ok: false, error: 'Client not found' };
  return { ok: true, client: rows[0] };
}

export async function onRequestGet({ request, env }) {
  const baseUrl = (env.PORTAL_BASE_URL || 'https://portal-baysidepavers.com').replace(/\/$/, '');
  const url = new URL(request.url);
  const clientId = (url.searchParams.get('id') || '').trim();

  if (!UUID_RE.test(clientId)) {
    return Response.redirect(`${baseUrl}/unsubscribed.html?status=invalid`, 302);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.redirect(`${baseUrl}/unsubscribed.html?status=error`, 302);
  }

  const result = await optOut(env, clientId);
  const status = result.ok ? 'ok' : 'error';
  const nameParam = result.ok && result.client.name
    ? `&name=${encodeURIComponent(result.client.name.split(/\s+/)[0])}`
    : '';
  return Response.redirect(`${baseUrl}/unsubscribed.html?status=${status}${nameParam}`, 302);
}

export async function onRequestPost({ request, env }) {
  // RFC 8058 one-click unsubscribe: server expects 200 OK after opt-out
  const url = new URL(request.url);
  const clientId = (url.searchParams.get('id') || '').trim();

  if (!UUID_RE.test(clientId)) {
    return new Response('Invalid id', { status: 400 });
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response('Config missing', { status: 500 });
  }

  const result = await optOut(env, clientId);
  if (!result.ok) {
    return new Response('Opt-out failed', { status: 500 });
  }
  return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
}
