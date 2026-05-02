// ═══════════════════════════════════════════════════════════════════════════
// admin-client.js — Sprint 10c
//
// War Room layout for one client at /admin/client.html?id=<client_uuid>.
//
// Responsibilities (all in one file — page is self-contained):
//   1. Read client_id from URL, redirect to /admin/clients if missing/invalid
//   2. Verify viewer is master or designer with access (RLS enforces this)
//   3. Load client + proposals + engagement + recent events + messages
//   4. Render the War Room (header / hot stats / context strip / chat / right rail)
//   5. Wire chat send + realtime subscription (pattern reused from
//      admin-clients-chat.js — but inline here, no drawer)
//   6. Recent events come from proposal_events for any of the client's proposals
//
// Smart-reply chips are rendered as static placeholders for now (Sprint 11
// will wire them to an LLM endpoint). They appear so designers see where
// the feature will live.
//
// Sprint 10c-1 ships: text chat + at-a-glance stats + sidebar context.
// Sprint 10c-2 (next): "Edit details" inline modal, smart-reply LLM,
//   notes section, file uploads.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireAdmin, sendMagicLink } from '/js/auth-util.js';
import { getProposalEngagementBulk, formatRelativeTime } from '/js/engagement-utils.js';

const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

const ctx = {
  viewer: null,                  // master/designer profile
  client: null,                  // clients row
  clientProposals: [],           // client_proposals rows w/ joined proposals + published_proposals
  engagement: new Map(),         // proposal_id → engagement summary
  events: [],                    // proposal_events rows (latest 12 across all proposals)
  messages: [],                  // client_messages rows for this client
  profileCache: new Map(),       // sender_user_id → profile for staff renderers
  channel: null,                 // realtime channel
};

// ─── Bootstrap ─────────────────────────────────────────────────────────────
(async function init() {
  ctx.viewer = await requireAdmin();
  if (!ctx.viewer) return; // redirect handled

  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('id');
  if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    showFatal('Missing or invalid client ID. Returning to client list…');
    setTimeout(() => { window.location.href = '/admin/clients'; }, 1600);
    return;
  }
  ctx.profileCache.set(ctx.viewer.id, ctx.viewer);

  await loadAll(clientId);
  if (!ctx.client) {
    showFatal('Could not load this client. They may not exist, or you may not have access.');
    return;
  }
  render();
  subscribeRealtime();
})();

async function loadAll(clientId) {
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select(`
      id, name, email, phone, address, notes, user_id, created_at,
      referral_credit_cents, referral_credit_used_cents, refer_code,
      client_proposals (
        id, status, sent_at, first_viewed_at, signed_at, created_at,
        has_used_free_revision, design_retainer_interest_at,
        proposal:proposals!proposal_id (
          id, address, project_address, project_city, owner_user_id,
          show_signing_discount, bid_total_amount,
          published_proposals (id, slug, published_at, is_canonical)
        )
      )
    `)
    .eq('id', clientId)
    .maybeSingle();

  if (clientErr || !client) {
    console.error('[admin-client] load failed:', clientErr);
    return;
  }
  ctx.client = client;
  ctx.clientProposals = client.client_proposals || [];

  const proposalIds = ctx.clientProposals.map(cp => cp.proposal?.id).filter(Boolean);

  await Promise.all([
    loadEngagement(proposalIds),
    loadRecentEvents(proposalIds),
    loadMessages(client.id),
  ]);
}

async function loadEngagement(proposalIds) {
  if (proposalIds.length === 0) { ctx.engagement = new Map(); return; }
  ctx.engagement = await getProposalEngagementBulk(proposalIds);
}

async function loadRecentEvents(proposalIds) {
  if (proposalIds.length === 0) { ctx.events = []; return; }
  const { data, error } = await supabase
    .from('proposal_events')
    .select('id, proposal_id, event_type, created_at, metadata')
    .in('proposal_id', proposalIds)
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) {
    console.error('[admin-client] events load failed:', error);
    ctx.events = [];
    return;
  }
  ctx.events = data || [];
}

async function loadMessages(clientId) {
  const { data, error } = await supabase
    .from('client_messages')
    .select('id, sender_user_id, sender_role, body, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[admin-client] messages load failed:', error);
    ctx.messages = [];
    return;
  }
  ctx.messages = data || [];

  const staffSenderIds = [...new Set(
    ctx.messages
      .filter(m => m.sender_role === 'designer' || m.sender_role === 'master')
      .map(m => m.sender_user_id)
      .filter(Boolean)
  )];
  const uncached = staffSenderIds.filter(id => !ctx.profileCache.has(id));
  if (uncached.length > 0) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, display_name, email, role')
      .in('id', uncached);
    for (const p of (profs || [])) ctx.profileCache.set(p.id, p);
  }
}

// ─── Render ────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('wrCrumbName').textContent = ctx.client.name || '(unnamed)';
  document.title = `${ctx.client.name || 'Client'} · Admin · Bayside Proposal Builder`;

  const c = ctx.client;
  const initials = (c.name || '?').split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();

  const aggEng = aggregateEngagement();
  const totalEvents = aggEng?.totalEvents || 0;
  const isLive = aggEng?.isLive || false;
  const totalDevices = aggEng?.totalDevices || 0;

  const totalBidCents = ctx.clientProposals.reduce((sum, cp) => {
    return sum + (cp.proposal?.bid_total_amount || 0);
  }, 0);
  const bidLabel = totalBidCents > 0 ? formatBidShort(totalBidCents) : '—';

  const activeDiscount = soonestActiveDiscount();
  const discountLabel = activeDiscount
    ? formatDiscountRemaining(activeDiscount.remainingMs)
    : '—';

  const mainHtml = `
    <div class="wr-card">
      <!-- Header -->
      <div class="wr-header">
        <div class="wr-avatar">${escapeHtml(initials)}</div>
        <div class="wr-header-info">
          <div class="wr-header-name">${escapeHtml(c.name || '(unnamed client)')}</div>
          <div class="wr-header-meta">
            ${c.email ? `<span>📧 <a href="mailto:${escapeAttr(c.email)}">${escapeHtml(c.email)}</a></span>` : ''}
            ${c.phone ? `<span>📞 <a href="tel:${escapeAttr(c.phone)}">${escapeHtml(c.phone)}</a></span>` : ''}
            ${c.address ? `<span>📍 ${escapeHtml(c.address)}</span>` : ''}
          </div>
        </div>
        <div class="wr-header-actions">
          <button class="wr-action-btn" id="wrSendLinkBtn">${c.user_id ? 'Resend login' : 'Send login link'}</button>
          <button class="wr-action-btn" id="wrEditBtn">Edit</button>
        </div>
      </div>

      <!-- Hot stats ribbon -->
      <div class="wr-hot-stats">
        <div class="wr-hot-stat">
          <div class="wr-hot-stat-num ${isLive ? 'live' : ''}">${totalEvents}</div>
          <div class="wr-hot-stat-label">events</div>
        </div>
        <div class="wr-hot-stat">
          <div class="wr-hot-stat-num">${totalDevices || '—'}</div>
          <div class="wr-hot-stat-label">devices</div>
        </div>
        <div class="wr-hot-stat">
          <div class="wr-hot-stat-num">${escapeHtml(bidLabel)}</div>
          <div class="wr-hot-stat-label">bid value</div>
        </div>
        <div class="wr-hot-stat">
          <div class="wr-hot-stat-num discount">${escapeHtml(discountLabel)}</div>
          <div class="wr-hot-stat-label">discount left</div>
        </div>
      </div>

      <!-- 2-column body -->
      <div class="wr-body">
        <!-- Chat (left/main) -->
        <div class="wr-chat-area">
          ${renderContextStrip(aggEng, activeDiscount)}

          <div class="wr-messages" id="wrMessages">
            ${renderMessages()}
          </div>

          <div class="wr-suggestions">
            <div class="wr-suggestions-label">⚡ Suggested replies <span style="opacity: 0.5; text-transform: none; letter-spacing: 0; font-family: inherit;">(coming soon)</span></div>
            <button class="wr-suggestion-chip" disabled style="opacity: 0.7;">Want to schedule a call to walk through?</button>
            <button class="wr-suggestion-chip" disabled style="opacity: 0.7;">I'll send over a quick comparison PDF</button>
            <button class="wr-suggestion-chip" disabled style="opacity: 0.7;">Happy to offer a complimentary tweak</button>
          </div>

          <div class="wr-composer">
            <textarea id="wrComposer" rows="2"
              placeholder="Reply to ${escapeHtml(c.name || 'the client')} — Enter to send, Shift+Enter for new line"></textarea>
            <button id="wrSendBtn">Send</button>
          </div>
        </div>

        <!-- Right rail -->
        <aside class="wr-side">
          <div class="wr-side-section">
            <h4>Active Proposals</h4>
            ${renderProposalCards()}
          </div>
          <div class="wr-side-section">
            <h4>Quick Stats</h4>
            ${renderQuickStats()}
          </div>
          <div class="wr-side-section">
            <h4>Recent Events</h4>
            ${renderRecentEvents()}
          </div>
        </aside>
      </div>
    </div>
  `;

  document.getElementById('wrContent').innerHTML = mainHtml;
  scrollMessagesToBottom();
  wireHandlers();
}

function aggregateEngagement() {
  let totalEvents = 0;
  let lastViewMs = 0;
  let isLive = false;
  let totalDevices = 0;
  for (const cp of ctx.clientProposals) {
    const propId = cp.proposal?.id;
    if (!propId) continue;
    const eng = ctx.engagement.get(propId);
    if (!eng) continue;
    totalEvents += eng.totalEvents || 0;
    if (eng.isLive) isLive = true;
    if (eng.lastView) {
      const t = new Date(eng.lastView).getTime();
      if (t > lastViewMs) lastViewMs = t;
    }
    totalDevices += eng.sessions || 0;
  }
  if (totalEvents === 0 && !isLive) return null;
  return { totalEvents, lastViewMs, isLive, totalDevices };
}

// Returns the proposal whose discount window expires soonest among those still active.
function soonestActiveDiscount() {
  let best = null;
  for (const cp of ctx.clientProposals) {
    const p = cp.proposal;
    if (!p || p.show_signing_discount === false) continue;
    const pubs = Array.isArray(p.published_proposals) ? p.published_proposals : [];
    const canonical = pubs.find(pp => pp.is_canonical) || pubs[0];
    if (!canonical || !canonical.published_at) continue;
    const elapsed = Date.now() - new Date(canonical.published_at).getTime();
    const remaining = DISCOUNT_WINDOW_MS - elapsed;
    if (remaining <= 0) continue;
    if (!best || remaining < best.remainingMs) {
      best = { proposalId: p.id, remainingMs: remaining };
    }
  }
  return best;
}

function renderContextStrip(aggEng, activeDiscount) {
  const pills = [];

  if (aggEng?.isLive) {
    pills.push('<span class="wr-context-pill">🔥 Active right now</span>');
  } else if (aggEng?.lastViewMs > 0) {
    const since = formatRelativeTime(new Date(aggEng.lastViewMs).toISOString());
    pills.push(`<span class="wr-context-pill muted">👀 Last seen ${escapeHtml(since)}</span>`);
  }

  // Free revision status across the client's proposals
  const anyUsedFree = ctx.clientProposals.some(cp => cp.has_used_free_revision);
  const anyInterest = ctx.clientProposals.some(cp => cp.design_retainer_interest_at);
  if (anyInterest) {
    pills.push('<span class="wr-context-pill amber">💼 Design Retainer interest</span>');
  } else if (anyUsedFree) {
    pills.push('<span class="wr-context-pill muted">✓ Free revision used</span>');
  } else if (ctx.clientProposals.length > 0) {
    pills.push('<span class="wr-context-pill muted">↻ Free revision available</span>');
  }

  if (activeDiscount) {
    pills.push(`<span class="wr-context-pill amber">🕒 ${escapeHtml(formatDiscountRemaining(activeDiscount.remainingMs))} until 5% expires</span>`);
  }

  if (!ctx.client.user_id) {
    pills.push('<span class="wr-context-pill gray">📨 Login link not yet used</span>');
  }

  if (pills.length === 0) {
    return '<div class="wr-context-strip"><span class="wr-context-pill gray">No active signals yet</span></div>';
  }
  return `<div class="wr-context-strip">${pills.join('')}</div>`;
}

function renderMessages() {
  if (ctx.messages.length === 0) {
    return `
      <div class="wr-empty">
        <div class="wr-empty-icon">💬</div>
        <div class="wr-empty-title">No messages yet</div>
        <div class="wr-empty-sub">Start the conversation with ${escapeHtml(ctx.client.name || 'the client')}.</div>
      </div>
    `;
  }
  return ctx.messages.map(renderOneMessage).join('');
}

function renderOneMessage(message) {
  const isOutbound = message.sender_user_id === ctx.viewer.id;
  const senderName = getSenderName(message);
  const rolePill =
    message.sender_role === 'master'    ? '<span class="wr-msg-pill master">Master</span>'    :
    message.sender_role === 'designer'  ? '<span class="wr-msg-pill designer">Designer</span>' :
                                          '<span class="wr-msg-pill homeowner">Homeowner</span>';
  const time = formatMessageTime(message.created_at);
  const bodyHtml = escapeHtml(message.body || '').replace(/\n/g, '<br>');
  return `
    <div class="wr-msg ${isOutbound ? 'wr-msg-out' : 'wr-msg-in'}" data-message-id="${escapeAttr(message.id)}">
      <div class="wr-msg-meta">
        <span class="wr-msg-sender">${escapeHtml(senderName)}</span>
        ${rolePill}
        <span class="wr-msg-time">${escapeHtml(time)}</span>
      </div>
      <div class="wr-msg-body">${bodyHtml}</div>
    </div>
  `;
}

function getSenderName(message) {
  if (message.sender_role === 'homeowner') return ctx.client.name || 'Homeowner';
  const profile = ctx.profileCache.get(message.sender_user_id);
  return profile?.display_name || profile?.email || 'Designer';
}

function renderProposalCards() {
  if (ctx.clientProposals.length === 0) {
    return '<div class="wr-empty-side">No proposals assigned yet.</div>';
  }
  return ctx.clientProposals.map(cp => {
    const p = cp.proposal;
    if (!p) return '';
    const eng = ctx.engagement.get(p.id);
    const slug = getLatestSlug(p);
    const bidCents = p.bid_total_amount || 0;
    const bidLabel = bidCents > 0 ? formatBidFull(bidCents) : '';
    const sentDate = cp.sent_at ? formatDate(cp.sent_at) : null;

    let engLine = '';
    if (eng && eng.totalEvents > 0) {
      const recency = eng.isLive ? 'active right now' : `last ${formatRelativeTime(eng.lastView)}`;
      engLine = `
        <div class="wr-proposal-card-eng">
          ${eng.isLive ? '<span class="wr-pulse-dot"></span>' : ''}
          <span>${eng.totalEvents} events · ${escapeHtml(recency)}</span>
        </div>
      `;
    } else {
      engLine = '<div class="wr-proposal-card-eng" style="color: var(--muted);">Not viewed yet</div>';
    }

    return `
      <div class="wr-proposal-card">
        <div class="wr-proposal-card-addr">${escapeHtml(getDisplayAddress(p))}</div>
        <div class="wr-proposal-card-meta">
          ${bidLabel ? `${bidLabel}${sentDate ? ' · Sent ' + escapeHtml(sentDate) : ''}` : (sentDate ? 'Sent ' + escapeHtml(sentDate) : 'Draft')}
        </div>
        ${engLine}
        <div class="wr-proposal-card-actions">
          ${slug ? `<a class="wr-mini-btn" href="/p/${escapeAttr(slug)}" target="_blank" rel="noopener">View</a>` : ''}
          <a class="wr-mini-btn" href="/admin/engagement.html?id=${escapeAttr(p.id)}">Engagement →</a>
        </div>
      </div>
    `;
  }).join('');
}

function renderQuickStats() {
  const c = ctx.client;
  const rows = [];
  rows.push(['Login', c.user_id ? 'Logged in' : 'Not yet']);
  rows.push(['Client since', formatDate(c.created_at)]);
  if (c.referral_credit_cents > 0) {
    rows.push(['Referral credit', `$${(c.referral_credit_cents / 100).toFixed(0)} earned`]);
  }
  return rows.map(([label, value]) =>
    `<div class="wr-detail-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`
  ).join('');
}

function renderRecentEvents() {
  if (ctx.events.length === 0) {
    return '<div class="wr-empty-side">No proposal activity yet.</div>';
  }
  return ctx.events.slice(0, 8).map(e => {
    const time = formatRelativeShort(e.created_at);
    const desc = describeEvent(e);
    return `
      <div class="wr-event">
        <span class="wr-event-time">${escapeHtml(time)}</span>
        <span class="wr-event-body">${escapeHtml(desc)}</span>
      </div>
    `;
  }).join('');
}

function describeEvent(e) {
  const proposal = ctx.clientProposals.find(cp => cp.proposal?.id === e.proposal_id)?.proposal;
  const addr = proposal ? getDisplayAddress(proposal) : 'a proposal';
  const map = {
    proposal_view: `Viewed ${addr}`,
    section_view: `Browsed ${addr}`,
    material_swap_submit: `Requested material swap on ${addr}`,
    redesign_request: `Requested redesign on ${addr}`,
    sign_intent: `Started signing ${addr}`,
    sign_complete: `Signed ${addr} 🎉`,
    referral_invite_send: `Sent a referral invite`,
  };
  return map[e.event_type] || `Event: ${e.event_type}`;
}

// ─── Send + realtime ──────────────────────────────────────────────────────
function wireHandlers() {
  const sendBtn = document.getElementById('wrSendBtn');
  const composer = document.getElementById('wrComposer');
  const sendLinkBtn = document.getElementById('wrSendLinkBtn');
  const editBtn = document.getElementById('wrEditBtn');

  sendBtn?.addEventListener('click', handleSend);
  composer?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  sendLinkBtn?.addEventListener('click', handleSendLoginLink);
  editBtn?.addEventListener('click', handleEdit);
  setTimeout(() => composer?.focus(), 80);
}

async function handleSend() {
  const composer = document.getElementById('wrComposer');
  const sendBtn = document.getElementById('wrSendBtn');
  const body = composer.value.trim();
  if (!body) return;

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  const { error } = await supabase
    .from('client_messages')
    .insert({
      client_id: ctx.client.id,
      sender_user_id: ctx.viewer.id,
      sender_role: ctx.viewer.role,
      body,
    });

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';

  if (error) {
    alert('Could not send: ' + error.message);
    return;
  }
  composer.value = '';
  composer.focus();
  // Realtime delivers the message back; renderer adds it.
}

async function handleSendLoginLink(e) {
  const btn = e.currentTarget;
  if (!ctx.client.email) {
    alert('No email on file for this client.');
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  const { error } = await sendMagicLink(ctx.client.email, '/client/dashboard.html');
  if (error) {
    alert('Could not send: ' + error.message);
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Resend login';
  alert(`Login link sent to ${ctx.client.email}.`);
}

function handleEdit() {
  // Sprint 10c-2 will replace this with an inline edit modal that mirrors
  // /admin/clients's Edit Client modal. For now: link back to the index where
  // the existing Edit modal works.
  window.location.href = '/admin/clients';
}

function subscribeRealtime() {
  if (ctx.channel) supabase.removeChannel(ctx.channel);
  const channelName = `client_messages_${ctx.client.id}_${Date.now()}`;
  ctx.channel = supabase
    .channel(channelName)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'client_messages',
      filter: `client_id=eq.${ctx.client.id}`,
    }, async (payload) => {
      const message = payload.new;
      if ((message.sender_role === 'designer' || message.sender_role === 'master')
          && !ctx.profileCache.has(message.sender_user_id)) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, display_name, email, role')
          .eq('id', message.sender_user_id)
          .maybeSingle();
        if (profile) ctx.profileCache.set(profile.id, profile);
      }
      appendMessage(message);
    })
    .subscribe();
}

function appendMessage(message) {
  const messagesEl = document.getElementById('wrMessages');
  if (!messagesEl) return;
  if (messagesEl.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = messagesEl.querySelector('.wr-empty');
  if (empty) empty.remove();
  ctx.messages.push(message);
  const wasNearBottom = isScrolledNearBottom();
  messagesEl.insertAdjacentHTML('beforeend', renderOneMessage(message));
  if (wasNearBottom) scrollMessagesToBottom();
}

function isScrolledNearBottom() {
  const m = document.getElementById('wrMessages');
  if (!m) return true;
  return (m.scrollHeight - m.scrollTop - m.clientHeight) < 100;
}
function scrollMessagesToBottom() {
  const m = document.getElementById('wrMessages');
  if (m) m.scrollTop = m.scrollHeight;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function showFatal(msg) {
  document.getElementById('wrContent').innerHTML = `<div class="wr-error">${escapeHtml(msg)}</div>`;
}

function getLatestSlug(proposal) {
  const pubs = proposal?.published_proposals;
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  const sorted = [...pubs].sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
  return sorted[0]?.slug || null;
}

function getDisplayAddress(proposal) {
  return proposal?.address || proposal?.project_address || 'Untitled proposal';
}

function formatBidShort(cents) {
  const dollars = cents / 100;
  if (dollars >= 1000) return '$' + Math.round(dollars / 1000) + 'K';
  return '$' + dollars.toFixed(0);
}
function formatBidFull(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDiscountRemaining(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMessageTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  if (d > sevenDaysAgo) {
    return d.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatRelativeShort(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
