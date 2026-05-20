/**
 * BPB Sprint 26 — /api/products
 *
 * GET /api/products            → full product library (get_product_library RPC)
 * GET /api/products?id=<uuid>  → single material detail (get_material_details RPC)
 *
 * Public endpoint, no auth required.
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

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Supabase config missing' }, 500);
  }

  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();

  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return jsonResponse({ error: 'Invalid id (must be UUID)' }, 400);
  }

  const rpcName = id ? 'get_material_details' : 'get_product_library';
  const body    = id ? JSON.stringify({ p_material_id: id }) : '{}';

  const rpcResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!rpcResp.ok) {
    const detail = await rpcResp.text();
    return jsonResponse({ error: 'RPC failed', detail }, rpcResp.status);
  }

  const data = await rpcResp.json();
  return jsonResponse(id ? { detail: data } : { products: data });
}
