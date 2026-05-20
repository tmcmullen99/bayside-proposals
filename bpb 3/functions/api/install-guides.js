/**
 * BPB Sprint 24 — /api/install-guides
 *
 * GET — returns the list of active install guides for the client portal.
 * Public endpoint (no auth required) — install guides are marketing-style content.
 * Proxies to Supabase RPC get_install_guides().
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=60',
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
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Supabase config missing' }, 500);
  }

  const rpcResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_install_guides`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (!rpcResp.ok) {
    const detail = await rpcResp.text();
    return jsonResponse({ error: 'RPC failed', detail }, 500);
  }

  const guides = await rpcResp.json();
  return jsonResponse({ guides });
}
