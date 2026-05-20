/**
 * BPB Sprint 8 — /api/admin-conversations
 *
 * Returns the JSONB blob from public.admin_conversations_state() RPC:
 *   { generated_at, threads: [{client_id, client_name, last_message, unread_count, ...}] }
 *
 * Used by the Conversations admin page's left-pane thread list. Same auth pattern
 * as /api/admin-inbox — no API-layer auth, RPC restricted to service_role.
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('admin-conversations: SUPABASE config missing');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/rpc/admin_conversations_state`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('admin_conversations_state RPC failed:', resp.status, errText);
      return jsonResponse({ error: 'Database query failed', detail: errText }, 500);
    }

    const data = await resp.json();
    return jsonResponse(data);
  } catch (e) {
    console.error('admin-conversations handler error:', e);
    return jsonResponse({ error: 'Internal error', detail: String(e) }, 500);
  }
}
