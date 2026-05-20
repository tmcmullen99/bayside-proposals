/**
 * BPB Sprint 20 — /api/admin-jot
 *
 * GET  /api/admin-jot?q=<text>   → returns up to 8 client matches by name or email
 * POST /api/admin-jot            → body { client_id, note } → saves note via admin_save_quick_note RPC
 *
 * Auth: requires a Supabase JWT in Authorization: Bearer <token>.
 *       Caller must have profiles.role IN ('master', 'designer').
 *
 * Notes:
 *   - GET uses service role (we already validated the caller is admin)
 *   - POST forwards the user's JWT to the RPC so auth.uid() inside admin_save_quick_note
 *     resolves to the actual caller (used to stamp client_notes_history.created_by)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

async function validateAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'Unauthorized — missing bearer token' };

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 500, error: 'Supabase config missing' };
  }

  const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userResp.ok) return { ok: false, status: 401, error: 'Unauthorized — invalid token' };
  const user = await userResp.json();

  const profileResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!profileResp.ok) return { ok: false, status: 500, error: 'Failed to load profile' };
  const profiles = await profileResp.json();
  const role = profiles?.[0]?.role;
  if (!role || (role !== 'master' && role !== 'designer')) {
    return { ok: false, status: 403, error: 'Forbidden — admin role required' };
  }

  return { ok: true, token, user, role };
}

export async function onRequestGet({ request, env }) {
  const auth = await validateAdmin(request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return jsonResponse({ results: [] });

  // Escape PostgREST pattern special chars: % _ , ( )
  const safe = q.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
  const pattern = '*' + safe + '*';
  const encoded = encodeURIComponent(pattern);

  const searchUrl = `${env.SUPABASE_URL}/rest/v1/clients?select=id,name,email&deleted_at=is.null&or=(name.ilike.${encoded},email.ilike.${encoded})&order=name&limit=8`;

  const resp = await fetch(searchUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!resp.ok) {
    const detail = await resp.text();
    return jsonResponse({ error: 'Client search failed', detail }, 500);
  }
  const rows = await resp.json();
  return jsonResponse({ results: rows });
}

export async function onRequestPost({ request, env }) {
  const auth = await validateAdmin(request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const clientId = body?.client_id;
  const note     = (body?.note || '').trim();

  if (!clientId || typeof clientId !== 'string') {
    return jsonResponse({ error: 'client_id required' }, 400);
  }
  if (!note) {
    return jsonResponse({ error: 'note required' }, 400);
  }
  if (note.length > 10000) {
    return jsonResponse({ error: 'Note too long (max 10000 chars)' }, 400);
  }

  // Forward the user's JWT so auth.uid() in the RPC resolves to the caller
  const rpcResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_save_quick_note`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_client_id: clientId, p_note: note }),
  });

  const rpcBody = await rpcResp.text();
  let parsed;
  try { parsed = JSON.parse(rpcBody); } catch { parsed = { raw: rpcBody }; }

  if (!rpcResp.ok) {
    return jsonResponse({ error: 'Save failed', detail: parsed }, rpcResp.status);
  }
  return jsonResponse(parsed);
}
