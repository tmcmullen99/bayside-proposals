// ═══════════════════════════════════════════════════════════════════════════
// admin-outreach.js — Sprint 12
//
// Cold lead pipeline at /admin/outreach.html. Three buckets:
//   1. Drafted, not sent — has a proposal in 'draft' status, never published
//   2. Sent, never opened — published 3+ days ago, zero proposal_events
//   3. Engaged then ghosted — has events, last event 7+ days ago, not signed
//
// Each row links into the War Room with ?mode=outreach&bucket=<bucket>
// so the smart-reply chips load with re-engagement drafts instead of
// thread-reply drafts.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';

const BUCKETS = {
  drafted: {
    title: 'Drafted, not sent',
    sub: 'Proposals you started but never sent to the client.',
    icon: '📝',
    iconClass: 'drafted',
    emptyMsg: 'Nothing in draft limbo. Nice.',
  },
  never_opened: {
    title: 'Sent, never opened',
    sub: 'Sent 3+ days ago, no views yet. Time for a nudge.',
    icon: '📬',
    iconClass: 'never_opened',
    emptyMsg: 'Every proposal that\'s been out 3+ days has been opened. Good.',
  },
  ghosted: {
    title: 'Engaged then ghosted',
    sub: 'They opened the proposal, then went quiet for 7+ days. High recovery potential.',
    icon: '👻',
    iconClass: 'ghosted',
    emptyMsg: 'No active leads have gone quiet. You\'re on top of it.',
  },
};

const NEVER_OPENED_THRESHOLD_DAYS = 3;
const GHOSTED_THRESHOLD_DAYS = 7;

const ctx = {
  viewer: null,
  buckets: { drafted: [], never_opened: [], ghosted: [] },
};

(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.viewer = { ...auth.user, role: auth.profile.role };

  await loadBuckets();
  render();
})();

async function loadBuckets() {
  // We pull all proposals for staff this user can see (RLS scopes appropriately:
  // master sees everything, designer sees their own owner_user_id proposals)
  // and bucket them client-side. This is a small dataset so it's fine.
  const { data: cps, error } = await supabase
    .from('client_proposals')
    .select(`
      id, status, sent_at, signed_at, created_at,
      client:clients!client_id (id, name, email, phone),
      proposal:proposals!proposal_id (
        id, address, project_address, bid_total_amount, owner_user_id, created_at,
        published_proposals (id, slug, published_at, is_canonical)
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[admin-outreach] load failed:', error);
    showError('Could not load outreach pipeline: ' + error.message);
    return;
  }

  // Pull all events for these proposals in one shot
  const propIds = (cps || []).map(cp => cp.proposal?.id).filter(Boolean);
  let eventsByProposal = new Map();
  if (propIds.length > 0) {
    const { data: events } = await supabase
      .from('proposal_events')
      .select('proposal_id, created_at')
      .in('proposal_id', propIds);
    for (const e of (events || [])) {
      if (!eventsByProposal.has(e.proposal_id)) {
        eventsByProposal.set(e.proposal_id, { count: 0, lastEventMs: 0 });
      }
      const entry = eventsByProposal.get(e.proposal_id);
      entry.count += 1;
      const t = new Date(e.created_at).getTime();
      if (t > entry.lastEventMs) entry.lastEventMs = t;
    }
  }

  const now = Date.now();
  const drafted = [];
  const neverOpened = [];
  const ghosted = [];

  // Track which clients are already classified to avoid double-counting
  // when a client has multiple proposals (most engaged bucket wins)
  const classifiedClients = new Set();

  for (const cp of (cps || [])) {
    const p = cp.proposal;
    const c = cp.client;
    if (!p || !c) continue;
    if (cp.status === 'signed') continue;
    if (classifiedClients.has(c.id)) continue;

    const ev = eventsByProposal.get(p.id) || { count: 0, lastEventMs: 0 };
    const pubs = Array.isArray(p.published_proposals) ? p.published_proposals : [];
    const canonical = pubs.find(pp => pp.is_canonical) || pubs[0];
    const publishedAt = canonical?.published_at ? new Date(canonical.published_at).getTime() : null;

    // Bucket priority: ghosted > never_opened > drafted (most actionable first)
    if (ev.count > 0 && ev.lastEventMs > 0) {
      const daysSinceLastEvent = (now - ev.lastEventMs) / 86400000;
      if (daysSinceLastEvent >= GHOSTED_THRESHOLD_DAYS) {
        ghosted.push(buildRow(c, p, cp, ev, daysSinceLastEvent, 'ghosted'));
        classifiedClients.add(c.id);
        continue;
      }
      // Has recent activity, skip — still warm
      classifiedClients.add(c.id);
      continue;
    }

    // No events yet
    if (publishedAt) {
      const daysSincePublished = (now - publishedAt) / 86400000;
      if (daysSincePublished >= NEVER_OPENED_THRESHOLD_DAYS) {
        neverOpened.push(buildRow(c, p, cp, ev, daysSincePublished, 'never_opened'));
        classifiedClients.add(c.id);
        continue;
      }
      // Just sent, give it time
      classifiedClients.add(c.id);
      continue;
    }

    // Not published — draft state
    if (cp.status === 'draft' || !cp.sent_at) {
      const daysSinceCreated = (now - new Date(cp.created_at || p.created_at || now).getTime()) / 86400000;
      drafted.push(buildRow(c, p, cp, ev, daysSinceCreated, 'drafted'));
      classifiedClients.add(c.id);
    }
  }

  ctx.buckets = {
    drafted: drafted.sort((a, b) => b.daysStale - a.daysStale),
    never_opened: neverOpened.sort((a, b) => b.daysStale - a.daysStale),
    ghosted: ghosted.sort((a, b) => b.daysStale - a.daysStale),
  };
}

function buildRow(client, proposal, cp, eventInfo, daysStale, bucket) {
  return {
    clientId: client.id,
    clientName: client.name || '(unnamed)',
    address: proposal.address || proposal.project_address || 'Untitled proposal',
    bidAmount: Number(proposal.bid_total_amount || 0),
    eventCount: eventInfo.count,
    daysStale: Math.floor(daysStale),
    bucket,
    slug: getSlug(proposal),
    proposalId: proposal.id,
  };
}

function getSlug(proposal) {
  const pubs = proposal?.published_proposals;
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  const sorted = [...pubs].sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
  return sorted[0]?.slug || null;
}

// ─── Render ────────────────────────────────────────────────────────────────
function render() {
  const totalCount = ctx.buckets.drafted.length + ctx.buckets.never_opened.length + ctx.buckets.ghosted.length;

  let summaryHtml = '';
  if (totalCount === 0) {
    summaryHtml = `
      <div class="out-summary">
        <p>🎯 <strong>You're all caught up.</strong> No clients need outreach right now.</p>
      </div>
    `;
  } else {
    const parts = [];
    if (ctx.buckets.ghosted.length > 0) {
      parts.push(`<span class="out-summary-num">${ctx.buckets.ghosted.length}</span> ghosted`);
    }
    if (ctx.buckets.never_opened.length > 0) {
      parts.push(`<span class="out-summary-num">${ctx.buckets.never_opened.length}</span> never opened`);
    }
    if (ctx.buckets.drafted.length > 0) {
      parts.push(`<span class="out-summary-num">${ctx.buckets.drafted.length}</span> drafted`);
    }
    summaryHtml = `
      <div class="out-summary">
        <p><span class="out-summary-num">${totalCount}</span> client${totalCount === 1 ? '' : 's'} need follow-up: ${parts.join(', ')}.</p>
        <p>Tap <strong>Outreach</strong> on any row to open their War Room with AI-drafted re-engagement messages ready to send.</p>
      </div>
    `;
  }

  const bucketsHtml = ['ghosted', 'never_opened', 'drafted']
    .map(key => renderBucket(key, ctx.buckets[key]))
    .join('');

  document.getElementById('outContent').innerHTML = summaryHtml + bucketsHtml;
}

function renderBucket(key, rows) {
  const meta = BUCKETS[key];
  const countCls = rows.length === 0 ? 'zero' : '';

  let bodyHtml;
  if (rows.length === 0) {
    bodyHtml = `<div class="out-empty">${escapeHtml(meta.emptyMsg)}</div>`;
  } else {
    bodyHtml = rows.map(row => renderRow(row, key)).join('');
  }

  return `
    <section class="out-bucket">
      <div class="out-bucket-head">
        <div class="out-bucket-head-left">
          <div class="out-bucket-icon ${meta.iconClass}">${meta.icon}</div>
          <div>
            <div class="out-bucket-title">${escapeHtml(meta.title)}</div>
            <div class="out-bucket-sub">${escapeHtml(meta.sub)}</div>
          </div>
        </div>
        <div class="out-bucket-count ${countCls}">${rows.length}</div>
      </div>
      <div class="out-bucket-body">
        ${bodyHtml}
      </div>
    </section>
  `;
}

function renderRow(row, bucket) {
  const bidLabel = row.bidAmount > 0 ? formatBidShort(row.bidAmount) : '';
  const staleLabel = row.daysStale === 0
    ? 'today'
    : `${row.daysStale}d`;

  const staleContext = bucket === 'drafted'
    ? `${staleLabel} since drafted`
    : bucket === 'never_opened'
      ? `${staleLabel} since sent, no opens`
      : `${staleLabel} since last view`;

  const metaParts = [];
  metaParts.push(`<span>${escapeHtml(row.address)}</span>`);
  if (bidLabel) metaParts.push(`<span class="out-row-bid">${escapeHtml(bidLabel)}</span>`);
  metaParts.push(`<span class="out-row-stale">${escapeHtml(staleContext)}</span>`);
  if (row.eventCount > 0) {
    metaParts.push(`<span>${row.eventCount} view${row.eventCount === 1 ? '' : 's'}</span>`);
  }

  const viewBtn = row.slug
    ? `<a class="out-btn" href="/p/${escapeAttr(row.slug)}" target="_blank" rel="noopener">View proposal</a>`
    : '';

  const outreachUrl = `/admin/client.html?id=${encodeURIComponent(row.clientId)}&mode=outreach&bucket=${encodeURIComponent(bucket)}`;

  return `
    <div class="out-row">
      <div class="out-row-info">
        <div class="out-row-name">${escapeHtml(row.clientName)}</div>
        <div class="out-row-meta">${metaParts.join('')}</div>
      </div>
      <div class="out-row-actions">
        ${viewBtn}
        <a class="out-btn out-btn-primary" href="${outreachUrl}">Outreach →</a>
      </div>
    </div>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('outContent').innerHTML =
    `<div class="out-error">${escapeHtml(msg)}</div>`;
}

function formatBidShort(amount) {
  if (amount >= 1000) return '$' + Math.round(amount / 1000) + 'K';
  return '$' + amount.toFixed(0);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
