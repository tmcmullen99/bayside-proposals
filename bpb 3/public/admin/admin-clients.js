// ═══════════════════════════════════════════════════════════════════════════
// admin-clients.js
// Admin client management — Tim's interface for managing clients.
//
// Sprint 8a baseline + Sprint 10c update:
//   - Row click navigates to /admin/client.html?id=<uuid> (War Room)
//     instead of expanding inline. The chat drawer module from Sprint 10b
//     is still imported but no longer wired up — chat lives on the client
//     page now, not in a drawer.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireAdmin, sendMagicLink } from '/js/auth-util.js';
import { getProposalEngagementBulk, formatRelativeTime } from '/js/engagement-utils.js';

const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

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

const ctx = {
  admin: null,
  clients: [],
  proposals: [],
  engagement: new Map(),
  searchTerm: '',
};

(async function init() {
  ctx.admin = await requireAdmin();
  if (!ctx.admin) return;

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
    <div class="client-card" data-client-id="${client.id}">
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

// ── Event wiring (per-card, after render) ──────────────────────────────────
// Sprint 10c: row click navigates to dedicated client page (War Room).
function wireCardHandlers(client) {
  const card = clientsList.querySelector(`[data-client-id="${client.id}"]`);
  if (!card) return;

  card.querySelector('.client-row').addEventListener('click', (e) => {
    if (e.target.closest('button, select, a, input, textarea')) return;
    window.location.href = '/admin/client.html?id=' + encodeURIComponent(client.id);
  });
}

// ── Add Client ─────────────────────────────────────────────────────────────
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
  showStatus('success', `Added ${name}. Click their row to open their page.`);
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
