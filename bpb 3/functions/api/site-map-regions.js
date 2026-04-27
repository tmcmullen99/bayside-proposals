/**
 * BPB Phase 1A — Site Map Regions CRUD (extended for Phase 1B.3 multi-material)
 *
 * GET    /api/site-map-regions?proposal_id=...    → regions + backdrop + sections + materials
 * POST   /api/site-map-regions                    → bulk upsert regions + reconcile region-material join
 * DELETE /api/site-map-regions?id=...             → delete one region
 *
 * The POST endpoint is "bulk upsert" — the admin UI sends the entire current
 * set of regions on Save, and the endpoint reconciles by:
 *   1. Updating any region that has an existing id
 *   2. Inserting any region that has no id (new polygons drawn this session)
 *   3. Deleting any region whose id was in the DB but not in the incoming list
 *   4. [Phase 1B.3] For all upserted regions, atomically replace the rows in
 *      proposal_region_materials so the join reflects the new picker state.
 *      Deleted regions don't need explicit join cleanup — ON DELETE CASCADE
 *      on proposal_region_materials.region_id drops their rows automatically.
 *
 * This matches how the admin UI thinks: "save what's on screen". Per
 * Principle 2 (simplicity), we don't track per-region dirty state client-side.
 *
 * Phase 1B.3 changes:
 *   • GET response now includes:
 *       - materials: proposal_materials joined with belgard / third-party catalog
 *         rows so the labeling tool can render the per-region material picker
 *         without a second round-trip.
 *       - each region in `regions` carries a `materials: [{proposal_material_id,
 *         display_order}]` array reflecting its current join-table assignments.
 *   • POST body's per-region object accepts an optional `materials` array of
 *     the same shape; after region inserts/updates settle (and we have stable
 *     IDs), the join rows for those regions are replaced atomically.
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
  // Phase 1B.3: materials is optional. If present, must be an array of
  // { proposal_material_id: uuid string, display_order?: number }.
  if (r.materials != null) {
    if (!Array.isArray(r.materials)) {
      return { ok: false, error: 'Region.materials must be an array' };
    }
    for (const m of r.materials) {
      if (!m || typeof m.proposal_material_id !== 'string' || m.proposal_material_id.trim() === '') {
        return { ok: false, error: 'Region.materials entry needs a proposal_material_id (string)' };
      }
      if (m.display_order != null && typeof m.display_order !== 'number') {
        return { ok: false, error: 'Region.materials entry display_order must be a number if set' };
      }
    }
  }
  return { ok: true };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// =============================================================================
// GET — list regions + per-region material assignments + proposal-level
// materials list (with catalog joins) + sections + backdrop
// =============================================================================
export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const proposalId = url.searchParams.get('proposal_id');
  if (!proposalId) {
    return jsonResponse({ error: 'Missing proposal_id query param' }, 400);
  }

  const headers = {
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  };

  // Regions with embedded join-table rows. PostgREST follows the FK on
  // proposal_region_materials.region_id and exposes the rows under the alias
  // `materials` we declare here. We sort them by display_order in JS below
  // because PostgREST embedded ordering syntax is awkward.
  const regionsResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_regions`
      + `?proposal_id=eq.${proposalId}`
      + `&select=*,materials:proposal_region_materials(proposal_material_id,display_order)`
      + `&order=display_order.asc`,
    { headers }
  );
  if (!regionsResp.ok) {
    const errText = await regionsResp.text();
    return jsonResponse({ error: 'DB read failed (regions)', detail: errText }, 502);
  }
  const regions = await regionsResp.json();
  for (const r of regions) {
    if (Array.isArray(r.materials)) {
      r.materials.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    } else {
      r.materials = [];
    }
  }

  // Backdrop info — single row from proposals
  const propResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposals`
      + `?id=eq.${proposalId}`
      + `&select=site_plan_backdrop_url,site_plan_backdrop_width,site_plan_backdrop_height`,
    { headers }
  );
  if (!propResp.ok) {
    const errText = await propResp.text();
    return jsonResponse({ error: 'DB read failed (proposal)', detail: errText }, 502);
  }
  const proposalArr = await propResp.json();
  const backdrop = proposalArr[0] || null;

  // Phase 1B — bid sections (powers per-region Section dropdown)
  const sectionsResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_sections`
      + `?proposal_id=eq.${proposalId}`
      + `&select=id,name,display_order`
      + `&order=display_order.asc`,
    { headers }
  );
  if (!sectionsResp.ok) {
    const errText = await sectionsResp.text();
    return jsonResponse({ error: 'DB read failed (sections)', detail: errText }, 502);
  }
  const sections = await sectionsResp.json();

  // Phase 1B.3 — proposal_materials with embedded catalog rows (Belgard or
  // third-party) for the picker. We only request the catalog fields the
  // labeling tool actually renders, to keep the response small.
  const materialsResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_materials`
      + `?proposal_id=eq.${proposalId}`
      + `&select=`
      + `id,material_source,application_area,proposal_section_id,display_order,`
      + `belgard_material:belgard_material_id(id,product_name,color,pattern,swatch_url,primary_image_url),`
      + `third_party_material:third_party_material_id(id,product_name,manufacturer,color,primary_image_url,image_url)`
      + `&order=display_order.asc`,
    { headers }
  );
  if (!materialsResp.ok) {
    const errText = await materialsResp.text();
    return jsonResponse({ error: 'DB read failed (materials)', detail: errText }, 502);
  }
  const materials = await materialsResp.json();

  return jsonResponse({ regions, backdrop, sections, materials });
}

// =============================================================================
// POST — bulk upsert regions for one proposal, then reconcile region-material join
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

  // 1) Read existing region ids for this proposal
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

  // 2) Split incoming regions into to-insert / to-update.
  //    Track the materials side-data separately, indexed in parallel arrays
  //    so we can map back to stable region IDs after step 5 returns.
  const toInsert = [];        // rows for INSERT
  const toUpdate = [];        // rows for PATCH (each has .id)
  const incomingIds = new Set();
  const insertMaterials = []; // index aligned with toInsert
  const updateMaterials = {}; // keyed by region.id

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const mats = Array.isArray(r.materials) ? r.materials : [];
    const row = {
      proposal_id,
      name: r.name.trim(),
      display_order: typeof r.display_order === 'number' ? r.display_order : i,
      polygon: r.polygon,
      area_sqft: r.area_sqft ?? null,
      area_lnft: r.area_lnft ?? null,
      // legacy single-FK column kept on the row schema but never set by Phase 1B.3
      // — the join table is authoritative now.
      proposal_material_id: r.proposal_material_id ?? null,
      proposal_section_id: r.proposal_section_id ?? null,
    };
    if (r.id && existingIds.has(r.id)) {
      toUpdate.push({ id: r.id, ...row });
      updateMaterials[r.id] = mats;
      incomingIds.add(r.id);
    } else {
      toInsert.push(row);
      insertMaterials.push(mats);
    }
  }

  // 3) Delete any region not in the incoming set. CASCADE on the
  //    proposal_region_materials.region_id FK drops their join rows too.
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

  // 5) Insert new rows (single batched POST), get IDs back via Prefer
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

  // 6) [Phase 1B.3] Reconcile proposal_region_materials.
  //    For every region we just upserted (updates + inserts), delete its
  //    existing join rows in one batched IN(...) call, then INSERT the new
  //    set with explicit display_order. Deleted regions had their join rows
  //    dropped by CASCADE in step 3 — nothing to do for them here.
  const upsertedRegionIds = [];
  const newJoinRows = [];

  for (const u of toUpdate) {
    upsertedRegionIds.push(u.id);
    const mats = updateMaterials[u.id] || [];
    mats.forEach((m, j) => {
      newJoinRows.push({
        region_id: u.id,
        proposal_material_id: m.proposal_material_id,
        display_order: typeof m.display_order === 'number' ? m.display_order : j,
      });
    });
  }
  for (let i = 0; i < inserted.length; i++) {
    const regionId = inserted[i].id;
    upsertedRegionIds.push(regionId);
    const mats = insertMaterials[i] || [];
    mats.forEach((m, j) => {
      newJoinRows.push({
        region_id: regionId,
        proposal_material_id: m.proposal_material_id,
        display_order: typeof m.display_order === 'number' ? m.display_order : j,
      });
    });
  }

  if (upsertedRegionIds.length > 0) {
    const idList = upsertedRegionIds.map((id) => `"${id}"`).join(',');
    const delJoinResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/proposal_region_materials?region_id=in.(${idList})`,
      { method: 'DELETE', headers }
    );
    if (!delJoinResp.ok) {
      const errText = await delJoinResp.text();
      return jsonResponse({ error: 'DB delete failed (region_materials)', detail: errText }, 502);
    }
  }

  if (newJoinRows.length > 0) {
    const insJoinResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/proposal_region_materials`,
      { method: 'POST', headers, body: JSON.stringify(newJoinRows) }
    );
    if (!insJoinResp.ok) {
      const errText = await insJoinResp.text();
      return jsonResponse({ error: 'DB insert failed (region_materials)', detail: errText }, 502);
    }
  }

  // 7) Return final state — re-read regions with embedded materials so the
  //    client gets the same shape as GET (no need for a separate refetch
  //    on the labeling tool side).
  const finalResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_regions`
      + `?proposal_id=eq.${proposal_id}`
      + `&select=*,materials:proposal_region_materials(proposal_material_id,display_order)`
      + `&order=display_order.asc`,
    { headers }
  );
  const finalRegions = await finalResp.json();
  for (const r of finalRegions) {
    if (Array.isArray(r.materials)) {
      r.materials.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    } else {
      r.materials = [];
    }
  }

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
// DELETE — single region by id (CASCADE drops its join rows too)
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
