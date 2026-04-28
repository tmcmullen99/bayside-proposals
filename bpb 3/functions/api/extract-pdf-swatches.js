// ═══════════════════════════════════════════════════════════════════════════
// /api/extract-pdf-swatches — Phase 3B.2 (foundation pass)
//
// SKELETON ONLY this session. The actual vision-based PDF swatch
// extraction (render PDF page → Claude vision → bounding boxes → crop →
// upload swatches → match-or-insert into belgard_materials) is built in
// the next session.
//
// What this stub does today:
//   1. Verifies caller's JWT and master role.
//   2. Validates the catalog_pdf_id exists.
//   3. Returns 501 Not Implemented with a structured payload describing
//      what this endpoint will do once finished.
//
// Why ship a stub: lets Tim deploy the foundation, confirm uploads work,
// see Belgard PCG + uploaded catalogs in the admin list, and click Extract
// without errors. Real implementation lands in the next code drop.
//
// Browser side (admin-catalog-pdfs.js) sends:
//   POST /api/extract-pdf-swatches
//   Authorization: Bearer <user_access_token>
//   { catalog_pdf_id: "<uuid>" }
//
// This session returns:
//   501 { ok: false, status: "not_implemented", catalog_pdf: {...},
//          will_implement: [...], next_session: "..." }
//
// Future sessions will return:
//   200 { ok: true, summary: { swatches_extracted, rows_updated, rows_inserted } }
// ═══════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL = env.SUPABASE_URL;
    const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { ok: false, error: 'Server not configured (missing Supabase env vars)' });
    }

    // ─── Auth: verify caller ──────────────────────────────────────────────
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json(401, { ok: false, error: 'Missing auth token' });

    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'apikey': SERVICE_ROLE,
      },
    });
    if (!userResp.ok) return json(401, { ok: false, error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) {
      return json(401, { ok: false, error: 'Invalid auth token (no user)' });
    }

    // ─── Authz: master only ───────────────────────────────────────────────
    const profileResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(callerUser.id) +
      '&select=role,is_active',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    if (!profileResp.ok) return json(403, { ok: false, error: 'Could not look up caller profile' });
    const profiles = await profileResp.json();
    const profile = Array.isArray(profiles) && profiles[0];
    if (!profile || !profile.is_active || profile.role !== 'master') {
      return json(403, { ok: false, error: 'Only master users can extract from catalogs' });
    }

    // ─── Validate input ───────────────────────────────────────────────────
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { ok: false, error: 'Invalid JSON body' });
    }
    const catalogPdfId = String(body.catalog_pdf_id || '').trim().toLowerCase();
    if (!UUID_RE.test(catalogPdfId)) {
      return json(400, { ok: false, error: 'catalog_pdf_id must be a UUID' });
    }

    // ─── Look up the catalog PDF ──────────────────────────────────────────
    const pdfResp = await fetch(
      SUPABASE_URL + '/rest/v1/catalog_pdfs?id=eq.' + encodeURIComponent(catalogPdfId) +
      '&select=id,manufacturer,pdf_name,pdf_url,storage_path,page_count,file_size_bytes',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    if (!pdfResp.ok) return json(500, { ok: false, error: 'Could not look up catalog PDF' });
    const pdfs = await pdfResp.json();
    if (!Array.isArray(pdfs) || pdfs.length === 0) {
      return json(404, { ok: false, error: 'Catalog PDF not found' });
    }
    const pdf = pdfs[0];

    // ─── Foundation pass: return 501 Not Implemented ──────────────────────
    return json(501, {
      ok: false,
      status: 'not_implemented',
      message: 'PDF swatch extraction will be built in the next session. ' +
               'This pass deploys the foundation: PDF upload, registration, listing, deletion.',
      catalog_pdf: {
        id: pdf.id,
        manufacturer: pdf.manufacturer,
        pdf_name: pdf.pdf_name,
        is_external: !pdf.storage_path,
        page_count: pdf.page_count,
        file_size_bytes: pdf.file_size_bytes,
      },
      will_implement: [
        'Render PDF page(s) to PNG using Cloudflare Image Resizing or pdf.co',
        'Send each color-grid page to Claude with vision API',
        'Receive structured swatches: name, normalized bounding box, description',
        'Crop each swatch from the rendered page image',
        'Upload cropped swatch to proposal-photos/swatches/ in Supabase Storage',
        'Match-or-insert per (product_name, color) into belgard_materials',
        'Show review-then-apply UI before writes commit',
      ],
      next_session: 'Session 2 of 3B.2 ships the real extraction.',
    });

  } catch (err) {
    return json(500, { ok: false, error: (err && err.message) || 'Unexpected server error' });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
