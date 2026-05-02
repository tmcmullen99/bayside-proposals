// ═══════════════════════════════════════════════════════════════════════════
// admin-client.js — Sprint 10c-2
//
// War Room layout for one client at /admin/client.html?id=<client_uuid>.
//
// Sprint 10c-2 changes (on top of 10c-1):
//   - FIX: bid_total_amount is stored as dollars (numeric), not cents — the
//     /100 divisions in the formatters were wrong. Removed them.
//   - NEW: inline Edit modal (Name/Email/Phone/Address/Notes) on the
//     client page itself; the Edit button no longer bounces to /admin/clients.
//   - NEW: Notes section in the right rail (read-only display; edit via
//     the same Edit modal).
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireAdmin, sendMagicLink } from '/js/auth-util.js';
import { getProposalEngagementBulk, formatRelativeTime } from '/js/engagement-utils.js';

const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

const ctx = {
  viewer: null,
  client: null,
  clientProposals: [],
  engagement: new Map(),
  events: [],
  messages: [],
  profileCache: new Map(),
  channel: null,
};

// ─── Bootstrap ─────────────────────────────────────────────────────────────
(async function init() {
  ctx.viewer = await requireAdmin();
  if (!ctx.viewer) return;

  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('id');
  if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    showFatal('Missing or invalid client ID. Returning to client list…');
    setTimeout(() => { window.location.href = '/admin/clients'; }, 1600);
    return;
  }
  ctx.profileCache.set(ctx.viewer.id, ctx.viewer);

  ensureEditModalStyles();
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

  // Sprint 10c-2 fix: bid_total_amount is dollars, not cents — no /100 needed.
  const totalBid = ctx.clientProposals.reduce((sum, cp) => {
    return sum + Number(cp.proposal?.bid_total_amount || 0);
  }, 0);
  const bidLabel = totalBid > 0 ? formatBidShort(totalBid) : '—';

  const activeDiscount = soonestActiveDiscount();
  const discountLabel = activeDiscount
    ? formatDiscountRemaining(activeDiscount.remainingMs)
    : '—';

  const mainHtml = `
    <div class="wr-card">
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

      <div class="wr-body">
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
            <h4>Notes</h4>
            ${renderNotes()}
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
    const bid = Number(p.bid_total_amount || 0);
    const bidLabel = bid > 0 ? formatBidFull(bid) : '';
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

// Sprint 10c-2: read-only Notes display in right rail.
function renderNotes() {
  const notes = ctx.client.notes || '';
  if (!notes.trim()) {
    return '<div class="wr-empty-side">No notes yet. Click <strong>Edit</strong> to add some.</div>';
  }
  return `<div class="wr-notes-display">${escapeHtml(notes).replace(/\n/g, '<br>')}</div>`;
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
  editBtn?.addEventListener('click', () => openEditModal(ctx.client));
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

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 10c-2 — Edit Client modal
// ═══════════════════════════════════════════════════════════════════════════

function ensureEditModalStyles() {
  if (document.getElementById('wrace-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'wrace-modal-styles';
  style.textContent = `
    .wrace-overlay {
      position: fixed; inset: 0; z-index: 1200;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px;
      overflow-y: auto;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      animation: wraceFade 0.18s ease-out;
    }
    @keyframes wraceFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes wraceSlide { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .wrace-modal {
      background: #fff; border-radius: 14px;
      max-width: 540px; width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      animation: wraceSlide 0.22s ease-out;
      color: #353535; overflow: hidden;
      display: flex; flex-direction: column; position: relative;
    }
    .wrace-head { padding: 22px 28px 16px; border-bottom: 1px solid #e8e6dd; }
    .wrace-eyebrow {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: #5d7e69; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .wrace-title { font-size: 20px; font-weight: 600; letter-spacing: -0.012em; margin: 0; }
    .wrace-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: #888;
      border-radius: 6px; transition: background 0.12s, color 0.12s;
    }
    .wrace-close:hover { background: #f4f4ef; color: #353535; }
    .wrace-body { padding: 22px 28px; }
    .wrace-warn {
      background: #fff7e6; color: #7a5a10;
      border-left: 3px solid #c5a050;
      padding: 10px 14px; border-radius: 6px;
      font-size: 12px; line-height: 1.55; margin-bottom: 16px;
    }
    .wrace-error {
      background: #fbeeee; color: #b91c1c;
      border-left: 3px solid #b91c1c;
      padding: 10px 14px; border-radius: 6px;
      font-size: 13px; line-height: 1.5; margin-bottom: 14px;
    }
    .wrace-error.hidden, .wrace-warn.hidden { display: none; }
    .wrace-field { margin-bottom: 14px; }
    .wrace-field label {
      display: block; font-size: 11px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: #888; margin-bottom: 5px;
    }
    .wrace-field input, .wrace-field textarea {
      width: 100%; font-family: inherit; font-size: 14px;
      padding: 9px 12px; border: 1px solid #d4cfc0;
      border-radius: 6px; background: #fff; color: #353535;
      transition: border-color 0.15s, box-shadow 0.15s;
      box-sizing: border-box;
    }
    .wrace-field textarea { min-height: 80px; resize: vertical; }
    .wrace-field input:focus, .wrace-field textarea:focus {
      outline: none; border-color: #5d7e69;
      box-shadow: 0 0 0 3px #e8eee9;
    }
    .wrace-foot {
      padding: 16px 28px; border-top: 1px solid #e8e6dd;
      display: flex; justify-content: flex-end; gap: 10px;
      background: #faf8f3;
    }
    .wrace-btn {
      font: inherit; font-size: 14px; font-weight: 600;
      padding: 9px 18px; border-radius: 8px;
      border: 1px solid transparent; cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s, opacity 0.15s;
    }
    .wrace-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .wrace-cancel { background: #fff; color: #353535; border-color: #d4cfc0; }
    .wrace-cancel:hover:not(:disabled) { background: #f4f4ef; border-color: #888; }
    .wrace-save { background: #5d7e69; color: #fff; box-shadow: 0 4px 12px rgba(93, 126, 105, 0.22); }
    .wrace-save:hover:not(:disabled) { background: #4a6654; transform: translateY(-1px); }

    .wr-notes-display {
      font-size: 13px; line-height: 1.55;
      color: #353535; white-space: pre-wrap; word-wrap: break-word;
    }
  `;
  document.head.appendChild(style);
}

let _editOverlay = null;

function buildEditModal() {
  const overlay = document.createElement('div');
  overlay.className = 'wrace-overlay';
  overlay.innerHTML = `
    <div class="wrace-modal" role="dialog" aria-modal="true" aria-labelledby="wraceTitle">
      <button type="button" class="wrace-close" aria-label="Close">×</button>
      <div class="wrace-head">
        <div class="wrace-eyebrow">Edit client</div>
        <h2 id="wraceTitle" class="wrace-title">Update contact details</h2>
      </div>
      <div class="wrace-body">
        <div class="wrace-warn hidden" id="wraceWarn"></div>
        <div class="wrace-error hidden" id="wraceErr"></div>
        <div class="wrace-field">
          <label>Full name</label>
          <input type="text" id="wraceName" autocomplete="off">
        </div>
        <div class="wrace-field">
          <label>Email <span style="text-transform:none; font-weight:400; color:#aaa;">(must be unique)</span></label>
          <input type="email" id="wraceEmail" autocomplete="off">
        </div>
        <div class="wrace-field">
          <label>Phone</label>
          <input type="tel" id="wracePhone" autocomplete="off">
        </div>
        <div class="wrace-field">
          <label>Project address</label>
          <input type="text" id="wraceAddress" autocomplete="off">
        </div>
        <div class="wrace-field">
          <label>Notes (internal)</label>
          <textarea id="wraceNotes" autocomplete="off" placeholder="Anything worth remembering about this client…"></textarea>
        </div>
      </div>
      <div class="wrace-foot">
        <button type="button" class="wrace-btn wrace-cancel" id="wraceCancel">Cancel</button>
        <button type="button" class="wrace-btn wrace-save" id="wraceSave">Save changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEditModal(); });
  overlay.querySelector('.wrace-close').addEventListener('click', closeEditModal);
  overlay.querySelector('#wraceCancel').addEventListener('click', closeEditModal);
  overlay.querySelector('#wraceSave').addEventListener('click', submitEditClient);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _editOverlay && _editOverlay.style.display !== 'none') {
      closeEditModal();
    }
  });

  return overlay;
}

function openEditModal(client) {
  if (!_editOverlay) _editOverlay = buildEditModal();

  _editOverlay.querySelector('#wraceName').value = client.name || '';
  _editOverlay.querySelector('#wraceEmail').value = client.email || '';
  _editOverlay.querySelector('#wracePhone').value = client.phone || '';
  _editOverlay.querySelector('#wraceAddress').value = client.address || '';
  _editOverlay.querySelector('#wraceNotes').value = client.notes || '';

  const warn = _editOverlay.querySelector('#wraceWarn');
  if (client.user_id) {
    warn.innerHTML = `<strong>Heads up:</strong> ${escapeHtml(client.name)} has already signed in. Changing their email here updates contact info but does <em>not</em> change their auth login — they will keep signing in with their previous email.`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }

  const err = _editOverlay.querySelector('#wraceErr');
  err.classList.add('hidden');
  err.textContent = '';

  const saveBtn = _editOverlay.querySelector('#wraceSave');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save changes';

  _editOverlay.style.display = 'flex';
  setTimeout(() => _editOverlay.querySelector('#wraceName').focus(), 50);
}

function closeEditModal() {
  if (_editOverlay) _editOverlay.style.display = 'none';
}

async function submitEditClient() {
  const saveBtn = _editOverlay.querySelector('#wraceSave');
  const err = _editOverlay.querySelector('#wraceErr');
  err.classList.add('hidden');

  const name = _editOverlay.querySelector('#wraceName').value.trim();
  const email = _editOverlay.querySelector('#wraceEmail').value.trim().toLowerCase();
  const phone = _editOverlay.querySelector('#wracePhone').value.trim();
  const address = _editOverlay.querySelector('#wraceAddress').value.trim();
  const notes = _editOverlay.querySelector('#wraceNotes').value.trim();

  if (!name) {
    err.textContent = 'Name is required.';
    err.classList.remove('hidden');
    return;
  }
  if (!email || !email.includes('@')) {
    err.textContent = 'A valid email is required.';
    err.classList.remove('hidden');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase
    .from('clients')
    .update({
      name, email,
      phone: phone || null,
      address: address || null,
      notes: notes || null,
    })
    .eq('id', ctx.client.id);

  if (error) {
    if (error.code === '23505' || (error.message || '').toLowerCase().includes('duplicate')) {
      err.textContent = `Another client already uses the email "${email}". Pick a different one.`;
    } else {
      err.textContent = `Could not update: ${error.message}`;
    }
    err.classList.remove('hidden');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
    return;
  }

  ctx.client.name = name;
  ctx.client.email = email;
  ctx.client.phone = phone || null;
  ctx.client.address = address || null;
  ctx.client.notes = notes || null;

  closeEditModal();
  render();
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

// Sprint 10c-2 fix: bid_total_amount is dollars, not cents.
function formatBidShort(amount) {
  if (amount >= 1000) return '$' + Math.round(amount / 1000) + 'K';
  return '$' + amount.toFixed(0);
}
function formatBidFull(amount) {
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
