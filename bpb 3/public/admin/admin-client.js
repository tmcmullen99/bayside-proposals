// ═══════════════════════════════════════════════════════════════════════════
// admin-client.js — Sprint 10e
//
// War Room layout for one client at /admin/client.html?id=<client_uuid>.
//
// Sprint 10e additions (on top of 10c-2):
//   - Composer file picker (📎) + chips queue (image + PDF, 25MB cap)
//   - Pre-generated message UUID via crypto.randomUUID() so files can land
//     in {client_id}/{messageUuid}/{N}_filename BEFORE the message row
//   - Upload → insert message → insert attachments (in that order)
//   - Attachment rendering: 120px image thumbnails (click → fullscreen) +
//     PDF rows with download links
//   - Signed URL caching (1 hour TTL) to avoid re-signing every render
//   - Realtime: 250ms delay then fetch attachments for new message_id,
//     replace the just-appended bubble in place
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner, sendMagicLink } from '/js/auth-util.js';
import { getProposalEngagementBulk, formatRelativeTime } from '/js/engagement-utils.js';

const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

// Sprint 10e attachment constants
const ATTACHMENT_BUCKET = 'client-messages';
const MAX_FILE_SIZE = 26214400; // 25 MB
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const SIGNED_URL_TTL = 3600; // 1 hour
const REALTIME_ATTACHMENT_DELAY = 250; // ms

const ctx = {
  viewer: null,
  client: null,
  clientProposals: [],
  engagement: new Map(),
  events: [],
  messages: [],
  attachmentsByMessageId: new Map(),  // Sprint 10e
  signedUrlCache: new Map(),          // Sprint 10e: storage_path -> { url, expiresAt }
  queuedFiles: [],                    // Sprint 10e: [{ id, file, error? }]
  profileCache: new Map(),
  channel: null,
};

// ─── Bootstrap ─────────────────────────────────────────────────────────────
(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.viewer = { ...auth.user, role: auth.profile.role };
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
  ensureAttachmentStyles();
  await loadAll(clientId);
  if (!ctx.client) {
    showFatal('Could not load this client. They may not exist, or you may not have access.');
    return;
  }
  render();
  hydrateSignedUrls(document.getElementById('wrMessages'));
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

  // Sprint 10e: bulk-fetch attachments for all loaded messages
  await loadAttachments(ctx.messages.map(m => m.id));
}

async function loadAttachments(messageIds) {
  ctx.attachmentsByMessageId = new Map();
  if (!messageIds || messageIds.length === 0) return;
  const { data, error } = await supabase
    .from('client_message_attachments')
    .select('id, message_id, storage_path, file_name, mime_type, size_bytes')
    .in('message_id', messageIds);
  if (error) {
    console.error('[admin-client] attachments load failed:', error);
    return;
  }
  for (const att of (data || [])) {
    if (!ctx.attachmentsByMessageId.has(att.message_id)) {
      ctx.attachmentsByMessageId.set(att.message_id, []);
    }
    ctx.attachmentsByMessageId.get(att.message_id).push(att);
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

          <div class="wr-file-queue" id="wrFileQueue" style="display:none;"></div>

          <div class="wr-composer">
            <button type="button" class="wr-attach-btn" id="wrAttachBtn" title="Attach images or PDFs (25 MB max)">📎</button>
            <input type="file" id="wrFileInput" multiple
              accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
              style="display:none;">
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
  const bodyHtml = message.body ? escapeHtml(message.body).replace(/\n/g, '<br>') : '';

  // Sprint 10e: render attachments below body (placeholders hydrated later)
  const atts = ctx.attachmentsByMessageId.get(message.id) || [];
  const attsHtml = atts.length > 0 ? renderAttachments(atts) : '';

  return `
    <div class="wr-msg ${isOutbound ? 'wr-msg-out' : 'wr-msg-in'}" data-message-id="${escapeAttr(message.id)}">
      <div class="wr-msg-meta">
        <span class="wr-msg-sender">${escapeHtml(senderName)}</span>
        ${rolePill}
        <span class="wr-msg-time">${escapeHtml(time)}</span>
      </div>
      ${bodyHtml ? `<div class="wr-msg-body">${bodyHtml}</div>` : ''}
      ${attsHtml}
    </div>
  `;
}

function renderAttachments(attachments) {
  const html = attachments.map(att => {
    if (att.mime_type.startsWith('image/')) {
      return `
        <div class="wr-msg-attachment-img"
             data-storage-path="${escapeAttr(att.storage_path)}"
             data-file-name="${escapeAttr(att.file_name)}">
          <div class="wr-msg-attachment-loading">Loading…</div>
        </div>
      `;
    }
    // PDF
    return `
      <div class="wr-msg-attachment-pdf"
           data-storage-path="${escapeAttr(att.storage_path)}"
           data-file-name="${escapeAttr(att.file_name)}">
        <span class="wr-msg-attachment-pdf-icon">📄</span>
        <div class="wr-msg-attachment-pdf-info">
          <div class="wr-msg-attachment-pdf-name">${escapeHtml(att.file_name)}</div>
          <div class="wr-msg-attachment-pdf-meta">${escapeHtml(formatFileSize(att.size_bytes))} · PDF</div>
        </div>
        <a class="wr-msg-attachment-pdf-download" target="_blank" rel="noopener" download="${escapeAttr(att.file_name)}">Open</a>
      </div>
    `;
  }).join('');
  return `<div class="wr-msg-attachments">${html}</div>`;
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
  const attachBtn = document.getElementById('wrAttachBtn');
  const fileInput = document.getElementById('wrFileInput');

  sendBtn?.addEventListener('click', handleSend);
  composer?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  sendLinkBtn?.addEventListener('click', handleSendLoginLink);
  editBtn?.addEventListener('click', () => openEditModal(ctx.client));
  attachBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', handleFileSelect);
  setTimeout(() => composer?.focus(), 80);
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // allow re-selecting the same file
  for (const file of files) {
    let error = null;
    if (file.size > MAX_FILE_SIZE) {
      error = `File too large (${formatFileSize(file.size)}). Max 25 MB.`;
    } else if (!ALLOWED_MIMES.includes(file.type)) {
      error = `Unsupported type. Use JPG, PNG, GIF, WebP, or PDF.`;
    }
    ctx.queuedFiles.push({
      id: crypto.randomUUID(),
      file,
      error,
    });
  }
  renderFileQueue();
}

function renderFileQueue() {
  const queueEl = document.getElementById('wrFileQueue');
  if (!queueEl) return;

  if (ctx.queuedFiles.length === 0) {
    queueEl.innerHTML = '';
    queueEl.style.display = 'none';
    return;
  }

  queueEl.style.display = 'flex';
  queueEl.innerHTML = ctx.queuedFiles.map(item => {
    const isImage = item.file.type.startsWith('image/');
    const sizeStr = formatFileSize(item.file.size);
    const errorHtml = item.error ? `<div class="wr-file-chip-error">${escapeHtml(item.error)}</div>` : '';
    return `
      <div class="wr-file-chip ${item.error ? 'has-error' : ''}" data-chip-id="${escapeAttr(item.id)}">
        <span class="wr-file-chip-icon">${isImage ? '🖼' : '📄'}</span>
        <div class="wr-file-chip-info">
          <span class="wr-file-chip-name">${escapeHtml(item.file.name)}</span>
          <span class="wr-file-chip-meta">${escapeHtml(sizeStr)}</span>
          ${errorHtml}
        </div>
        <button type="button" class="wr-file-chip-remove" aria-label="Remove">×</button>
      </div>
    `;
  }).join('');

  queueEl.querySelectorAll('.wr-file-chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const chipId = e.currentTarget.closest('.wr-file-chip').dataset.chipId;
      ctx.queuedFiles = ctx.queuedFiles.filter(f => f.id !== chipId);
      renderFileQueue();
    });
  });
}

function sanitizeFilename(name) {
  return (name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

async function handleSend() {
  const composer = document.getElementById('wrComposer');
  const sendBtn = document.getElementById('wrSendBtn');
  const body = composer.value.trim();

  const validFiles = ctx.queuedFiles.filter(f => !f.error);
  const hasInvalidQueued = ctx.queuedFiles.some(f => f.error);

  if (hasInvalidQueued) {
    alert('Please remove the invalid file(s) from the queue before sending.');
    return;
  }
  if (!body && validFiles.length === 0) return;

  sendBtn.disabled = true;
  const messageUuid = crypto.randomUUID();

  // Step 1: upload files (if any)
  const uploaded = [];
  if (validFiles.length > 0) {
    for (let i = 0; i < validFiles.length; i++) {
      const item = validFiles[i];
      sendBtn.textContent = `Uploading ${i + 1}/${validFiles.length}…`;
      const sanitized = sanitizeFilename(item.file.name);
      const path = `${ctx.client.id}/${messageUuid}/${i}_${sanitized}`;
      const { error: upErr } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(path, item.file, {
          contentType: item.file.type,
          upsert: false,
        });
      if (upErr) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        alert(`Upload failed for "${item.file.name}": ${upErr.message}`);
        return;
      }
      uploaded.push({
        storage_path: path,
        file_name: item.file.name,
        mime_type: item.file.type,
        size_bytes: item.file.size,
      });
    }
  }

  // Step 2: insert message row with explicit UUID
  sendBtn.textContent = 'Sending…';
  const { error: msgErr } = await supabase
    .from('client_messages')
    .insert({
      id: messageUuid,
      client_id: ctx.client.id,
      sender_user_id: ctx.viewer.id,
      sender_role: ctx.viewer.role,
      body: body || null,
    });

  if (msgErr) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    alert('Could not send: ' + msgErr.message);
    return;
  }

  // Step 3: bulk insert attachment rows
  if (uploaded.length > 0) {
    const rows = uploaded.map(u => ({
      message_id: messageUuid,
      storage_path: u.storage_path,
      file_name: u.file_name,
      mime_type: u.mime_type,
      size_bytes: u.size_bytes,
    }));
    const { error: attErr } = await supabase
      .from('client_message_attachments')
      .insert(rows);
    if (attErr) {
      console.error('[admin-client] attachment row insert failed:', attErr);
      alert(`Message sent but attachments failed to register: ${attErr.message}`);
    }
  }

  // Reset composer state
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
  composer.value = '';
  ctx.queuedFiles = [];
  renderFileQueue();
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

      // Sprint 10e: after a brief delay, fetch attachments for this message
      // (attachment rows commit just after the message row, so there's a
      // small race window where they might not be visible yet)
      setTimeout(async () => {
        const { data: atts } = await supabase
          .from('client_message_attachments')
          .select('id, message_id, storage_path, file_name, mime_type, size_bytes')
          .eq('message_id', message.id);
        if (atts && atts.length > 0) {
          ctx.attachmentsByMessageId.set(message.id, atts);
          // Re-render the just-appended bubble in place
          const node = document.querySelector(`.wr-msg[data-message-id="${CSS.escape(message.id)}"]`);
          if (node) {
            const wasNearBottom = isScrolledNearBottom();
            node.outerHTML = renderOneMessage(message);
            const newNode = document.querySelector(`.wr-msg[data-message-id="${CSS.escape(message.id)}"]`);
            if (newNode) hydrateSignedUrls(newNode);
            if (wasNearBottom) scrollMessagesToBottom();
          }
        }
      }, REALTIME_ATTACHMENT_DELAY);
    })
    .subscribe();
}

function appendMessage(message) {
  const messagesEl = document.getElementById('wrMessages');
  if (!messagesEl) return;
  if (messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
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

// ─── Sprint 10e: signed URL hydration + image viewer ──────────────────────
async function hydrateSignedUrls(scope) {
  if (!scope) return;
  const placeholders = scope.querySelectorAll('[data-storage-path]:not([data-hydrated])');
  for (const el of placeholders) {
    const path = el.dataset.storagePath;
    const fileName = el.dataset.fileName || '';
    const url = await getCachedSignedUrl(path);
    if (!url) {
      el.dataset.hydrated = 'error';
      const loading = el.querySelector('.wr-msg-attachment-loading');
      if (loading) loading.textContent = 'Could not load file';
      continue;
    }

    if (el.classList.contains('wr-msg-attachment-img')) {
      el.innerHTML = `<img src="${escapeAttr(url)}" alt="${escapeAttr(fileName)}" loading="lazy">`;
      el.style.cursor = 'zoom-in';
      el.addEventListener('click', () => openImageViewer(url, fileName));
    } else if (el.classList.contains('wr-msg-attachment-pdf')) {
      const link = el.querySelector('.wr-msg-attachment-pdf-download');
      if (link) link.href = url;
    }
    el.dataset.hydrated = 'true';
  }
}

async function getCachedSignedUrl(path) {
  const cached = ctx.signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.url;

  const { data, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);

  if (error || !data?.signedUrl) {
    console.error('[admin-client] signed URL failed for', path, error);
    return null;
  }

  ctx.signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + (SIGNED_URL_TTL * 1000),
  });
  return data.signedUrl;
}

function openImageViewer(url, fileName) {
  const overlay = document.createElement('div');
  overlay.className = 'wr-image-viewer';
  overlay.innerHTML = `
    <img src="${escapeAttr(url)}" alt="${escapeAttr(fileName)}">
    <button type="button" class="wr-image-viewer-close" aria-label="Close">×</button>
  `;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('wr-image-viewer-close')) close();
  });
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
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
  hydrateSignedUrls(document.getElementById('wrMessages'));
}

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 10e — attachment styles
// ═══════════════════════════════════════════════════════════════════════════

function ensureAttachmentStyles() {
  if (document.getElementById('wr-attachment-styles')) return;
  const style = document.createElement('style');
  style.id = 'wr-attachment-styles';
  style.textContent = `
    /* Composer attach button */
    .wr-attach-btn {
      flex-shrink: 0;
      width: 40px; height: 40px;
      background: transparent;
      border: 1px solid var(--border, #e5e5e5);
      border-radius: 8px;
      cursor: pointer;
      font-size: 18px;
      color: var(--charcoal, #353535);
      transition: background 0.12s, border-color 0.12s, color 0.12s;
      display: flex; align-items: center; justify-content: center;
      align-self: flex-end;
    }
    .wr-attach-btn:hover {
      background: #faf8f3;
      border-color: #5d7e69;
      color: #4a6654;
    }

    /* Queue chips above composer */
    .wr-file-queue {
      background: #fff;
      border-top: 1px solid var(--border, #e5e5e5);
      padding: 10px 22px;
      display: flex; flex-wrap: wrap; gap: 8px;
    }
    .wr-file-chip {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 8px 10px;
      background: #faf8f3;
      border: 1px solid var(--border, #e5e5e5);
      border-radius: 8px;
      max-width: 320px;
      font-size: 12px;
    }
    .wr-file-chip.has-error {
      background: #fef2f2;
      border-color: #fecaca;
    }
    .wr-file-chip-icon {
      font-size: 16px; flex-shrink: 0;
      margin-top: 1px;
    }
    .wr-file-chip-info {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; gap: 2px;
    }
    .wr-file-chip-name {
      font-weight: 600;
      color: #353535;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .wr-file-chip-meta {
      font-size: 11px;
      color: #888;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .wr-file-chip-error {
      font-size: 11px;
      color: #b91c1c;
      margin-top: 2px;
    }
    .wr-file-chip-remove {
      flex-shrink: 0;
      background: transparent; border: 0;
      color: #888; font-size: 16px;
      cursor: pointer; padding: 0 4px;
      line-height: 1; align-self: flex-start;
    }
    .wr-file-chip-remove:hover { color: #b91c1c; }

    /* Attachments inside message bubbles */
    .wr-msg-attachments {
      display: flex; flex-wrap: wrap; gap: 8px;
      margin-top: 6px;
      max-width: 100%;
    }
    .wr-msg-attachment-img {
      width: 120px; height: 120px;
      border-radius: 8px;
      overflow: hidden;
      background: #ece9dd;
      border: 1px solid rgba(0, 0, 0, 0.08);
      transition: transform 0.12s, box-shadow 0.12s;
    }
    .wr-msg-attachment-img:hover {
      transform: scale(1.02);
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.14);
    }
    .wr-msg-attachment-img img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }
    .wr-msg-attachment-loading {
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 100%;
      font-size: 11px;
      color: #888;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .wr-msg-attachment-pdf {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: #fff;
      border: 1px solid var(--border, #e5e5e5);
      border-radius: 10px;
      max-width: 320px;
      transition: border-color 0.12s;
    }
    .wr-msg-out .wr-msg-attachment-pdf {
      background: rgba(255, 255, 255, 0.94);
      border-color: rgba(255, 255, 255, 0.4);
    }
    .wr-msg-attachment-pdf:hover {
      border-color: #5d7e69;
    }
    .wr-msg-attachment-pdf-icon { font-size: 22px; flex-shrink: 0; }
    .wr-msg-attachment-pdf-info {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; gap: 2px;
    }
    .wr-msg-attachment-pdf-name {
      font-size: 13px; font-weight: 600;
      color: #353535;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .wr-msg-attachment-pdf-meta {
      font-size: 11px;
      color: #888;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .wr-msg-attachment-pdf-download {
      background: #5d7e69;
      color: #fff;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-decoration: none;
      flex-shrink: 0;
      transition: background 0.12s;
    }
    .wr-msg-attachment-pdf-download:hover { background: #4a6654; color: #fff; }

    /* Fullscreen image viewer */
    .wr-image-viewer {
      position: fixed; inset: 0;
      z-index: 1300;
      background: rgba(0, 0, 0, 0.88);
      display: flex; align-items: center; justify-content: center;
      cursor: zoom-out;
      animation: wrViewerFade 0.16s ease-out;
    }
    @keyframes wrViewerFade { from { opacity: 0; } to { opacity: 1; } }
    .wr-image-viewer img {
      max-width: 92vw; max-height: 92vh;
      object-fit: contain;
      border-radius: 6px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
    }
    .wr-image-viewer-close {
      position: fixed; top: 20px; right: 24px;
      width: 40px; height: 40px;
      background: rgba(255, 255, 255, 0.16);
      border: 0; color: #fff;
      border-radius: 50%;
      font-size: 22px;
      cursor: pointer;
      line-height: 1;
      transition: background 0.12s;
    }
    .wr-image-viewer-close:hover { background: rgba(255, 255, 255, 0.3); }
  `;
  document.head.appendChild(style);
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

function formatBidShort(amount) {
  if (amount >= 1000) return '$' + Math.round(amount / 1000) + 'K';
  return '$' + amount.toFixed(0);
}
function formatBidFull(amount) {
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
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
