// ═══════════════════════════════════════════════════════════════════════════
// admin-clients.js
// Admin client management — Tim's interface for managing clients.
//
// Auth: requireAdmin() at the top redirects non-admins away.
//
// Actions:
//   - List/search clients (with JOIN to proposal counts)
//   - Add new client (name, email, phone, address, notes)
//   - Expand client row → show assigned proposals + assign new one
//   - Send magic-link invite (Supabase signInWithOtp with client's email)
//   - Remove client (cascades to client_proposals via FK)
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireAdmin, sendMagicLink, signOut } from '/js/auth-util.js';

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
const signOutBtn = document.getElementById('signOutBtn');

// State
const ctx = {
  admin: null,
  clients: [],     // [{ ...client, proposals: [...] }]
  proposals: [],   // all proposals (for the assign dropdown)
  expandedIds: new Set(),
  searchTerm: '',
};

// ── Bootstrap ──────────────────────────────────────────────────────────────
(async function init() {
  ctx.admin = await requireAdmin();
  if (!ctx.admin) return; // redirected

  await Promise.all([loadClients(), loadAllProposals()]);
  render();
  attachEventListeners();
})();

async function loadClients() {
  // Load clients with nested client_proposals → proposals → published_proposals.
  // The slug lives on published_proposals (a given proposal can have many versions);
  // we pull them all and pick the latest in getLatestSlug().
  const { data, error } = await supabase
    .from('clients')
    .select(`
      id, name, email, phone, address, notes, user_id, created_at,
      client_proposals (
        id, status, sent_at, first_viewed_at, signed_at, created_at,
        proposal:proposals!proposal_id (
          id,
          address,
          published_proposals (id, slug, created_at)
        )
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
  // For the "assign proposal" dropdown on each client row.
  // Pull published_proposals so we can show a slug-derived label when address is NULL.
  const { data, error } = await supabase
    .from('proposals')
    .select(`
      id, address, created_at,
      published_proposals (id, slug, created_at)
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

  signOutBtn.addEventListener('click', signOut);
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
  clientsList.innerHTML = visible.map(renderClientCard).join('');

  // Wire up per-card handlers
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
        </div>
        <div class="client-badges">
          ${linkedBadge}
          ${proposalBadge}
          <span class="client-chevron">›</span>
        </div>
      </div>
      <div class="client-expand">
        ${renderClientExpand(client)}
      </div>
    </div>
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

    <div class="expand-section">
      <h4>Client Actions</h4>
      <div class="actions-row">
        <button class="btn btn-small send-link-btn" data-client-id="${client.id}" data-email="${escapeAttr(client.email)}">
          ${client.user_id ? 'Resend login link' : 'Send login link'}
        </button>
        <button class="btn btn-small btn-secondary edit-btn" data-client-id="${client.id}">
          Edit client
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

  return `
    <div class="proposal-row">
      <div class="proposal-row-info">
        <div class="proposal-row-address">${escapeHtml(getDisplayAddress(p))}</div>
        <div class="proposal-row-meta">
          ${escapeHtml(statusLabel)}
          ${a.sent_at ? ` · Sent ${formatDate(a.sent_at)}` : ''}
          ${a.first_viewed_at ? ` · Viewed ${formatDate(a.first_viewed_at)}` : ''}
        </div>
