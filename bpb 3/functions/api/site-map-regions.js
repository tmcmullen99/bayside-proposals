/**
 * BPB Phase 1A — Site Map Regions CRUD
 *
 * GET    /api/site-map-regions?proposal_id=...    → list regions for proposal
 * POST   /api/site-map-regions                    → bulk upsert (replaces all regions for a proposal)
 * DELETE /api/site-map-regions?id=...             → delete one region
 *
 * The POST endpoint is "bulk upsert" — the admin UI sends the entire current
 * set of regions on Save, and the endpoint reconciles by:
 *   1. Updating any region that has an existing id
 *   2. Inserting any region that has no id (new polygons drawn this session)
 *   3. Deleting any region whose id was in the DB but not in the incoming list
 *
 * This matches how the admin UI thinks: "save what's on screen". Per
 * Principle 2 (simplicity), we don't track per-region dirty state client-side.
 *
 * Auth: This endpoint is open (no JWT check) — it matches the existing pattern
 * used by every other BPB admin page (materials, belgard-sync, etc.). The
 * security boundary is the CF Function holding the service role key, not user
 * auth. Re-add a JWT check here if/when team members and a real sign-in flow
 * land.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Validate a single region payload from the client.
 * Returns { ok: true } or { ok: false, error: string }
 */
function validateRegion(r) {
  if (!r || typeof r !== 'object') return { ok: false, error: 'Region must be an object' };
  if (typeof r.name !== 'string' || r.name.trim() === '') {
    return { ok: false, error: 'Region.name is required' };
  }
  if (!Array.isArray(r.polygon) || r.polygon.length < 3) {
    return { ok: false, error: 'Region.polygon must have at least 3 vertices' };
  }
  for (const pt of r.polygon) {
    if (
      !pt ||
      typeof pt.x !== 'number' ||
      typeof pt.y !== 'number' ||
      pt.x < 0 ||
      pt.x > 1 ||
      pt.y < 0 ||
      pt.y > 1
    ) {
      return { ok: false, error: 'Polygon vertices must be {x,y} with 0<=value<=1' };
    }
  }
  // area_sqft / area_lnft optional, but if provided must be numbers >= 0
  if (r.area_sqft != null && (typeof r.area_sqft !== 'number' || r.area_sqft < 0)) {
    return { ok: false, error: 'area_sqft must be a non-negative number' };
  }
  if (r.area_lnft != null && (typeof r.area_lnft !== 'number' || r.area_lnft < 0)) {
    return { ok: false, error: 'area_lnft must be a non-negative number' };
  }
  return { ok: true };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// =============================================================================
// GET — list regions for one proposal
// =============================================================================
export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const proposalId = url.searchParams.get('proposal_id');
  if (!proposalId) {
    return jsonResponse({ error: 'Missing proposal_id query param' }, 400);
  }

  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_regions?proposal_id=eq.${proposalId}&order=display_order.asc`,
    {
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      },
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    return jsonResponse({ error: 'DB read failed', detail: errText }, 502);
  }
  const regions = await resp.json();

  // Also fetch the proposal's backdrop info so the UI has it in one round-trip
  const propResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposals?id=eq.${proposalId}&select=site_plan_backdrop_url,site_plan_backdrop_width,site_plan_backdrop_height`,
    {
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      },
    }
  );
  if (!propResp.ok) {
    const errText = await propResp.text();
    return jsonResponse({ error: 'DB read failed (proposal)', detail: errText }, 502);
  }
  const proposalArr = await propResp.json();
  const backdrop = proposalArr[0] || null;

  return jsonResponse({ regions, backdrop });
}

// =============================================================================
// POST — bulk upsert regions for one proposal
// =============================================================================
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { proposal_id, regions } = body;
  if (typeof proposal_id !== 'string') {
    return jsonResponse({ error: 'proposal_id is required' }, 400);
  }
  if (!Array.isArray(regions)) {
    return jsonResponse({ error: 'regions must be an array' }, 400);
  }

  // Validate every region before touching the DB
  for (let i = 0; i < regions.length; i++) {
    const v = validateRegion(regions[i]);
    if (!v.ok) {
      return jsonResponse({ error: `Region ${i}: ${v.error}` }, 400);
    }
  }

  const headers = {
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  // 1) Read the existing region ids for this proposal
  const existingResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_regions?proposal_id=eq.${proposal_id}&select=id`,
    { headers }
  );
  if (!existingResp.ok) {
    const errText = await existingResp.text();
    return jsonResponse({ error: 'DB read failed', detail: errText }, 502);
  }
  const existing = await existingResp.json();
  const existingIds = new Set(existing.map((r) => r.id));

  // 2) Split incoming regions into to-insert (no id) and to-update (has id)
  const toInsert = [];
  const toUpdate = [];
  const incomingIds = new Set();
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const row = {
      proposal_id,
      name: r.name.trim(),
      display_order: typeof r.display_order === 'number' ? r.display_order : i,
      polygon: r.polygon,
      area_sqft: r.area_sqft ?? null,
      area_lnft: r.area_lnft ?? null,
      proposal_material_id: r.proposal_material_id ?? null,
    };
    if (r.id && existingIds.has(r.id)) {
      toUpdate.push({ id: r.id, ...row });
      incomingIds.add(r.id);
    } else {
      toInsert.push(row);
    }
  }

  // 3) Delete any existing region not in the incoming set
  const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));
  if (toDelete.length > 0) {
    const idList = toDelete.map((id) => `"${id}"`).join(',');
    const delResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/proposal_regions?id=in.(${idList})`,
      { method: 'DELETE', headers }
    );
    if (!delResp.ok) {
      const errText = await delResp.text();
      return jsonResponse({ error: 'DB delete failed', detail: errText }, 502);
    }
  }

  // 4) Update existing rows (PATCH one by one — small list, simpler than bulk upsert)
  for (const row of toUpdate) {
    const { id, ...patch } = row;
    const updResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/proposal_regions?id=eq.${id}`,
      { method: 'PATCH', headers, body: JSON.stringify(patch) }
    );
    if (!updResp.ok) {
      const errText = await updResp.text();
      return jsonResponse({ error: 'DB update failed', detail: errText, region_id: id }, 502);
    }
  }

  // 5) Insert new rows (single batched POST)
  let inserted = [];
  if (toInsert.length > 0) {
    const insResp = await fetch(`${env.SUPABASE_URL}/rest/v1/proposal_regions`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(toInsert),
    });
    if (!insResp.ok) {
      const errText = await insResp.text();
      return jsonResponse({ error: 'DB insert failed', detail: errText }, 502);
    }
    inserted = await insResp.json();
  }

  // 6) Return the final state
  const finalResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_regions?proposal_id=eq.${proposal_id}&order=display_order.asc`,
    { headers }
  );
  const finalRegions = await finalResp.json();

  return jsonResponse({
    ok: true,
    proposal_id,
    regions: finalRegions,
    stats: {
      inserted: inserted.length,
      updated: toUpdate.length,
      deleted: toDelete.length,
    },
  });
}

// =============================================================================
// DELETE — single region by id (used if Tim wants to delete from the side panel)
// =============================================================================
export async function onRequestDelete(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return jsonResponse({ error: 'Missing id query param' }, 400);
  }

  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_regions?id=eq.${id}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      },
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    return jsonResponse({ error: 'DB delete failed', detail: errText }, 502);
  }

  return jsonResponse({ ok: true, deleted_id: id });
}
