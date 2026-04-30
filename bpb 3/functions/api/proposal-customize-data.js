// ═══════════════════════════════════════════════════════════════════════════
// /api/proposal-customize-data?slug={slug}
//
// Phase 4.1 Sprint B2: returns the data the customization overlay needs to
// wire swap UI on top of the static snapshot:
//   1. Verifies the caller is the homeowner who owns this proposal
//      (via client_proposals.client_id → clients.user_id == JWT.sub).
//   2. Returns the proposal's region+material join rows with real DB IDs
//      that the overlay matches against snapshot DOM elements.
//   3. Returns swap candidates from `materials` catalog grouped by the
//      categories actually present in this proposal — so a pavers row
//      only shows pavers options, decking only shows decking, etc.
//
// Uses service_role with explicit ownership check rather than RLS pass-
// through — matches the pattern in send-referral-invite.js.
// ═══════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: 'Server not configured' }, 500);
  }

  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return json({ error: 'slug query param required' }, 400);

  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return json({ error: 'Missing auth token' }, 401);

  // Verify the caller is a real Supabase user
  const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'Authorization': 'Bearer ' + token, 'apikey': SERVICE_ROLE },
  });
  if (!userResp.ok) return json({ error: 'Invalid auth token' }, 401);
  const callerUser = await userResp.json();
  if (!callerUser || !callerUser.id) return json({ error: 'Invalid auth token' }, 401);

  const sb = (path) =>
    fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE },
    });

  // Resolve slug → proposal_id
  const ppResp = await sb(
    'published_proposals?slug=eq.' + encodeURIComponent(slug) +
    '&select=id,proposal_id&limit=1'
  );
  if (!ppResp.ok) return json({ error: 'Slug lookup failed' }, 502);
  const ppRows = await ppResp.json();
  if (!ppRows.length) return json({ error: 'Proposal not found' }, 404);
  const published_proposal_id = ppRows[0].id;
  const proposal_id = ppRows[0].proposal_id;

  // Ownership check via client_proposals → clients.user_id
  const cpResp = await sb(
    'client_proposals?proposal_id=eq.' + encodeURIComponent(proposal_id) +
    '&select=client:clients(id,name,user_id)&limit=20'
  );
  if (!cpResp.ok) return json({ error: 'Ownership lookup failed' }, 502);
  const cpRows = await cpResp.json();
  const matchedRow = cpRows.find((r) => r.client && r.client.user_id === callerUser.id);
  if (!matchedRow) return json({ error: 'Not your proposal' }, 403);
  const client = matchedRow.client;

  // Proposal info (project_address)
  const pResp = await sb(
    'proposals?id=eq.' + encodeURIComponent(proposal_id) +
    '&select=id,project_address,project_city'
  );
  const pRows = pResp.ok ? await pResp.json() : [];
  const proposal = pRows[0] || { id: proposal_id };

  // Restrict to this proposal's region IDs
  const regionIdsResp = await sb(
    'proposal_regions?proposal_id=eq.' + encodeURIComponent(proposal_id) +
    '&select=id'
  );
  const validRegionIds = new Set(
    regionIdsResp.ok ? (await regionIdsResp.json()).map((r) => r.id) : []
  );
  if (validRegionIds.size === 0) {
    return json({
      client: { id: client.id, name: client.name },
      proposal: { id: proposal.id, project_address: proposal.project_address || null, project_city: proposal.project_city || null },
      published_proposal_id,
      region_materials: [],
      swap_candidates_by_category: {},
    });
  }

  // Region+material join rows
  const select =
    'id,region_id,display_order,' +
    'region:proposal_regions(id,name,display_order),' +
    'proposal_material:proposal_materials(' +
      'id,material_source,material_id,override_product_name,override_color,' +
      'material:materials(id,product_name,color,manufacturer,category,swatch_url,primary_image_url),' +
      'belgard_material:belgard_materials(id,product_name,color,swatch_url,primary_image_url),' +
      'third_party_material:third_party_materials(id,product_name,color,manufacturer,primary_image_url,image_url,category)' +
    ')';

  const inList = Array.from(validRegionIds).map((id) => '"' + id + '"').join(',');
  const prmResp = await sb(
    'proposal_region_materials' +
    '?region_id=in.(' + inList + ')' +
    '&select=' + encodeURIComponent(select) +
    '&order=display_order.asc'
  );
  if (!prmResp.ok) {
    return json({ error: 'Region material lookup failed: ' + (await prmResp.text()).slice(0, 200) }, 502);
  }
  const prmRows = await prmResp.json();

  const region_materials = prmRows
    .filter((r) => r.region && r.proposal_material)
    .map((r) => {
      const pm = r.proposal_material;
      const src = pm.material || pm.belgard_material || pm.third_party_material;
      if (!src) return null;
      const category = (pm.material && pm.material.category)
                    || (pm.third_party_material && pm.third_party_material.category)
                    || null;
      return {
        id: r.id,                                  // proposal_region_material_id (substitution target)
        region_id: r.region_id,
        region_name: r.region.name,
        display_order: r.display_order,
        current: {
          proposal_material_id: pm.id,
          material_id: pm.material_id,
          product_name: pm.override_product_name || src.product_name || null,
          color: pm.override_color || src.color || null,
          manufacturer: src.manufacturer || (pm.belgard_material ? 'Belgard' : null),
          swatch_url: src.swatch_url || src.primary_image_url || src.image_url || null,
          category,
        },
      };
    })
    .filter(Boolean);

  // Build swap candidates by category — only categories actually present
  const categoriesPresent = Array.from(new Set(
    region_materials.map((r) => r.current.category).filter(Boolean)
  ));

  let swap_candidates_by_category = {};
  if (categoriesPresent.length > 0) {
    const catInList = categoriesPresent.map((c) => '"' + c.replace(/"/g, '\\"') + '"').join(',');
    const candResp = await sb(
      'materials?category=in.(' + catInList + ')' +
      '&select=id,product_name,color,manufacturer,category,swatch_url,primary_image_url' +
      '&order=product_name.asc'
    );
    if (candResp.ok) {
      const allCands = await candResp.json();
      categoriesPresent.forEach((cat) => {
        swap_candidates_by_category[cat] = allCands
          .filter((m) => m.category === cat)
          .map((m) => ({
            id: m.id,
            product_name: m.product_name,
            color: m.color,
            manufacturer: m.manufacturer,
            category: m.category,
            swatch_url: m.swatch_url || m.primary_image_url || null,
          }));
      });
    }
  }

  return json({
    client: { id: client.id, name: client.name },
    proposal: { id: proposal.id, project_address: proposal.project_address || null, project_city: proposal.project_city || null },
    published_proposal_id,
    region_materials,
    swap_candidates_by_category,
  });
}
