// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-events.js — Phase 5C
//
// Sanity-check view for the proposal_events table. NOT the analytics
// dashboard (5D will build that). Just a raw, filterable event stream so
// designers can verify the pipe works and debug edge cases.
//
// RLS already restricts SELECT on proposal_events to designers + masters,
// so direct supabase queries from the client are safe.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';

const PAGE_SIZE = 200;
const REFRESH_MS = 30000;

const ctx = {
  events: [],
  proposals: [],
  filterProposalId: '',
  filterEventType: '',
  autoRefreshTimer: null,
};

const els = {
  content: document.getElementById('evContent'),
  filterProposal: document.getElementById('evFilterProposal'),
  filterType: document.getElementById('evFilterType'),
  refreshBtn: document.getElementById('evRefreshBtn'),
  autoRefresh: document.getElementById('evAutoRefresh'),
  statToday: document.getElementById('evStatToday'),
  statWeek: document.getElementById('evStatWeek'),
  statSessions: document.getElementById('evStatSessions'),
  statProposals: document.getElementById('evStatProposals'),
};

// ─── Bootstrap ───────────────────────────────────────────────────────
(async function init() {
  if (!await requireDesigner()) return;

  await Promise.all([loadProposals(), loadEvents(), loadStats()]);

  els.filterProposal.addEventListener('change', onFilterChange);
  els.filterType.addEventListener('change', onFilterChange);
  els.refreshBtn.addEventListener('click', () => {
    loadEvents();
    loadStats();
  });
  els.autoRefresh.addEventListener('change', toggleAutoRefresh);
  toggleAutoRefresh();
})();

// ─── Data loaders ────────────────────────────────────────────────────
async function loadProposals() {
  // Build the proposal filter dropdown from proposals that have at least
  // one event recently. Skipping empty proposals keeps the list short.
  const { data, error } = await supabase
    .from('proposal_events')
    .select('proposal_id, slug')
    .not('proposal_id', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Could not load proposal filter list:', error);
    return;
  }

  // Dedupe on proposal_id, keep first slug seen per proposal.
  const seen = new Map();
  for (const row of (data || [])) {
    if (!seen.has(row.proposal_id)) {
      seen.set(row.proposal_id, row.slug || row.proposal_id);
    }
  }

  ctx.proposals = Array.from(seen.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  els.filterProposal.innerHTML =
    '<option value="">All proposals</option>' +
    ctx.proposals.map(p =>
      `<option value="${escapeAttr(p.id)}">${escapeHtml(p.label)}</option>`
    ).join('');
}

async function loadEvents() {
  els.content.innerHTML =
    '<div class="ev-loading"><span class="ev-spinner"></span>Loading events…</div>';

  let q = supabase
    .from('proposal_events')
    .select('id, event_type, proposal_id, slug, session_id, client_id, occurred_at, viewport_w, viewport_h, payload')
    .order('occurred_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (ctx.filterProposalId) q = q.eq('proposal_id', ctx.filterProposalId);
  if (ctx.filterEventType) q = q.eq('event_type', ctx.filterEventType);

  const { data, error } = await q;

  if (error) {
    els.content.innerHTML =
      '<div class="ev-empty" style="color:#b04040;">Could not load events: '
      + escapeHtml(error.message) + '</div>';
    return;
  }

  ctx.events = data || [];
  renderEvents();
}

async function loadStats() {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [todayCount, weekCount, sessionsToday, propsTraffic] = await Promise.all([
    supabase.from('proposal_events')
      .select('id', { count: 'exact', head: true })
      .gte('occurred_at', dayAgo),
    supabase.from('proposal_events')
      .select('id', { count: 'exact', head: true })
      .gte('occurred_at', weekAgo),
    supabase.from('proposal_events')
      .select('session_id')
      .gte('occurred_at', dayAgo),
    supabase.from('proposal_events')
      .select('proposal_id')
      .not('proposal_id', 'is', null)
      .gte('occurred_at', weekAgo),
  ]);

  els.statToday.textContent = formatCount(todayCount.count);
  els.statWeek.textContent = formatCount(weekCount.count);

  const sessions = new Set((sessionsToday.data || []).map(r => r.session_id));
  els.statSessions.textContent = formatCount(sessions.size);

  const props = new Set((propsTraffic.data || []).map(r => r.proposal_id));
  els.statProposals.textContent = formatCount(props.size);
}

function formatCount(n) {
  if (n == null) return '?';
  return Number(n).toLocaleString('en-US');
}

// ─── Render ──────────────────────────────────────────────────────────
function renderEvents() {
  if (ctx.events.length === 0) {
    els.content.innerHTML = `
      <div class="ev-empty">
        No events match your filters yet. Open a published proposal in another
        tab to generate some, or wait for the next homeowner view.
      </div>
    `;
    return;
  }

  els.content.innerHTML = `
    <div class="ev-table-wrap">
      <table class="ev-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            <th>Proposal / slug</th>
            <th>Session</th>
            <th>Viewport</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody>
          ${ctx.events.map(renderRow).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderRow(e) {
  const time = formatTime(e.occurred_at);
  const knownTypes = new Set([
    'page_view', 'section_view', 'swap_modal_open', 'swap_save',
    'accept_proposal_click',
  ]);
  const typeClass = knownTypes.has(e.event_type)
    ? 'ev-type-' + e.event_type
    : 'ev-type-other';

  const proposalCell = e.slug
    ? `<a href="/p/${escapeAttr(e.slug)}" target="_blank" rel="noopener">${escapeHtml(e.slug)}</a>`
    : (e.proposal_id
        ? `<span class="ev-mono">${escapeHtml(e.proposal_id.slice(0, 8))}…</span>`
        : '<span style="color:#999;">—</span>');

  const sessionCell = e.session_id
    ? `<span class="ev-mono" title="${escapeAttr(e.session_id)}">${escapeHtml(e.session_id.slice(0, 8))}…</span>`
    : '—';

  const viewport = (e.viewport_w && e.viewport_h)
    ? `${e.viewport_w}×${e.viewport_h}`
    : '—';

  const payloadStr = e.payload && Object.keys(e.payload).length > 0
    ? JSON.stringify(e.payload)
    : '—';
  const payloadDisplay = payloadStr.length > 80
    ? payloadStr.slice(0, 80) + '…'
    : payloadStr;

  return `
    <tr>
      <td><span class="ev-time">${escapeHtml(time)}</span></td>
      <td><span class="ev-type ${typeClass}">${escapeHtml(e.event_type)}</span></td>
      <td class="ev-proposal">${proposalCell}</td>
      <td>${sessionCell}</td>
      <td><span class="ev-mono">${viewport}</span></td>
      <td><span class="ev-payload">${escapeHtml(payloadDisplay)}</span></td>
    </tr>
  `;
}

function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 60000) return Math.max(0, Math.floor(diffMs / 1000)) + 's ago';
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── Controls ───────────────────────────────────────────────────────
function onFilterChange() {
  ctx.filterProposalId = els.filterProposal.value;
  ctx.filterEventType = els.filterType.value;
  loadEvents();
}

function toggleAutoRefresh() {
  if (ctx.autoRefreshTimer) {
    clearInterval(ctx.autoRefreshTimer);
    ctx.autoRefreshTimer = null;
  }
  if (els.autoRefresh.checked) {
    ctx.autoRefreshTimer = setInterval(() => {
      loadEvents();
      loadStats();
    }, REFRESH_MS);
  }
}

// ─── Utils ──────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
