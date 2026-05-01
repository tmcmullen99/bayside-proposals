// ═══════════════════════════════════════════════════════════════════════════
// /api/site-map-scale  —  Phase 6 Sprint 1 (Cam To Plan import)
//
// Persists the pixels-per-foot calibration for a proposal's backdrop image.
// Kept separate from /api/site-map-regions because:
//   1. Calibration is one-shot, not bulk-iterative like region edits
//   2. Saving immediately on calibrate (rather than waiting for "Save All")
//      is a footgun guard — losing a 30-second calibration to a tab crash
//      is worse than losing region edits which take seconds to redo
//
// POST body: { proposal_id: uuid, scale: object | null }
//   scale: { pixelsPerFoot, p1Frac:{x,y}, p2Frac:{x,y}, realDistanceInches, calibratedAt }
//   scale: null   → clear calibration
//
// Auth: same pattern as /api/site-map-regions — service role bypasses RLS.
// In a production multi-designer world this would check proposals.owner_user_id
// against the caller's JWT; for current single-tenant usage the service-role
// trust matches the existing site-map endpoint behavior.
// ═══════════════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateScale(s) {
  if (s === null) return { ok: true };
  if (!s || typeof s !== 'object') return { ok: false, error: 'scale must be an object or null' };
  if (typeof s.pixelsPerFoot !== 'number' || s.pixelsPerFoot <= 0 || !Number.isFinite(s.pixelsPerFoot)) {
    return { ok: false, error: 'scale.pixelsPerFoot must be a positive finite number' };
  }
  for (const key of ['p1Frac', 'p2Frac']) {
    const p = s[key];
    if (!p || typeof p !== 'object') return { ok: false, error: `scale.${key} must be {x,y}` };
    if (typeof p.x !== 'number' || typeof p.y !== 'number') {
      return { ok: false, error: `scale.${key} x/y must be numbers` };
    }
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
      return { ok: false, error: `scale.${key} x/y must be in [0,1]` };
    }
  }
  if (typeof s.realDistanceInches !== 'number' || s.realDistanceInches <= 0 || !Number.isFinite(s.realDistanceInches)) {
    return { ok: false, error: 'scale.realDistanceInches must be a positive finite number' };
  }
  if (typeof s.calibratedAt !== 'string' || isNaN(new Date(s.calibratedAt).getTime())) {
    return { ok: false, error: 'scale.calibratedAt must be a valid ISO 8601 timestamp' };
  }
  return { ok: true };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Server misconfigured — Supabase env missing' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const proposalId = String(body.proposal_id || '').trim();
  if (!UUID_RE.test(proposalId)) {
    return jsonResponse({ error: 'proposal_id must be a UUID' }, 400);
  }

  // body.scale === undefined is treated as "no change requested" — reject.
  // body.scale === null is "clear the scale" — allowed.
  if (!('scale' in body)) {
    return jsonResponse({ error: 'scale field is required (use null to clear)' }, 400);
  }
  const scale = body.scale;
  const v = validateScale(scale);
  if (!v.ok) return jsonResponse({ error: v.error }, 400);

  const headers = {
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  const patchResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposals?id=eq.${proposalId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ site_plan_scale: scale }),
    }
  );
  if (!patchResp.ok) {
    const errText = await patchResp.text();
    return jsonResponse({ error: 'DB update failed', detail: errText }, 502);
  }

  return jsonResponse({ ok: true, proposal_id: proposalId, scale });
}
