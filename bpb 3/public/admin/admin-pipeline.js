// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-pipeline.js — Phase 6 Sprint 3B
//
// Central pipeline dashboard. Sprint 3A built the funnel-stage view; Sprint 3B
// adds two engagement-driven actions:
//
//   1. Inline follow-up: per-row "Send follow-up" button → modal with
//      pre-filled engagement context and 4 templates (check_in, question,
//      engagement_observed, custom). Send via /api/send-follow-up. Row updates
//      with the new badge + history block.
//
//   2. Bulk panel: visible when filter=cold and there are cold rows. Lets
//      designer select N cold proposals and send a templated follow-up to all
//      at once. Stagger handled server-side; UI shows per-proposal status.
//
// Stage logic unchanged from 3A. New data: a sixth parallel query loads
// recent follow-ups (last 30 days) and merges them into rows with sentCount
// and lastSentAt.
//
// New stage signal: a proposal that received a follow-up within 24h is
// styled as is-followed-up so the designer can visually track which cold
// proposals they've already nudged.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';

const COLD_THRESHOLD_DAYS = 7;
const COLD_THRESHOLD_MS = COLD_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
const FOLLOWUP_RECENT_MS = 24 * 60 * 60 * 1000;

const ctx = {
  user: null,
  userId: null,
  userEmail: null,
  rows: [],
  filter: 'all',
  search: '',
  expandedIds: new Set(),
  bulkSelected: new Set(),
  bulkTemplate: 'check_in',
  modalRow: null,
  modalTemplate: 'check_in',
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

  bulkPanel:         document.getElementById('plBulkPanel'),
  bulkCount:         document.getElementById('plBulkCount'),
  bulkSelectAll:     document.getElementById('plBulkSelectAll'),
  bulkSendBtn:       document.getElementById('plBulkSendBtn'),
  bulkChecklist:     document.getElementById('plBulkChecklist'),

  modal:             document.getElementById('plFollowupModal'),
  modalTitle:        document.getElementById('plFuModalTitle'),
  modalSub:          document.getElementById('plFuModalSub'),
  modalClose:        document.getElementById('plFuModalClose'),
  modalContext:      document.getElementById('plFuContextBody'),
  modalSubject:      document.getElementById('plFuSubject'),
  modalBody:         document.getElementById('plFuBody'),
  modalStatus:       document.getElementById('plFuStatus'),
  modalMeta:         document.getElementById('plFuMeta'),
  modalCancel:       document.getElementById('plFuCancel'),
  modalSend:         document.getElementById('plFuSend'),
};

(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.user = auth.user;
  ctx.userId = auth.user.id;
  ctx.userEmail = auth.profile.email || auth.user.email;
  els.modalMeta.textContent = 'Reply-to: ' + ctx.userEmail;

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

  // Bulk panel handlers
  els.bulkSelectAll.addEventListener('click', toggleBulkSelectAll);
  els.bulkSendBtn.addEventListener('click', sendBulkFollowUps);
  document.querySelectorAll('[data-bulk-template]').forEach((chip) => {
    chip.addEventListener('click', () => {
      ctx.bulkTemplate = chip.dataset.bulkTemplate;
      document.querySelectorAll('[data-bulk-template]').forEach((c) =>
        c.classList.toggle('is-active', c === chip));
    });
  });

  // Modal handlers
  els.modalClose.addEventListener('click', closeModal);
  els.modalCancel.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) closeModal();
  });
  document.querySelectorAll('[data-template]').forEach((chip) => {
    chip.addEventListener('click', () => {
      ctx.modalTemplate = chip.dataset.template;
      document.querySelectorAll('[data-template]').forEach((c) =>
        c.classList.toggle('is-active', c === chip));
      if (ctx.modalRow && ctx.modalTemplate !== 'custom') {
        const t = buildTemplate(ctx.modalRow, ctx.modalTemplate);
        els.modalSubject.value = t.subject;
        els.modalBody.value = t.body;
      }
    });
  });
  els.modalSend.addEventListener('click', sendSingleFollowUp);

  await loadAll();
})();

async function loadAll() {
  els.content.innerHTML = '<div class="pl-loading"><span class="pl-spinner"></span>Loading pipeline…</div>';

  const followUpCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // 6 parallel queries
  const [propsResp, eventsResp, subsResp, redesignsResp, clientPropsResp, followUpsResp] = await Promise.all([
    supabase.from('proposals')
      .select(`
        id, address, project_address, project_city, total_amount:bid_total_amount,
        status, owner_user_id, updated_at, created_at, client_name, client_email,
        published:published_proposals!proposal_id(id, slug, published_at)
      `)
      .order('updated_at', { ascending: false }),

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

    supabase.from('proposal_follow_ups')
      .select('proposal_id, status, sent_at, created_at, template_kind, sent_by')
      .gte('created_at', followUpCutoff)
      .order('created_at', { ascending: false }),
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
  const followUps = followUpsResp.data || [];

  const eventsByProposal = new Map();
  for (const e of events) {
    if (!e.proposal_id) continue;
    const cur = eventsByProposal.get(e.proposal_id) || { count: 0, sectionViews: 0, lastAt: null };
    cur.count += 1;
    if (e.event_type === 'section_view') cur.sectionViews += 1;
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

  const followUpsByProposal = new Map();
  for (const f of followUps) {
    const cur = followUpsByProposal.get(f.proposal_id) || { sentCount: 0, lastSentAt: null, lastTemplate: null };
    if (f.status === 'sent') {
      cur.sentCount += 1;
      const fT = f.sent_at || f.created_at;
      if (!cur.lastSentAt || fT > cur.lastSentAt) {
        cur.lastSentAt = fT;
        cur.lastTemplate = f.template_kind;
      }
    }
    followUpsByProposal.set(f.proposal_id, cur);
  }

  const now = Date.now();
  ctx.rows = proposals.map((p) => {
    const evt = eventsByProposal.get(p.id) || { count: 0, sectionViews: 0, lastAt: null };
    const sub = subsByProposal.get(p.id) || { total: 0, pending: 0, latestAt: null };
    const red = redesignsByProposal.get(p.id) || { total: 0, pending: 0, latestAt: null };
    const cp = clientPropByProposal.get(p.id);
    const fu = followUpsByProposal.get(p.id) || { sentCount: 0, lastSentAt: null, lastTemplate: null };
    const published = (p.published && p.published[0]) || null;

    const candidates = [evt.lastAt, sub.latestAt, red.latestAt, cp && cp.first_viewed_at, fu.lastSentAt]
      .filter(Boolean)
      .map((d) => new Date(d).getTime());
    const lastActivityMs = candidates.length > 0 ? Math.max(...candidates) : null;
    const lastActivityIso = lastActivityMs ? new Date(lastActivityMs).toISOString() : null;

    let stage = 'draft';
    const dbStatus = p.status || 'draft';
    if (['signed', 'completed', 'archived'].includes(dbStatus)) {
      stage = 'resolved';
    } else if (!published) {
      stage = 'draft';
    } else if (sub.total > 0 || red.total > 0) {
      stage = 'engaged';
    } else if (evt.lastAt && (now - new Date(evt.lastAt).getTime()) > COLD_THRESHOLD_MS) {
      stage = 'cold';
    } else if (evt.count > 0 || (cp && cp.first_viewed_at)) {
      stage = 'viewed';
    } else if (cp && cp.sent_at && (now - new Date(cp.sent_at).getTime()) > COLD_THRESHOLD_MS) {
      stage = 'cold';
    } else {
      stage = 'sent';
    }

    const recentlyFollowedUp = fu.lastSentAt &&
      (now - new Date(fu.lastSentAt).getTime()) < FOLLOWUP_RECENT_MS;

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
      sectionViews: evt.sectionViews,
      eventLastAt: evt.lastAt,
      subTotal: sub.total,
      subPending: sub.pending,
      redTotal: red.total,
      redPending: red.pending,
      followUpSentCount: fu.sentCount,
      followUpLastSentAt: fu.lastSentAt,
      followUpLastTemplate: fu.lastTemplate,
      recentlyFollowedUp,
      lastActivityIso,
      stage,
      dbStatus,
      updatedAt: p.updated_at,
    };
  });

  ctx.rows.sort((a, b) => {
    const priA = stagePriority(a.stage) + (a.subPending + a.redPending > 0 ? -10 : 0);
    const priB = stagePriority(b.stage) + (b.subPending + b.redPending > 0 ? -10 : 0);
    if (priA !== priB) return priA - priB;
    const aT = a.lastActivityIso || a.updatedAt || '';
    const bT = b.lastActivityIso || b.updatedAt || '';
    return bT.localeCompare(aT);
  });

  // Drop selections that are no longer cold
  const coldIds = new Set(ctx.rows.filter((r) => r.stage === 'cold').map((r) => r.id));
  for (const id of Array.from(ctx.bulkSelected)) {
    if (!coldIds.has(id)) ctx.bulkSelected.delete(id);
  }

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

  // Bulk panel visibility: only on Cold filter, only with cold rows present
  const showBulk = ctx.filter === 'cold' && visible.some((r) => r.stage === 'cold' && r.clientEmail);
  els.bulkPanel.classList.toggle('is-visible', showBulk);
  if (showBulk) renderBulkPanel(visible.filter((r) => r.stage === 'cold'));

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

function renderBulkPanel(coldRows) {
  const sendable = coldRows.filter((r) => r.clientEmail);
  els.bulkCount.textContent = sendable.length;

  els.bulkChecklist.innerHTML = sendable.map((r) => {
    const checked = ctx.bulkSelected.has(r.id) ? 'checked' : '';
    const lastFu = r.followUpLastSentAt
      ? '· FU ' + formatRelative(r.followUpLastSentAt)
      : '';
    return `
      <label class="pl-bulk-item">
        <input type="checkbox" data-bulk-id="${escapeAttr(r.id)}" ${checked}>
        <span class="pl-bulk-item-address">${escapeHtml(r.address)}</span>
        <span class="pl-bulk-item-meta">${escapeHtml(r.clientEmail)} ${lastFu}</span>
      </label>
    `;
  }).join('');

  els.bulkChecklist.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.bulkId;
      if (cb.checked) ctx.bulkSelected.add(id);
      else ctx.bulkSelected.delete(id);
      updateBulkSendBtn();
    });
  });

  updateBulkSendBtn();
}

function updateBulkSendBtn() {
  const n = ctx.bulkSelected.size;
  els.bulkSendBtn.disabled = n === 0;
  els.bulkSendBtn.textContent = n === 0 ? 'Send follow-ups' : `Send ${n} follow-up${n === 1 ? '' : 's'}`;
}

function toggleBulkSelectAll() {
  const sendable = ctx.rows.filter((r) => r.stage === 'cold' && r.clientEmail);
  const allSelected = sendable.length > 0 && sendable.every((r) => ctx.bulkSelected.has(r.id));
  if (allSelected) {
    sendable.forEach((r) => ctx.bulkSelected.delete(r.id));
  } else {
    sendable.forEach((r) => ctx.bulkSelected.add(r.id));
  }
  render();
}

function renderRow(r) {
  const isExpanded = ctx.expandedIds.has(r.id);
  const isUrgent = r.subPending > 0 || r.redPending > 0;
  const isCold = r.stage === 'cold';
  const cls = ['pl-row'];
  if (isExpanded) cls.push('is-expanded');
  if (r.recentlyFollowedUp) cls.push('is-followed-up');
  else if (isUrgent) cls.push('is-urgent');
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
          ${r.followUpSentCount > 0 ? `<span class="pl-badge pl-badge-followup" title="${r.followUpSentCount} follow-up${r.followUpSentCount === 1 ? '' : 's'} sent">${r.followUpSentCount}f</span>` : ''}
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

  const followUpHistory = r.followUpSentCount > 0 ? `
    <div class="pl-followup-history">
      <div class="pl-followup-history-title">Follow-up history</div>
      ${r.followUpSentCount} follow-up${r.followUpSentCount === 1 ? '' : 's'} sent.
      Most recent: ${escapeHtml(formatExact(r.followUpLastSentAt))}
      ${r.followUpLastTemplate ? '· template: ' + escapeHtml(r.followUpLastTemplate.replace(/_/g, ' ')) : ''}
    </div>
  ` : '';

  const followUpAction = r.clientEmail
    ? `<button class="pl-action is-followup" type="button" data-action="follow-up" data-pl-id="${escapeAttr(r.id)}">✉ Send follow-up${r.followUpSentCount > 0 ? ' (again)' : ''}</button>`
    : '';

  return `
    ${followUpHistory}
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
        <div class="pl-meta-cell-value">${r.eventCount} captured${r.sectionViews > 0 ? ' (' + r.sectionViews + ' section views)' : ''}</div>
      </div>
    </div>
    <div class="pl-actions">
      ${followUpAction}
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
    row.querySelectorAll('[data-action="follow-up"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(btn.dataset.plId);
      });
    });
  });
}

// ── Templates ────────────────────────────────────────────────────────
function buildTemplate(row, kind) {
  const firstName = (row.clientName || '').split(' ')[0] || 'there';
  const addr = row.address;
  const lastViewedRel = row.eventLastAt ? formatRelative(row.eventLastAt) : 'a while back';
  const sectionViewBlurb = row.sectionViews > 2
    ? `I noticed you've come back to the proposal a few times — `
    : '';

  switch (kind) {
    case 'check_in':
      return {
        subject: 'Just checking in on your proposal — ' + addr,
        body:
          'Hi ' + firstName + ',\n\n' +
          'Just wanted to circle back on the proposal I sent over for ' + addr + '. ' +
          'Anything come up that you\'d like to discuss, or any questions I can answer?\n\n' +
          'I\'m around if you want to hop on a quick call — just reply and let me know what works.',
      };

    case 'question':
      return {
        subject: 'Any questions on your ' + addr + ' proposal?',
        body:
          'Hi ' + firstName + ',\n\n' +
          'Wanted to make sure you have everything you need on the ' + addr + ' proposal. ' +
          sectionViewBlurb + 'happy to walk through any details — material choices, ' +
          'timeline, pricing, anything that would be useful.\n\n' +
          'Just hit reply with what\'s on your mind.',
      };

    case 'engagement_observed':
      const evtNote = row.eventCount > 0
        ? `I saw you took another look at the proposal ${lastViewedRel}` +
          (row.sectionViews > 2 ? ` — and you\'ve been coming back to a few sections.` : '.')
        : 'Hope this finds you well.';
      return {
        subject: 'Following up on ' + addr,
        body:
          'Hi ' + firstName + ',\n\n' +
          evtNote + '\n\n' +
          'If anything\'s catching your eye or raising questions — material picks, layout, ' +
          'pricing — let\'s talk it through. Sometimes a quick conversation can save a few ' +
          'rounds of email.\n\n' +
          'Reply here and I\'ll get back to you same-day.',
      };

    case 'custom':
    default:
      return {
        subject: 'Following up on ' + addr,
        body:
          'Hi ' + firstName + ',\n\n' +
          '[Your message here]\n\n',
      };
  }
}

// ── Modal ────────────────────────────────────────────────────────────
function openModal(plId) {
  const row = ctx.rows.find((r) => r.id === plId);
  if (!row) return;
  ctx.modalRow = row;
  ctx.modalTemplate = 'check_in';

  els.modalTitle.textContent = 'Send follow-up to ' + (row.clientName || 'client');
  els.modalSub.textContent = row.address + ' · ' + row.clientEmail;

  // Engagement context summary
  const lastView = row.eventLastAt ? formatRelative(row.eventLastAt) : 'never';
  const contextLines = [];
  contextLines.push(`<strong>${row.eventCount}</strong> engagement event${row.eventCount === 1 ? '' : 's'} captured`);
  if (row.sectionViews > 0) contextLines.push(`<strong>${row.sectionViews}</strong> section view${row.sectionViews === 1 ? '' : 's'}`);
  contextLines.push(`Last viewed: <strong>${lastView}</strong>`);
  if (row.followUpSentCount > 0) {
    contextLines.push(`<strong>${row.followUpSentCount}</strong> prior follow-up${row.followUpSentCount === 1 ? '' : 's'} sent`);
  }
  els.modalContext.innerHTML = contextLines.join(' · ');

  // Reset to check_in template
  document.querySelectorAll('[data-template]').forEach((c) =>
    c.classList.toggle('is-active', c.dataset.template === 'check_in'));
  const t = buildTemplate(row, 'check_in');
  els.modalSubject.value = t.subject;
  els.modalBody.value = t.body;

  els.modalStatus.textContent = '';
  els.modalStatus.className = 'pl-modal-status';
  els.modalSend.disabled = false;
  els.modalSend.textContent = 'Send';

  els.modal.classList.add('is-visible');
  setTimeout(() => els.modalSubject.focus(), 100);
}

function closeModal() {
  els.modal.classList.remove('is-visible');
  ctx.modalRow = null;
}

async function sendSingleFollowUp() {
  if (!ctx.modalRow) return;
  const subject = els.modalSubject.value.trim();
  const body = els.modalBody.value.trim();
  if (!subject) { showModalStatus('error', 'Subject is required.'); return; }
  if (!body) { showModalStatus('error', 'Message is required.'); return; }
  if (subject.length > 240) { showModalStatus('error', 'Subject must be ≤240 characters.'); return; }
  if (body.length > 8000) { showModalStatus('error', 'Message must be ≤8000 characters.'); return; }

  els.modalSend.disabled = true;
  els.modalSend.textContent = 'Sending…';
  showModalStatus('info', 'Sending follow-up…');

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session && session.access_token;
    if (!token) { showModalStatus('error', 'Session expired. Refresh and try again.'); return; }

    const resp = await fetch('/api/send-follow-up', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({
        proposal_id: ctx.modalRow.id,
        template_kind: ctx.modalTemplate,
        subject,
        body,
      }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Check for dedup recent-send 409
      if (resp.status === 409 && result.error && /within the last 7 days/i.test(result.error)) {
        if (confirm('A follow-up was sent to this client within the last 7 days. Send another anyway?')) {
          await retryWithForce(subject, body);
          return;
        } else {
          showModalStatus('error', result.error);
          els.modalSend.disabled = false;
          els.modalSend.textContent = 'Send';
          return;
        }
      }
      showModalStatus('error', 'Could not send: ' + (result.error || ('HTTP ' + resp.status)));
      els.modalSend.disabled = false;
      els.modalSend.textContent = 'Send';
      return;
    }

    showModalStatus('success', 'Follow-up sent ✓');
    setTimeout(async () => {
      closeModal();
      await loadAll();
    }, 1100);

  } catch (err) {
    showModalStatus('error', 'Network error: ' + ((err && err.message) || 'unknown'));
    els.modalSend.disabled = false;
    els.modalSend.textContent = 'Send';
  }
}

async function retryWithForce(subject, body) {
  showModalStatus('info', 'Sending (override)…');
  els.modalSend.disabled = true;
  els.modalSend.textContent = 'Sending…';
  const { data: { session } } = await supabase.auth.getSession();
  const token = session && session.access_token;
  const resp = await fetch('/api/send-follow-up', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({
      proposal_id: ctx.modalRow.id,
      template_kind: ctx.modalTemplate,
      subject,
      body,
      force: true,
    }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    showModalStatus('error', 'Could not send: ' + (result.error || ('HTTP ' + resp.status)));
    els.modalSend.disabled = false;
    els.modalSend.textContent = 'Send';
    return;
  }
  showModalStatus('success', 'Follow-up sent ✓');
  setTimeout(async () => {
    closeModal();
    await loadAll();
  }, 1100);
}

function showModalStatus(type, msg) {
  els.modalStatus.textContent = msg;
  els.modalStatus.className = 'pl-modal-status is-' + type;
}

// ── Bulk send ────────────────────────────────────────────────────────
async function sendBulkFollowUps() {
  const selectedRows = ctx.rows.filter((r) => ctx.bulkSelected.has(r.id) && r.clientEmail);
  if (selectedRows.length === 0) return;

  const confirmMsg = `Send a "${ctx.bulkTemplate.replace(/_/g, ' ')}" follow-up to ${selectedRows.length} client${selectedRows.length === 1 ? '' : 's'}?`;
  if (!confirm(confirmMsg)) return;

  els.bulkSendBtn.disabled = true;
  els.bulkSendBtn.textContent = `Sending ${selectedRows.length}…`;

  const items = selectedRows.map((r) => {
    const t = buildTemplate(r, ctx.bulkTemplate);
    return {
      proposal_id: r.id,
      template_kind: ctx.bulkTemplate,
      subject: t.subject,
      body: t.body,
    };
  });

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session && session.access_token;
    const resp = await fetch('/api/send-follow-up', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ items }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !Array.isArray(result.results)) {
      alert('Bulk send failed: ' + (result.error || ('HTTP ' + resp.status)));
      els.bulkSendBtn.disabled = false;
      updateBulkSendBtn();
      return;
    }

    const sent = result.results.filter((r) => r.ok).length;
    const skipped = result.results.filter((r) => r.status === 'skipped_recent_send').length;
    const failed = result.results.filter((r) => !r.ok && r.status !== 'skipped_recent_send').length;

    let msg = `${sent} follow-up${sent === 1 ? '' : 's'} sent.`;
    if (skipped > 0) msg += ` ${skipped} skipped (recent sends).`;
    if (failed > 0) msg += ` ${failed} failed.`;
    alert(msg);

    ctx.bulkSelected.clear();
    await loadAll();

  } catch (err) {
    alert('Network error: ' + ((err && err.message) || 'unknown'));
    els.bulkSendBtn.disabled = false;
    updateBulkSendBtn();
  }
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
