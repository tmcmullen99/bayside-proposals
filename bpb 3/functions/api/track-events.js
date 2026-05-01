// ═══════════════════════════════════════════════════════════════════════════
// POST /api/track-events
//
// Ingest endpoint for proposal-tracker.js batched events. Validates each
// event against an allowlist, writes via service role (bypasses RLS),
// returns 204 on success.
//
// Environment variables (set in CF Pages → Settings → Environment variables):
//   SUPABASE_URL                 — same as used by /functions/p/[slug].js
//   SUPABASE_SERVICE_ROLE_KEY    — required so writes can bypass RLS
//
// Rate limiting: deferred. Volume is currently low. When justified, configure
// CF Rate Limiting rules at the platform level — free, edge-enforced, tunable
// from the dashboard, and doesn't require code changes here.
// ═══════════════════════════════════════════════════════════════════════════

const VALID_EVENT_TYPES = new Set([
  'page_view',
  'section_view',
  'bid_section_click',
  'swap_modal_open',
  'swap_save',
  'referral_share_click',
  'sign_in_cta_click',
  'quality_tab_click',
  'accept_proposal_click',
]);

const MAX_BATCH_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError(500, 'Server misconfigured — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON');
  }

  const events = Array.isArray(body && body.events) ? body.events : [];
  if (events.length === 0) {
    // Empty batch is success with nothing to do — return 204 quickly.
    return new Response(null, { status: 204 });
  }
  if (events.length > MAX_BATCH_SIZE) {
    return jsonError(400, `Batch too large (max ${MAX_BATCH_SIZE} events)`);
  }

  // Validate + normalize each event. Reject the whole batch if any single
  // event is malformed — better than silently dropping rows.
  const rows = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== 'object') {
      return jsonError(400, `Event ${i}: not an object`);
    }
    if (!VALID_EVENT_TYPES.has(e.event_type)) {
      return jsonError(400, `Event ${i}: unknown event_type "${String(e.event_type)}"`);
    }
    if (typeof e.session_id !== 'string' || !UUID_RE.test(e.session_id)) {
      return jsonError(400, `Event ${i}: invalid session_id`);
    }

    rows.push({
      event_type: e.event_type,
      proposal_id: validUuidOrNull(e.proposal_id),
      published_proposal_id: validUuidOrNull(e.published_proposal_id),
      slug: typeof e.slug === 'string' ? e.slug.slice(0, 200) : null,
      session_id: e.session_id,
      client_id: validUuidOrNull(e.client_id),
      occurred_at: parseTimestamp(e.occurred_at),
      viewport_w: clampInt(e.viewport_w, 0, 100000),
      viewport_h: clampInt(e.viewport_h, 0, 100000),
      user_agent: trimString(e.user_agent, 500),
      referrer: trimString(e.referrer, 500),
      payload: (e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload))
        ? e.payload
        : {},
    });
  }

  // Write to Supabase via service role — bypasses RLS.
  const url = `${env.SUPABASE_URL}/rest/v1/proposal_events`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
  } catch (err) {
    return jsonError(502, 'Could not reach database: ' + (err.message || String(err)));
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error('Supabase insert failed:', resp.status, detail);
    return jsonError(502, `Database returned ${resp.status}`);
  }

  return new Response(null, { status: 204 });
}

// CORS preflight — published proposals are same-origin in production, but
// keep this for local dev / preview deployments.
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validUuidOrNull(v) {
  return (typeof v === 'string' && UUID_RE.test(v)) ? v : null;
}

function trimString(v, maxLen) {
  if (typeof v !== 'string') return null;
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return Math.floor(n);
}

function parseTimestamp(v) {
  if (!v) return new Date().toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
