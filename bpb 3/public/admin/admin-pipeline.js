// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-pipeline.js — Phase 6 Sprint 3A
//
// Central pipeline dashboard. Lists every proposal the current user can see
// (master = all, designer = own via RLS) with a computed funnel stage based
// on real activity:
//
//   draft     — no published_proposals row OR proposals.status = 'draft'
//   sent      — published exists, no events, no substitutions, no redesigns
//   viewed    — has events in the last 7 days, no engaged-level activity
//   engaged   — has any submitted/reviewed substitution OR redesign request
//   cold      — has been viewed at some point, but no events in 7+ days,
//                 and not signed/completed/archived
//   resolved  — proposals.status IN ('signed','completed','archived')
//
// Reads existing tables only — no new schema. Stage is purely derived in JS
// so it's correct the moment any underlying activity changes; no triggers
// to maintain. RLS already filters proposals to designer ownership at the DB
// layer, so we never have to think about visibility here.
//
// Strategy: 5 parallel queries (proposals + published_proposals + clients
// in one nested select; events; substitutions; redesigns; client_proposals)
// then merge in JS. With ~67 published proposals the merge is sub-millisecond
// and avoids the SQL aggregation that Supabase doesn't expose well.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';

const COLD_THRESHOLD_DAYS = 7;
const COLD_THRESHOLD_MS = COLD_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

const ctx = {
  userId: null,
  rows: [],          // merged proposal rows with computed stage + counts
  filter: 'all',     // 'all' | 'active' | 'cold' | 'resolved'
  search: '',
  expandedIds: new Set(),
};

const els = {
  content:           document.getElementById('plContent'),
  search:            document.getElementById('plSearch'),
  stageTabs:         document.getElementById('plStageTabs'),
  refreshBtn:        document.getElementById('plRefreshBtn'),
  statActive:        document.getElementById('plStatActive'),
  statPendingSubs:   document.getElementById('plStatPendingSubs'),
  statPendingRedesigns: document.getElementById('plStatPendingRedesigns'),
  statViewedWeek:    document.getElementById('plStatViewedWeek'),
  statCold:          document.getElementById('plStatCold'),
};

(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.userId = auth.user.id;

  els.search.addEventListener('input', () => {
    ctx.search = els.search.value.trim().toLowerCase();
    render();
  });
  els.stageTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stage]');
    if (!btn) return;
    ctx.filter = btn.dataset.stage;
    els.stageTabs.querySelectorAll('.pl-stage-tab').forEach((b) =>
      b.classList.toggle('is-active', b === btn));
    render();
  });
  els.refreshBtn.addEventListener('click', loadAll);

  await loadAll();
})();

async function loadAll() {
  els.content.innerHTML = '<div class="pl-loading"><span class="pl-spinner"></span>Loading pipeline…</div>';

  // 5 parallel queries
  const [propsResp, eventsResp, subsResp, redesignsResp, clientPropsResp] = await Promise.all([
    supabase.from('proposals')
      .select(`
        id, address, project_address, project_city, total_amount:bid_total_amount,
        status, owner_user_id, updated_at, created_at, client_name, client_email,
        published:published_proposals!proposal_id(id, slug, published_at)
      `)
      .order('updated_at', { ascending: false }),

    // Only proposal-tied events that signal viewing intent
    supabase.from('proposal_events')
      .select('proposal_id, occurred_at, event_type')
      .not('proposal_id', 'is', null)
      .in('event_type', ['page_view', 'section_view', 'swap_modal_open', 'swap_save', 'accept_proposal_click'])
      .order('occurred_at', { ascending: false }),

    supabase.from('proposal_substitutions')
      .select('id, proposal_id, status, created_at'),

    supabase.from('proposal_redesign_requests')
      .select('id, proposal_id, status, created_at'),

    supabase.from('client_proposals')
      .select('proposal_id, sent_at, first_viewed_at, status, client:clients!client_id(name, email, phone)'),
  ]);

  if (propsResp.error) {
    showError('Could not load proposals: ' + propsResp.error.message);
    return;
  }

  const proposals = propsResp.data || [];
  const events = eventsResp.data || [];
  const subs = subsResp.data || [];
  const redesigns = redesignsResp.data || [];
  const clientProps = clientPropsResp.data || [];

  // Build lookup maps for O(n) merge
  const eventsByProposal = new Map();
  for (const e of events) {
    if (!e.proposal_id) continue;
    const cur = eventsByProposal.get(e.proposal_id) || { count: 0, lastAt: null };
    cur.count += 1;
    if (!cur.lastAt || e.occurred_at > cur.lastAt) cur.lastAt = e.occurred_at;
    eventsByProposal.set(e.proposal_id, cur);
  }

  const subsByProposal = new Map();
  for (const s of subs) {
    const cur = subsByProposal.get(s.proposal_id) || { total: 0, pending: 0, latestAt: null };
    cur.total += 1;
    if (s.status === 'submitted' || s.status === 'reviewed') cur.pending += 1;
    if (!cur.latestAt || s.created_at > cur.latestAt) cur.latestAt = s.created_at;
    subsByProposal.set(s.proposal_id, cur);
  }

  const redesignsByProposal = new Map();
  for (const r of redesigns) {
    const cur = redesignsByProposal.get(r.proposal_id) || { total: 0, pending: 0, latestAt: null };
    cur.total += 1;
    if (r.status === 'submitted' || r.status === 'reviewed') cur.pending += 1;
    if (!cur.latestAt || r.created_at > cur.latestAt) cur.latestAt = r.created_at;
    redesignsByProposal.set(r.proposal_id, cur);
  }

  const clientPropByProposal = new Map();
  for (const cp of clientProps) {
    if (!cp.proposal_id) continue;
    clientPropByProposal.set(cp.proposal_id, cp);
  }

  // Merge into pipeline rows with computed stage
  const now = Date.now();
  ctx.rows = proposals.map((p) => {
    const evt = eventsByProposal.get(p.id) || { count: 0, lastAt: null };
    const sub = subsByProposal.get(p.id) || { total: 0, pending: 0, latestAt: null };
    const red = redesignsByProposal.get(p.id) || { total: 0, pending: 0, latestAt: null };
    const cp = clientPropByProposal.get(p.id);
    const published = (p.published && p.published[0]) || null;

    // Compute "last activity" = max of event, sub, redesign, first_viewed_at
    const candidates = [evt.lastAt, sub.latestAt, red.latestAt, cp && cp.first_viewed_at]
      .filter(Boolean)
      .map((d) => new Date(d).getTime());
    const lastActivityMs = candidates.length > 0 ? Math.max(...candidates) : null;
    const lastActivityIso = lastActivityMs ? new Date(lastActivityMs).toISOString() : null;

    // Stage logic
    let stage = 'draft';
    const dbStatus = p.status || 'draft';
    if (['signed', 'completed', 'archived'].includes(dbStatus)) {
      stage = 'resolved';
    } else if (!published) {
      stage = 'draft';
    } else if (sub.total > 0 || red.total > 0) {
      stage = 'engaged';
    } else if (lastActivityMs && (now - lastActivityMs) > COLD_THRESHOLD_MS) {
      stage = 'cold';
    } else if (evt.count > 0 || (cp && cp.first_viewed_at)) {
      stage = 'viewed';
    } else {
      stage = 'sent';
    }

    return {
      id: p.id,
      address: p.address || p.project_address || 'Untitled proposal',
      city: p.project_city || '',
      clientName: (cp && cp.client && cp.client.name) || p.client_name || '',
      clientEmail: (cp && cp.client && cp.client.email) || p.client_email || '',
      total: Number(p.total_amount) || 0,
      slug: published ? published.slug : null,
      publishedAt: published ? published.published_at : null,
      sentAt: cp ? cp.sent_at : null,
      firstViewedAt: cp ? cp.first_viewed_at : null,
      eventCount: evt.count,
      subTotal: sub.total,
      subPending: sub.pending,
      redTotal: red.total,
      redPending: red.pending,
      lastActivityIso,
      stage,
      dbStatus,
      updatedAt: p.updated_at,
    };
  });

  // Sort: pending engagement first, then by recent activity
  ctx.rows.sort((a, b) => {
    const priA = stagePriority(a.stage) + (a.subPending + a.redPending > 0 ? -10 : 0);
    const priB = stagePriority(b.stage) + (b.subPending + b.redPending > 0 ? -10 : 0);
    if (priA !== priB) return priA - priB;
    const aT = a.lastActivityIso || a.updatedAt || '';
    const bT = b.lastActivityIso || b.updatedAt || '';
    return bT.localeCompare(aT);
  });

  renderStats();
  render();
}

function stagePriority(stage) {
  switch (stage) {
    case 'engaged':  return 0;
    case 'cold':     return 1;
    case 'viewed':   return 2;
    case 'sent':     return 3;
    case 'draft':    return 4;
    case 'resolved': return 5;
    default:         return 9;
  }
}

function renderStats() {
  const counts = countByStage();
  const active = counts.sent + counts.viewed + counts.engaged + counts.cold;
  const pendingSubs = ctx.rows.reduce((n, r) => n + r.subPending, 0);
  const pendingRedesigns = ctx.rows.reduce((n, r) => n + r.redPending, 0);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const viewedWeek = ctx.rows.filter((r) =>
    r.lastActivityIso && new Date(r.lastActivityIso).getTime() >= weekAgo
  ).length;

  els.statActive.textContent = active;
  els.statPendingSubs.textContent = pendingSubs;
  els.statPendingRedesigns.textContent = pendingRedesigns;
  els.statViewedWeek.textContent = viewedWeek;
  els.statCold.textContent = counts.cold;

  // Update tab counts
  const tabCounts = {
    all: ctx.rows.length,
    active: counts.sent + counts.viewed + counts.engaged,
    cold: counts.cold,
    resolved: counts.resolved + counts.draft,
  };
  Object.entries(tabCounts).forEach(([key, val]) => {
    const el = els.stageTabs.querySelector(`[data-stage-count="${key}"]`);
    if (el) el.textContent = val;
  });
}

function countByStage() {
  return ctx.rows.reduce((acc, r) => {
    acc[r.stage] = (acc[r.stage] || 0) + 1;
    return acc;
  }, { draft: 0, sent: 0, viewed: 0, engaged: 0, cold: 0, resolved: 0 });
}

function render() {
  const visible = filterRows(ctx.rows, ctx.filter, ctx.search);
  if (visible.length === 0) {
    els.content.innerHTML = renderEmpty();
    return;
  }
  els.content.innerHTML = `<div class="pl-list">${visible.map(renderRow).join('')}</div>`;
  wireRowHandlers();
}

function filterRows(rows, filter, search) {
  let out = rows;
  if (filter === 'active') {
    out = out.filter((r) => ['sent', 'viewed', 'engaged'].includes(r.stage));
  } else if (filter === 'cold') {
    out = out.filter((r) => r.stage === 'cold');
  } else if (filter === 'resolved') {
    out = out.filter((r) => ['resolved', 'draft'].includes(r.stage));
  }
  if (search) {
    out = out.filter((r) => {
      const haystack = (r.address + ' ' + r.clientName + ' ' + r.clientEmail).toLowerCase();
      return haystack.includes(search);
    });
  }
  return out;
}

function renderRow(r) {
  const isExpanded = ctx.expandedIds.has(r.id);
  const isUrgent = r.subPending > 0 || r.redPending > 0;
  const isCold = r.stage === 'cold';
  const cls = ['pl-row'];
  if (isExpanded) cls.push('is-expanded');
  if (isUrgent) cls.push('is-urgent');
  else if (isCold) cls.push('is-cold');

  return `
    <div class="${cls.join(' ')}" data-pl-id="${escapeAttr(r.id)}">
      <div class="pl-row-summary">
        <span class="pl-stage-pill pl-stage-${r.stage}">${escapeHtml(r.stage)}</span>
        <div class="pl-row-main">
          <div class="pl-row-address">${escapeHtml(r.address)}</div>
          <div class="pl-row-client">${escapeHtml(r.clientName || r.clientEmail || 'No client linked')}</div>
          <div class="pl-row-mobile-meta">${escapeHtml(formatRelative(r.lastActivityIso) || 'no activity')}${r.subPending + r.redPending > 0 ? ' · ' + (r.subPending + r.redPending) + ' pending' : ''}</div>
        </div>
        <div class="pl-row-amount">${r.total ? '$' + r.total.toLocaleString() : '—'}</div>
        <div class="pl-row-activity">
          <div class="pl-row-activity-label">Last activity</div>
          <div class="pl-row-activity-value">${escapeHtml(formatRelative(r.lastActivityIso) || '—')}</div>
        </div>
        <div class="pl-row-badges">
          ${r.eventCount > 0 ? `<span class="pl-badge pl-badge-views" title="${r.eventCount} engagement events">${r.eventCount}v</span>` : ''}
          ${r.subPending > 0 ? `<span class="pl-badge pl-badge-subs" title="${r.subPending} pending substitutions">${r.subPending}s</span>` : ''}
          ${r.redPending > 0 ? `<span class="pl-badge pl-badge-redesigns" title="${r.redPending} pending redesigns">${r.redPending}r</span>` : ''}
        </div>
        <span class="pl-row-chevron">›</span>
      </div>
      <div class="pl-row-body">
        ${renderRowBody(r)}
      </div>
    </div>
  `;
}

function renderRowBody(r) {
  const proposalLink = r.slug
    ? `<a href="/p/${escapeAttr(r.slug)}" target="_blank" rel="noopener">/p/${escapeHtml(r.slug)} ↗</a>`
    : '<span style="color:var(--muted-soft);">Not yet published</span>';
  const sentLine = r.sentAt ? formatExact(r.sentAt) : '—';
  const firstViewedLine = r.firstViewedAt ? formatExact(r.firstViewedAt) : '—';
  const lastActivityLine = r.lastActivityIso ? formatExact(r.lastActivityIso) : '—';

  return `
    <div class="pl-meta-grid">
      <div>
        <div class="pl-meta-cell-label">Proposal page</div>
        <div class="pl-meta-cell-value is-link">${proposalLink}</div>
      </div>
      <div>
        <div class="pl-meta-cell-label">Client email</div>
        <div class="pl-meta-cell-value is-link">${r.clientEmail ? escapeHtml(r.clientEmail) : '<span style="color:var(--muted-soft);">—</span>'}</div>
      </div>
      <div>
        <div class="pl-meta-cell-label">Sent</div>
        <div class="pl-meta-cell-value">${escapeHtml(sentLine)}</div>
      </div>
      <div>
        <div class="pl-meta-cell-label">First viewed</div>
        <div class="pl-meta-cell-value">${escapeHtml(firstViewedLine)}</div>
      </div>
      <div>
        <div class="pl-meta-cell-label">Last activity</div>
        <div class="pl-meta-cell-value">${escapeHtml(lastActivityLine)}</div>
      </div>
      <div>
        <div class="pl-meta-cell-label">Engagement events</div>
        <div class="pl-meta-cell-value">${r.eventCount} captured</div>
      </div>
    </div>
    <div class="pl-actions">
      ${r.slug ? `<a class="pl-action is-primary" href="/p/${escapeAttr(r.slug)}" target="_blank" rel="noopener">View proposal page ↗</a>` : ''}
      <a class="pl-action" href="/admin/engagement.html?id=${escapeAttr(r.id)}">📊 Engagement</a>
      <a class="pl-action" href="/admin/site-map.html?proposal_id=${escapeAttr(r.id)}">⊞ Site map</a>
      ${r.subPending > 0 ? `<a class="pl-action is-warn" href="/admin/substitutions.html">↺ ${r.subPending} pending sub${r.subPending === 1 ? '' : 's'}</a>` : ''}
      ${r.redPending > 0 ? `<a class="pl-action is-info" href="/admin/client-redesigns.html">✏ ${r.redPending} pending redesign${r.redPending === 1 ? '' : 's'}</a>` : ''}
      ${r.slug ? `<button class="pl-action" type="button" data-action="copy-link" data-slug="${escapeAttr(r.slug)}">📋 Copy proposal link</button>` : ''}
    </div>
  `;
}

function renderEmpty() {
  if (ctx.rows.length === 0) {
    return `
      <div class="pl-empty">
        <div class="pl-empty-title">No proposals yet</div>
        <div>Create a proposal in the Editor and it will appear here.</div>
      </div>
    `;
  }
  return `
    <div class="pl-empty">
      <div class="pl-empty-title">Nothing matches your filter</div>
      <div>Try a different stage or clear the search.</div>
    </div>
  `;
}

function wireRowHandlers() {
  els.content.querySelectorAll('.pl-row').forEach((row) => {
    const plId = row.dataset.plId;
    const summary = row.querySelector('.pl-row-summary');
    summary.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      if (ctx.expandedIds.has(plId)) ctx.expandedIds.delete(plId);
      else ctx.expandedIds.add(plId);
      row.classList.toggle('is-expanded');
    });
    row.querySelectorAll('[data-action="copy-link"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const slug = btn.dataset.slug;
        const url = window.location.origin + '/p/' + slug;
        try {
          await navigator.clipboard.writeText(url);
          const orig = btn.textContent;
          btn.textContent = '✓ Copied';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        } catch (err) {
          alert('Could not copy. URL: ' + url);
        }
      });
    });
  });
}

function showError(msg) {
  els.content.innerHTML = `<div class="pl-empty"><div class="pl-empty-title">Error</div><div>${escapeHtml(msg)}</div></div>`;
}

function formatRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  if (diff < 604_800_000) return Math.floor(diff / 86_400_000) + 'd ago';
  if (diff < 2_592_000_000) return Math.floor(diff / 604_800_000) + 'w ago';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatExact(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
