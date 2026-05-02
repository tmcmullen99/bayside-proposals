// ═══════════════════════════════════════════════════════════════════════════
// admin-clients.js
// Admin client management — Tim's interface for managing clients.
//
// Auth: requireAdmin() at the top redirects non-admins away.
//
// Sprint 8a additions (on top of Phase 5D.2 baseline):
//   - Creation date line on every client card
//   - Aggregate engagement chip on the collapsed card row (sums events
//     across all their assigned proposals)
//   - Discount-timer status line on each assigned proposal row
//   - Edit Client replaced with a real modal (name + EMAIL + phone +
//     address + notes), including email-collision handling and a warning
//     when editing a client who has already signed in
//
// Sprint 10b addition:
//   - "Open chat" button in the Client Actions row of every client card,
//     opens the per-client chat drawer (admin-clients-chat.js)
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireAdmin, sendMagicLink } from '/js/auth-util.js';
import { getProposalEngagementBulk, formatRelativeTime } from '/js/engagement-utils.js';
import { openClientChatDrawer } from './admin-clients-chat.js';

// 48-hour signing-discount window. Lives in publish.js's email body too.
const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

// DOM
const loadingState = document.getElementById('loadingState');
const clientsList = document.getElementById('clientsList');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('searchInput');
const counter = document.getElementById('counter');
const statusBox = document.getElementById('status');
const addClientBtn = document.getElementById('addClientBtn');
const addForm = document.getElementById('addForm');
const cancelAddBtn = document.getElementById('cancelAddBtn');
const saveClientBtn = document.getElementById('saveClientBtn');
const newName = document.getElementById('newName');
const newEmail = document.getElementById('newEmail');
const newPhone = document.getElementById('newPhone');
const newAddress = document.getElementById('newAddress');
const newNotes = document.getElementById('newNotes');

// State
const ctx = {
  admin: null,
  clients: [],
  proposals: [],
  engagement: new Map(),
  expandedIds: new Set(),
  searchTerm: '',
};

// ── Bootstrap ──────────────────────────────────────────────────────────────
(async function init() {
  ctx.admin = await requireAdmin();
  if (!ctx.admin) return;

  ensureEditModalStyles();
  await Promise.all([loadClients(), loadAllProposals()]);
  await loadEngagement();
  render();
  attachEventListeners();
})();

async function loadClients() {
  const { data, error } = await supabase
    .from('clients')
    .select(`
      id, name, email, phone, address, notes, user_id, created_at, created_by,
      referral_credit_cents, referral_credit_used_cents, refer_code,
      client_proposals (
        id, status, sent_at, first_viewed_at, signed_at, created_at,
        proposal:proposals!proposal_id (
          id,
          address,
          show_signing_discount,
          published_proposals (id, slug, published_at, is_canonical)
        )
      ),
      sent_referrals:referrals!referrer_client_id (
        id, referred_email, referred_name, referred_phone, status,
        invite_sent_at, scheduled_at, appointment_completed_at,
        credit_awarded_at, credit_amount_cents
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    showStatus('error', `Could not load clients: ${error.message}`);
    ctx.clients = [];
    return;
  }
  ctx.clients = data || [];
}

async function loadAllProposals() {
  const { data, error } = await supabase
    .from('proposals')
    .select(`
      id, address, created_at,
      published_proposals (id, slug)
    `)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('Could not load proposals:', error);
    ctx.proposals = [];
    return;
  }
  ctx.proposals = data || [];
}

async function loadEngagement() {
  const ids = new Set();
  for (const client of ctx.clients) {
    for (const cp of (client.client_proposals || [])) {
      if (cp.proposal && cp.proposal.id) ids.add(cp.proposal.id);
    }
  }
  if (ids.size === 0) {
    ctx.engagement = new Map();
    return;
  }
  ctx.engagement = await getProposalEngagementBulk([...ids]);
}

function attachEventListeners() {
  searchInput.addEventListener('input', (e) => {
    ctx.searchTerm = e.target.value.trim().toLowerCase();
    render();
  });

  addClientBtn.addEventListener('click', () => {
    addForm.classList.add('visible');
    newName.focus();
  });
  cancelAddBtn.addEventListener('click', () => {
    addForm.classList.remove('visible');
    clearAddForm();
  });
  saveClientBtn.addEventListener('click', handleAddClient);
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  loadingState.style.display = 'none';

  const visible = ctx.searchTerm
    ? ctx.clients.filter(c => {
        const haystack = [c.name, c.email, c.phone, c.address, c.notes]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(ctx.searchTerm);
      })
    : ctx.clients;

  counter.textContent = `${visible.length} of ${ctx.clients.length} clients`;

  if (ctx.clients.length === 0) {
    emptyState.style.display = 'block';
    clientsList.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  clientsList.style.display = 'grid';
  clientsList.innerHTML = `
    <style>
      @keyframes adminClientsEngPulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.4); opacity: 0.6; }
      }
    </style>
    ${visible.map(renderClientCard).join('')}
  `;

  visible.forEach(c => {
    wireCardHandlers(c);
  });
}

function renderClientCard(client) {
  const isExpanded = ctx.expandedIds.has(client.id);
  const linkedBadge = client.user_id
    ? '<span class="badge linked">Logged in</span>'
    : '<span class="badge unlinked">Not yet logged in</span>';

  const proposalCount = (client.client_proposals || []).length;
  const proposalBadge = proposalCount > 0
    ? `<span class="badge proposals">${proposalCount} proposal${proposalCount === 1 ? '' : 's'}</span>`
    : '';

  const referralCount = (client.sent_referrals || []).length;
  const referralBadge = referralCount > 0
    ? `<span class="badge proposals" style="background:#fff4d4;color:#7a5a10;">${referralCount} referral${referralCount === 1 ? '' : 's'}</span>`
    : '';

  const aggEng = aggregateClientEngagement(client);
  const engagementLine = renderClientEngagementLine(aggEng);

  const createdLine = client.created_at
    ? `<span style="font-family:'JetBrains Mono', ui-monospace, monospace; font-size:11px; color:var(--muted);">Client since ${formatDate(client.created_at)}</span>`
    : '';

  return `
    <div class="client-card ${isExpanded ? 'expanded' : ''}" data-client-id="${client.id}">
      <div class="client-row">
        <div class="client-info">
          <div class="client-name">${escapeHtml(client.name)}</div>
          <div class="client-meta">
            <span>${escapeHtml(client.email)}</span>
            ${client.phone ? `<span>${escapeHtml(client.phone)}</span>` : ''}
            ${client.address ? `<span>${escapeHtml(client.address)}</span>` : ''}
          </div>
          ${(createdLine || engagementLine) ? `
            <div style="display:flex; gap:14px; align-items:center; margin-top:6px; flex-wrap:wrap;">
              ${createdLine}
              ${engagementLine}
            </div>
          ` : ''}
        </div>
        <div class="client-badges">
          ${linkedBadge}
          ${proposalBadge}
          ${referralBadge}
          <span class="client-chevron">›</span>
        </div>
      </div>
      <div class="client-expand">
        ${renderClientExpand(client)}
      </div>
    </div>
  `;
}

function aggregateClientEngagement(client) {
  let totalEvents = 0;
  let lastViewMs = 0;
  let isLive = false;
  for (const cp of (client.client_proposals || [])) {
    const propId = cp.proposal && cp.proposal.id;
    if (!propId) continue;
    const eng = ctx.engagement.get(propId);
    if (!eng || eng.totalEvents === 0) continue;
    totalEvents += eng.totalEvents;
    if (eng.isLive) isLive = true;
    if (eng.lastView) {
      const t = new Date(eng.lastView).getTime();
      if (t > lastViewMs) lastViewMs = t;
    }
  }
  if (totalEvents === 0) return null;
  return { totalEvents, lastViewMs, isLive };
}

function renderClientEngagementLine(agg) {
  if (!agg) return '';
  const dotColor = agg.isLive
    ? '#10a04a'
    : (Date.now() - agg.lastViewMs < 24 * 3600 * 1000 ? 'var(--green-dark)' : 'var(--muted)');
  const animation = agg.isLive ? 'animation: adminClientsEngPulse 1.5s ease-in-out infinite;' : '';
  const recency = agg.isLive
    ? 'active right now'
    : agg.lastViewMs > 0 ? `last activity ${formatRelativeTime(new Date(agg.lastViewMs).toISOString())}` : '';
  return `
    <span style="display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--green-dark); font-weight:500;">
      <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${dotColor}; ${animation}"></span>
      ${agg.totalEvents} event${agg.totalEvents === 1 ? '' : 's'}${recency ? ' · ' + escapeHtml(recency) : ''}
    </span>
  `;
}

function renderClientExpand(client) {
  const assignments = client.client_proposals || [];
  const assignedProposalIds = new Set(
    assignments.map(a => a.proposal?.id).filter(Boolean)
  );
  const unassignedProposals = ctx.proposals.filter(p => !assignedProposalIds.has(p.id));

  return `
    <div class="expand-section">
      <h4>Assigned Proposals</h4>
      ${assignments.length === 0 ? `
        <div style="color:var(--muted); font-size:13px; padding:8px 0;">
          No proposals assigned yet.
        </div>
      ` : assignments.map(a => renderAssignedProposal(a)).join('')}
    </div>

    <div class="expand-section">
      <h4>Assign a Proposal</h4>
      <div class="assign-row">
        <select class="assign-select" data-client-id="${client.id}">
          <option value="">Select an existing proposal…</option>
          ${unassignedProposals.map(p => `
            <option value="${escapeAttr(p.id)}">
              ${escapeHtml(getDisplayAddress(p))}
            </option>
          `).join('')}
        </select>
        <button class="btn btn-small assign-btn" data-client-id="${client.id}">Assign</button>
      </div>
      ${unassignedProposals.length === 0 ? `
        <div style="color:var(--muted); font-size:12px; margin-top:6px;">
          All proposals are already assigned. Create a new proposal in the editor first.
        </div>
      ` : ''}
    </div>

    ${renderReferralsSection(client)}

    <div class="expand-section">
      <h4>Client Actions</h4>
      <div class="actions-row">
        <button class="btn btn-small send-link-btn" data-client-id="${client.id}" data-email="${escapeAttr(client.email)}">
          ${client.user_id ? 'Resend login link' : 'Send login link'}
        </button>
        <button class="btn btn-small btn-secondary edit-btn" data-client-id="${client.id}">
          Edit client
        </button>
        <button class="btn btn-small btn-secondary chat-btn" data-client-id="${client.id}">
          Open chat
        </button>
        <button class="btn btn-small btn-danger delete-btn" data-client-id="${client.id}">
          Remove client
        </button>
      </div>
      ${client.notes ? `
        <div style="margin-top:12px; padding:10px 12px; background:#fff; border:1px solid var(--border); border-radius:6px; font-size:12px; color:var(--muted);">
          <strong style="color:var(--navy);">Notes:</strong> ${escapeHtml(client.notes)}
        </div>
      ` : ''}
    </div>
  `;
}

function renderAssignedProposal(a) {
  const p = a.proposal;
  if (!p) return '';
  const statusLabel = {
    draft: 'Draft', sent: 'Sent', viewed: 'Viewed',
    signed: 'Signed', in_progress: 'In Progress', complete: 'Complete',
  }[a.status] || a.status;

  const slug = getLatestSlug(p);
  const viewButton = slug
    ? `<a class="btn btn-small btn-secondary" href="/p/${escapeAttr(slug)}" target="_blank" rel="noopener">View</a>`
    : `<span class="btn btn-small btn-secondary" style="opacity:0.5;cursor:not-allowed;" title="No published version yet">View</span>`;

  const eng = ctx.engagement.get(p.id);
  const engagementChip = renderEngagementChip(p.id, eng);
  const discountLine = renderDiscountStatus(p);

  return `
    <div class="proposal-row">
      <div class="proposal-row-info">
        <div class="proposal-row-address">${escapeHtml(getDisplayAddress(p))}</div>
        <div class="proposal-row-meta">
          ${escapeHtml(statusLabel)}
          ${a.sent_at ? ` · Sent ${formatDate(a.sent_at)}` : ''}
          ${a.first_viewed_at ? ` · Viewed ${formatDate(a.first_viewed_at)}` : ''}
        </div>
        ${engagementChip}
        ${discountLine}
      </div>
      <div style="display:flex; gap:6px;">
        ${viewButton}
        <button class="btn btn-small btn-danger unassign-btn" data-assignment-id="${escapeAttr(a.id)}">Unassign</button>
      </div>
    </div>
  `;
}

function renderDiscountStatus(proposal) {
  if (proposal.show_signing_discount === false) {
    return `
      <div style="font-size:11px; color:var(--muted); margin-top:4px; font-family:'JetBrains Mono', ui-monospace, monospace;">
        Signing discount disabled
      </div>
    `;
  }
  const pubs = Array.isArray(proposal.published_proposals) ? proposal.published_proposals : [];
  const canonical = pubs.find(p => p.is_canonical) || pubs[0];
  if (!canonical || !canonical.published_at) {
    return `
      <div style="font-size:11px; color:var(--muted); margin-top:4px; font-family:'JetBrains Mono', ui-monospace, monospace;">
        Not published yet
      </div>
    `;
  }
  const publishedMs = new Date(canonical.published_at).getTime();
  const elapsedMs = Date.now() - publishedMs;
  const remainingMs = DISCOUNT_WINDOW_MS - elapsedMs;
  if (remainingMs <= 0) {
    return `
      <div style="font-size:11px; color:var(--muted); margin-top:4px; font-family:'JetBrains Mono', ui-monospace, monospace;">
        Discount expired
      </div>
    `;
  }
  const remainingHours = Math.floor(remainingMs / (3600 * 1000));
  const remainingMinutes = Math.floor((remainingMs % (3600 * 1000)) / (60 * 1000));
  const display = remainingHours >= 1
    ? `${remainingHours}h ${remainingMinutes}m`
    : `${remainingMinutes}m`;
  return `
    <div style="font-size:11px; color:var(--green-dark); margin-top:4px; font-weight:600; font-family:'JetBrains Mono', ui-monospace, monospace;">
      🕒 5% discount: ${display} remaining
    </div>
  `;
}

function renderEngagementChip(proposalId, eng) {
  if (!eng || eng.totalEvents === 0) {
    return `
      <div style="font-size:11px; color:var(--muted); margin-top:6px; font-family:'JetBrains Mono', ui-monospace, monospace;">
        Not viewed yet
      </div>
    `;
  }

  const dotColor = eng.isLive
    ? '#10a04a'
    : (Date.now() - new Date(eng.lastView).getTime() < 24 * 3600 * 1000
        ? 'var(--green-dark)' : 'var(--muted)');
  const animation = eng.isLive
    ? 'animation: adminClientsEngPulse 1.5s ease-in-out infinite;' : '';
  const eventsLabel = `${eng.totalEvents} event${eng.totalEvents === 1 ? '' : 's'}`;
  const sessionsLabel = `${eng.sessions} device${eng.sessions === 1 ? '' : 's'}`;
  const recencyLabel = eng.isLive
    ? 'active right now'
    : `last ${formatRelativeTime(eng.lastView)}`;

  return `
    <a href="/admin/engagement.html?id=${escapeAttr(proposalId)}"
       style="display:inline-flex; align-items:center; gap:8px; margin-top:6px;
              font-size:12px; color:var(--green-dark); text-decoration:none;
              padding:4px 0; font-weight:500;">
      <span style="display:inline-block; width:8px; height:8px; border-radius:50%;
                   background:${dotColor}; flex-shrink:0; ${animation}"></span>
      <span>${escapeHtml(eventsLabel)} · ${escapeHtml(sessionsLabel)} · ${escapeHtml(recencyLabel)}</span>
      <span style="opacity:0.5;">→</span>
    </a>
  `;
}

function renderReferralsSection(client) {
  const referrals = client.sent_referrals || [];
  const creditCents = Number(client.referral_credit_cents || 0);
  const usedCents   = Number(client.referral_credit_used_cents || 0);
  const cap         = 250000;
  const referCode   = client.refer_code || '';

  const balanceLine = referrals.length > 0 || creditCents > 0
    ? `
      <div style="background:var(--cream); border-radius:7px; padding:12px 16px; margin-bottom:10px; display:flex; gap:18px; align-items:center; flex-wrap:wrap; font-size:12px;">
        <span style="font-family:'JetBrains Mono',monospace; font-weight:600; color:var(--green-dark);">
          $${(creditCents/100).toFixed(0)} earned
        </span>
        <span style="color:var(--muted);">of $${(cap/100).toFixed(0)} cap</span>
        ${usedCents > 0 ? `<span style="color:var(--muted);">· $${(usedCents/100).toFixed(0)} used</span>` : ''}
        ${referCode ? `<span style="color:var(--muted); margin-left:auto;">code: <code style="background:#fff; padding:2px 6px; border-radius:3px; font-size:11px;">${escapeHtml(referCode)}</code></span>` : ''}
      </div>
    `
    : '';

  const list = referrals.length === 0
    ? `<div style="color:var(--muted); font-size:13px; padding:8px 0;">No referrals sent yet.</div>`
    : referrals
        .slice()
        .sort((a, b) => (b.invite_sent_at || '').localeCompare(a.invite_sent_at || ''))
        .map(r => renderReferralRow(r, client))
        .join('');

  return `
    <div class="expand-section">
      <h4>Sent Referrals</h4>
      ${balanceLine}
      ${list}
    </div>
  `;
}

function renderReferralRow(referral, client) {
  const status = referral.status || 'sent';
  const refereeName = referral.referred_name || referral.referred_email || '(unknown)';

  const pillStyles = {
    sent:      { bg: '#eef3f8', fg: '#2b4a73', label: 'Invite sent' },
    scheduled: { bg: '#fff4d4', fg: '#7a5a10', label: 'Appt scheduled' },
    completed: { bg: '#e8eee9', fg: '#4a6654', label: 'Complete (cap reached)' },
    credited:  { bg: '#e8eee9', fg: '#4a6654', label: '✓ Credited $500' },
  };
  const pill = pillStyles[status] || { bg: '#f0f0f0', fg: '#666', label: status };

  const showButton = status === 'sent' || status === 'scheduled';
  const button = showButton
    ? `<button class="btn btn-small mark-complete-btn" data-referral-id="${escapeAttr(referral.id)}">Mark appt complete</button>`
    : '';

  const dateLine = referral.credit_awarded_at
    ? `Credited ${formatDate(referral.credit_awarded_at)}`
    : referral.appointment_completed_at
      ? `Completed ${formatDate(referral.appointment_completed_at)}`
      : referral.scheduled_at
        ? `Scheduled ${formatDate(referral.scheduled_at)}`
        : referral.invite_sent_at
          ? `Sent ${formatDate(referral.invite_sent_at)}`
          : '';

  return `
    <div class="proposal-row">
      <div class="proposal-row-info">
        <div class="proposal-row-address">${escapeHtml(refereeName)}</div>
        <div class="proposal-row-meta">
          ${escapeHtml(referral.referred_email || '')}${referral.referred_phone ? ` · ${escapeHtml(referral.referred_phone)}` : ''}
          ${dateLine ? ` · ${escapeHtml(dateLine)}` : ''}
        </div>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <span class="badge" style="background:${pill.bg}; color:${pill.fg};">${escapeHtml(pill.label)}</span>
        ${button}
      </div>
    </div>
  `;
}

// ── Event wiring (per-card, after render) ──────────────────────────────────
function wireCardHandlers(client) {
  const card = clientsList.querySelector(`[data-client-id="${client.id}"]`);
  if (!card) return;

  card.querySelector('.client-row').addEventListener('click', (e) => {
    if (e.target.closest('button, select, a, input, textarea')) return;
    if (ctx.expandedIds.has(client.id)) {
      ctx.expandedIds.delete(client.id);
    } else {
      ctx.expandedIds.add(client.id);
    }
    card.classList.toggle('expanded');
  });

  card.querySelector('.assign-btn')?.addEventListener('click', async () => {
    const sel = card.querySelector('.assign-select');
    const proposalId = sel.value;
    if (!proposalId) return;
    await handleAssignProposal(client.id, proposalId);
  });

  card.querySelector('.send-link-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    await handleSendLoginLink(client, btn);
  });

  card.querySelector('.edit-btn')?.addEventListener('click', () => {
    openEditClientModal(client);
  });

  card.querySelector('.chat-btn')?.addEventListener('click', () => {
    openClientChatDrawer(client);
  });

  card.querySelector('.delete-btn')?.addEventListener('click', () => {
    handleDeleteClient(client);
  });

  card.querySelectorAll('.unassign-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const assignmentId = e.currentTarget.dataset.assignmentId;
      await handleUnassign(assignmentId);
    });
  });

  card.querySelectorAll('.mark-complete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const referralId = e.currentTarget.dataset.referralId;
      await handleMarkComplete(referralId, e.currentTarget);
    });
  });
}

// ── Actions ────────────────────────────────────────────────────────────────
async function handleAddClient() {
  const name = newName.value.trim();
  const email = newEmail.value.trim().toLowerCase();
  const phone = newPhone.value.trim();
  const address = newAddress.value.trim();
  const notes = newNotes.value.trim();

  if (!name) return showStatus('error', 'Name is required.');
  if (!email || !email.includes('@')) return showStatus('error', 'Valid email is required.');

  saveClientBtn.disabled = true;

  const { error } = await supabase
    .from('clients')
    .insert({
      name, email, phone: phone || null,
      address: address || null,
      notes: notes || null,
      created_by: ctx.admin.id,
    });

  saveClientBtn.disabled = false;

  if (error) {
    if (error.code === '23505') {
      return showStatus('error', `A client with email "${email}" already exists.`);
    }
    return showStatus('error', `Could not save: ${error.message}`);
  }

  addForm.classList.remove('visible');
  clearAddForm();
  showStatus('success', `Added ${name}. Click their row to expand, then "Send login link" to invite them.`);
  await loadClients();
  await loadEngagement();
  render();
}

function clearAddForm() {
  newName.value = '';
  newEmail.value = '';
  newPhone.value = '';
  newAddress.value = '';
  newNotes.value = '';
}

async function handleAssignProposal(clientId, proposalId) {
  const { error } = await supabase
    .from('client_proposals')
    .insert({
      client_id: clientId,
      proposal_id: proposalId,
      status: 'draft',
    });
  if (error) {
    if (error.code === '23505') {
      return showStatus('error', 'That proposal is already assigned to this client.');
    }
    return showStatus('error', `Could not assign: ${error.message}`);
  }
  showStatus('success', 'Proposal assigned.');
  await loadClients();
  await loadEngagement();
  render();
}

async function handleUnassign(assignmentId) {
  if (!confirm('Remove this proposal assignment? The proposal itself is not deleted.')) return;
  const { error } = await supabase
    .from('client_proposals')
    .delete()
    .eq('id', assignmentId);
  if (error) return showStatus('error', `Could not unassign: ${error.message}`);
  showStatus('success', 'Unassigned.');
  await loadClients();
  await loadEngagement();
  render();
}

async function handleSendLoginLink(client, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Sending…';

  const { error } = await sendMagicLink(client.email, '/client/dashboard.html');

  if (error) {
    showStatus('error', `Could not send: ${error.message}`);
    btn.disabled = false;
    btn.textContent = originalText;
    return;
  }

  const draftIds = (client.client_proposals || [])
    .filter(cp => cp.status === 'draft')
    .map(cp => cp.id);

  if (draftIds.length > 0) {
    await supabase
      .from('client_proposals')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .in('id', draftIds);
  }

  showStatus('success', `Login link sent to ${client.email}. They'll receive an email from tim@mcmullen.properties with a sign-in link.`);
  btn.disabled = false;
  btn.textContent = 'Resend login link';

  await loadClients();
  await loadEngagement();
  render();
}

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 8a — Edit Client modal (replaces the old prompt() chain)
// ═══════════════════════════════════════════════════════════════════════════

function ensureEditModalStyles() {
  if (document.getElementById('ace-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'ace-modal-styles';
  style.textContent = `
    .ace-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(26, 31, 46, 0.55);
      display: none; align-items: flex-start; justify-content: center;
      padding: 56px 20px 20px;
      overflow-y: auto;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      animation: aceFade 0.18s ease-out;
    }
    @keyframes aceFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes aceSlide { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .ace-modal {
      background: #fff; border-radius: 14px;
      max-width: 540px; width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);
      animation: aceSlide 0.22s ease-out;
      color: #353535; overflow: hidden;
      display: flex; flex-direction: column;
      position: relative;
    }
    .ace-head { padding: 22px 28px 16px; border-bottom: 1px solid #e8e6dd; }
    .ace-eyebrow {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px; letter-spacing: 0.18em;
      color: #5d7e69; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 600;
    }
    .ace-title { font-size: 20px; font-weight: 600; letter-spacing: -0.012em; margin: 0; }
    .ace-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px;
      background: transparent; border: 0; cursor: pointer;
      font-size: 18px; color: #888;
      border-radius: 6px; transition: background 0.12s, color 0.12s;
    }
    .ace-close:hover { background: #f4f4ef; color: #353535; }
    .ace-body { padding: 22px 28px; }
    .ace-warn {
      background: #fff7e6; color: #7a5a10;
      border-left: 3px solid #c5a050;
      padding: 10px 14px; border-radius: 6px;
      font-size: 12px; line-height: 1.55;
      margin-bottom: 16px;
    }
    .ace-error {
      background: #fbeeee; color: #b91c1c;
      border-left: 3px solid #b91c1c;
      padding: 10px 14px; border-radius: 6px;
      font-size: 13px; line-height: 1.5;
      margin-bottom: 14px;
    }
    .ace-error.hidden { display: none; }
    .ace-field { margin-bottom: 14px; }
    .ace-field label {
      display: block;
      font-size: 11px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: #888; margin-bottom: 5px;
    }
    .ace-field input, .ace-field textarea {
      width: 100%; font-family: inherit;
      font-size: 14px; padding: 9px 12px;
      border: 1px solid #d4cfc0; border-radius: 6px;
      background: #fff; color: #353535;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .ace-field textarea { min-height: 70px; resize: vertical; }
    .ace-field input:focus, .ace-field textarea:focus {
      outline: none; border-color: #5d7e69;
      box-shadow: 0 0 0 3px #e8eee9;
    }
    .ace-row { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
    .ace-foot {
      padding: 16px 28px; border-top: 1px solid #e8e6dd;
      display: flex; justify-content: flex-end; gap: 10px;
      background: #faf8f3;
    }
    .ace-btn {
      font: inherit; font-size: 14px; font-weight: 600;
      padding: 9px 18px; border-radius: 8px;
      border: 1px solid transparent; cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s, opacity 0.15s;
    }
    .ace-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .ace-cancel { background: #fff; color: #353535; border-color: #d4cfc0; }
    .ace-cancel:hover:not(:disabled) { background: #f4f4ef; border-color: #888; }
    .ace-save { background: #5d7e69; color: #fff; box-shadow: 0 4px 12px rgba(93, 126, 105, 0.22); }
    .ace-save:hover:not(:disabled) { background: #4a6654; transform: translateY(-1px); }
  `;
  document.head.appendChild(style);
}

let _editOverlay = null;
let _editClientId = null;

function buildEditModal() {
  const overlay = document.createElement('div');
  overlay.id = 'aceOverlay';
  overlay.className = 'ace-overlay';
  overlay.innerHTML = `
    <div class="ace-modal" role="dialog" aria-modal="true" aria-labelledby="aceTitle">
      <button type="button" class="ace-close" aria-label="Close">×</button>
      <div class="ace-head">
        <div class="ace-eyebrow">Edit client</div>
        <h2 id="aceTitle" class="ace-title">Update contact details</h2>
      </div>
      <div class="ace-body">
        <div class="ace-warn hidden" id="aceWarn"></div>
        <div class="ace-error hidden" id="aceErr"></div>
        <div class="ace-field">
          <label>Full name</label>
          <input type="text" id="aceName" autocomplete="off">
        </div>
        <div class="ace-field">
          <label>Email <span style="text-transform:none; font-weight:400; color:#aaa;">(must be unique)</span></label>
          <input type="email" id="aceEmail" autocomplete="off">
        </div>
        <div class="ace-row">
          <div class="ace-field">
            <label>Phone</label>
            <input type="tel" id="acePhone" autocomplete="off">
          </div>
          <div class="ace-field">
            <label>&nbsp;</label>
            <input type="text" id="aceUnusedSpacer" disabled style="visibility:hidden;">
          </div>
        </div>
        <div class="ace-field">
          <label>Address</label>
          <input type="text" id="aceAddress" autocomplete="off">
        </div>
        <div class="ace-field">
          <label>Notes</label>
          <textarea id="aceNotes" autocomplete="off"></textarea>
        </div>
      </div>
      <div class="ace-foot">
        <button type="button" class="ace-btn ace-cancel" id="aceCancel">Cancel</button>
        <button type="button" class="ace-btn ace-save" id="aceSave">Save changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEditClientModal(); });
  overlay.querySelector('.ace-close').addEventListener('click', closeEditClientModal);
  overlay.querySelector('#aceCancel').addEventListener('click', closeEditClientModal);
  overlay.querySelector('#aceSave').addEventListener('click', submitEditClient);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _editOverlay && _editOverlay.style.display !== 'none') {
      closeEditClientModal();
    }
  });

  return overlay;
}

function openEditClientModal(client) {
  if (!_editOverlay) _editOverlay = buildEditModal();
  _editClientId = client.id;

  _editOverlay.querySelector('#aceName').value = client.name || '';
  _editOverlay.querySelector('#aceEmail').value = client.email || '';
  _editOverlay.querySelector('#acePhone').value = client.phone || '';
  _editOverlay.querySelector('#aceAddress').value = client.address || '';
  _editOverlay.querySelector('#aceNotes').value = client.notes || '';

  const warn = _editOverlay.querySelector('#aceWarn');
  if (client.user_id) {
    warn.innerHTML = `<strong>Heads up:</strong> ${escapeHtml(client.name)} has already signed in. Changing their email here updates contact info but does <em>not</em> change their auth login — they will keep signing in with their previous email.`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }

  const err = _editOverlay.querySelector('#aceErr');
  err.classList.add('hidden');
  err.textContent = '';

  const saveBtn = _editOverlay.querySelector('#aceSave');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save changes';

  _editOverlay.style.display = 'flex';
  setTimeout(() => _editOverlay.querySelector('#aceName').focus(), 50);
}

function closeEditClientModal() {
  if (_editOverlay) _editOverlay.style.display = 'none';
  _editClientId = null;
}

async function submitEditClient() {
  if (!_editClientId) return;
  const saveBtn = _editOverlay.querySelector('#aceSave');
  const err = _editOverlay.querySelector('#aceErr');
  err.classList.add('hidden');

  const name = _editOverlay.querySelector('#aceName').value.trim();
  const email = _editOverlay.querySelector('#aceEmail').value.trim().toLowerCase();
  const phone = _editOverlay.querySelector('#acePhone').value.trim();
  const address = _editOverlay.querySelector('#aceAddress').value.trim();
  const notes = _editOverlay.querySelector('#aceNotes').value.trim();

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
      name,
      email,
      phone: phone || null,
      address: address || null,
      notes: notes || null,
    })
    .eq('id', _editClientId);

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

  closeEditClientModal();
  showStatus('success', 'Client updated.');
  await loadClients();
  await loadEngagement();
  render();
}

async function handleDeleteClient(client) {
  const count = (client.client_proposals || []).length;
  const msg = count > 0
    ? `Remove ${client.name}? This will also unassign ${count} proposal${count === 1 ? '' : 's'}. The proposals themselves won't be deleted. This can't be undone.`
    : `Remove ${client.name}? This can't be undone.`;
  if (!confirm(msg)) return;

  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('id', client.id);

  if (error) return showStatus('error', `Could not remove: ${error.message}`);
  showStatus('success', `Removed ${client.name}.`);
  ctx.expandedIds.delete(client.id);
  await loadClients();
  await loadEngagement();
  render();
}

async function handleMarkComplete(referralId, btn) {
  if (!confirm('Mark this design appointment as complete? This will award $500 credit to the referrer (capped at $2,500 total).')) return;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Marking…';

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    showStatus('error', 'Session expired. Please sign in again.');
    btn.disabled = false;
    btn.textContent = originalText;
    return;
  }

  try {
    const r = await fetch('/api/mark-appointment-completed', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({ referral_id: referralId }),
    });
    const data = await r.json();

    if (!r.ok) {
      showStatus('error', data.error || `API returned ${r.status}`);
      btn.disabled = false;
      btn.textContent = originalText;
      return;
    }

    const newBalance = '$' + (Number(data.new_credit_cents || 0) / 100).toFixed(0);
    const referrerName = data.referrer_name || 'the referrer';
    const msg = data.credit_awarded
      ? `Appointment complete! $500 credit added — ${referrerName} now at ${newBalance}.`
      : `Appointment complete. ${referrerName} is at the $2,500 cap, so no additional credit was added.`;
    showStatus('success', msg);

    await loadClients();
    await loadEngagement();
    render();
  } catch (err) {
    showStatus('error', `Network error: ${err.message}`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Slug / address helpers ─────────────────────────────────────────────────
function parseSlugSortKey(slug) {
  if (!slug) return { date: '', version: 0 };
  const match = String(slug).match(/(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?$/);
  if (!match) return { date: '', version: 0 };
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    version: parseInt(match[4] || '1', 10),
  };
}

function getLatestSlug(proposal) {
  const pubs = proposal?.published_proposals;
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  const sorted = [...pubs].sort((a, b) => {
    const ka = parseSlugSortKey(a.slug);
    const kb = parseSlugSortKey(b.slug);
    if (kb.date !== ka.date) return kb.date.localeCompare(ka.date);
    return kb.version - ka.version;
  });
  return sorted[0]?.slug || null;
}

function getDisplayAddress(proposal) {
  if (proposal?.address) return proposal.address;
  const slug = getLatestSlug(proposal);
  if (slug) {
    const stripped = slug.replace(/-\d{4}-\d{2}-\d{2}(-\d+)?$/, '');
    if (stripped) {
      return stripped
        .split('-')
        .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
        .join(' ');
    }
  }
  return 'Untitled proposal';
}

// ── Utils ──────────────────────────────────────────────────────────────────
function showStatus(type, msg) {
  statusBox.className = `status visible ${type}`;
  statusBox.textContent = msg;
  statusBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (type === 'success') {
    setTimeout(() => {
      if (statusBox.textContent === msg) {
        statusBox.className = 'status';
        statusBox.textContent = '';
      }
    }, 5000);
  }
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}
