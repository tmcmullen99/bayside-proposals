// ═══════════════════════════════════════════════════════════════════════════
// /js/engagement-utils.js — Phase 5D
//
// Shared engagement query helpers. Used by:
//   - /admin/engagement.html (per-proposal deep-dive view)
//   - /admin/clients.html (engagement chip on each assigned proposal)
//   - /dashboard.html (engagement column on the proposals table)
//
// Design: read directly from proposal_events via the supabase client. RLS on
// the table (Phase 5C migration) already restricts SELECT to designer/master
// roles, so direct queries are safe. We aggregate in JS rather than via
// Postgres aggregates because (a) volumes are tiny right now, (b) it avoids
// adding RPC functions, and (c) a single query for many proposals is cheap.
//
// When event volume crosses ~100K/proposal we'll move to a materialized view
// or RPC. Today's premature.
//
// All functions return null/empty on error and log to console; callers should
// degrade gracefully (empty chips, dashes in cells, etc.).
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

const LIVE_WINDOW_MS = 60_000; // events in last 60s = "viewing now"
const MOBILE_BREAKPOINT_PX = 768;

// ─── Bulk summary for many proposals at once ──────────────────────────────
// Returns Map<proposalId, summary>. Always returns a Map for every input id
// (with zero-event summary if no data) so callers don't need null-checks.
//
// Summary shape:
//   {
//     totalEvents,
//     sessions,         // count of distinct session_ids
//     firstView,        // ISO string or null
//     lastView,         // ISO string or null
//     mobileEvents,     // events with viewport_w < 768
//     desktopEvents,    // events with viewport_w >= 768
//     mobilePercent,    // 0–100, of (mobile + desktop)
//     isLive,           // true if any event in last 60s
//   }
export async function getProposalEngagementBulk(proposalIds) {
  const result = new Map();
  if (!proposalIds || proposalIds.length === 0) return result;

  // Pre-fill with empty summaries so every requested id gets a value.
  for (const id of proposalIds) result.set(id, emptySummary());

  const { data, error } = await supabase
    .from('proposal_events')
    .select('proposal_id, session_id, occurred_at, viewport_w')
    .in('proposal_id', proposalIds);

  if (error) {
    console.error('[engagement-utils] bulk fetch failed:', error);
    return result;
  }

  const liveCutoff = Date.now() - LIVE_WINDOW_MS;

  for (const e of (data || [])) {
    const acc = result.get(e.proposal_id);
    if (!acc) continue; // proposal_id not in our requested set

    acc.totalEvents++;
    if (e.session_id) acc._sessions.add(e.session_id);

    const t = new Date(e.occurred_at).getTime();
    if (!Number.isFinite(t)) continue;

    if (acc._firstMs === null || t < acc._firstMs) acc._firstMs = t;
    if (acc._lastMs === null || t > acc._lastMs) acc._lastMs = t;
    if (t > liveCutoff) acc.isLive = true;

    if (typeof e.viewport_w === 'number' && e.viewport_w > 0) {
      if (e.viewport_w < MOBILE_BREAKPOINT_PX) acc.mobileEvents++;
      else acc.desktopEvents++;
    }
  }

  // Finalize: collapse internal accumulators into clean output.
  for (const acc of result.values()) {
    acc.sessions = acc._sessions.size;
    acc.firstView = acc._firstMs ? new Date(acc._firstMs).toISOString() : null;
    acc.lastView = acc._lastMs ? new Date(acc._lastMs).toISOString() : null;
    const totalDeviced = acc.mobileEvents + acc.desktopEvents;
    acc.mobilePercent = totalDeviced > 0
      ? Math.round((acc.mobileEvents / totalDeviced) * 100)
      : 0;
    delete acc._sessions;
    delete acc._firstMs;
    delete acc._lastMs;
  }

  return result;
}

export async function getProposalEngagement(proposalId) {
  const map = await getProposalEngagementBulk([proposalId]);
  return map.get(proposalId) || emptySummary(true);
}

// ─── Per-session detail (used by engagement.html sessions table) ──────────
export async function getProposalSessions(proposalId) {
  if (!proposalId) return [];

  const { data, error } = await supabase
    .from('proposal_events')
    .select('session_id, occurred_at, viewport_w, viewport_h, user_agent, client_id')
    .eq('proposal_id', proposalId)
    .order('occurred_at', { ascending: true });

  if (error) {
    console.error('[engagement-utils] sessions fetch failed:', error);
    return [];
  }

  const sessions = new Map();
  for (const e of (data || [])) {
    if (!e.session_id) continue;
    if (!sessions.has(e.session_id)) {
      sessions.set(e.session_id, {
        session_id: e.session_id,
        first_seen: e.occurred_at,
        last_seen: e.occurred_at,
        event_count: 0,
        viewport_w: e.viewport_w || null,
        viewport_h: e.viewport_h || null,
        user_agent: e.user_agent || null,
        client_id: e.client_id || null,
      });
    }
    const s = sessions.get(e.session_id);
    s.event_count++;
    s.last_seen = e.occurred_at;
    // If viewport changed mid-session (resize, rotation), keep the latest.
    if (e.viewport_w) s.viewport_w = e.viewport_w;
    if (e.viewport_h) s.viewport_h = e.viewport_h;
    if (e.user_agent) s.user_agent = e.user_agent;
  }

  return Array.from(sessions.values()).sort(
    (a, b) => new Date(b.last_seen) - new Date(a.last_seen)
  );
}

// ─── Recent events for the timeline (used by engagement.html) ─────────────
export async function getProposalRecentEvents(proposalId, limit = 200) {
  if (!proposalId) return [];

  const { data, error } = await supabase
    .from('proposal_events')
    .select('id, event_type, occurred_at, session_id, viewport_w, payload')
    .eq('proposal_id', proposalId)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[engagement-utils] recent events fetch failed:', error);
    return [];
  }

  return data || [];
}

// ─── Formatters used across all surfaces ─────────────────────────────────
export function formatRelativeTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return 'just now'; // future timestamps shouldn't happen but be tolerant
  if (diff < 60_000) return Math.max(1, Math.floor(diff / 1000)) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  if (diff < 604_800_000) return Math.floor(diff / 86_400_000) + 'd ago';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function isMobileViewport(viewportW) {
  return typeof viewportW === 'number' && viewportW > 0 && viewportW < MOBILE_BREAKPOINT_PX;
}

export function deviceIcon(viewportW) {
  return isMobileViewport(viewportW) ? '📱' : '💻';
}

export function deviceLabel(viewportW) {
  return isMobileViewport(viewportW) ? 'Mobile' : 'Desktop';
}

// ─── Internal ─────────────────────────────────────────────────────────────
function emptySummary(finalized = false) {
  const base = {
    totalEvents: 0,
    sessions: 0,
    firstView: null,
    lastView: null,
    mobileEvents: 0,
    desktopEvents: 0,
    mobilePercent: 0,
    isLive: false,
  };
  if (finalized) return base;
  // The bulk path uses internal accumulators; finalize() collapses them.
  return Object.assign(base, {
    _sessions: new Set(),
    _firstMs: null,
    _lastMs: null,
  });
}
