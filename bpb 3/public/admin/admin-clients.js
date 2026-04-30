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
//   - Phase 4.0c R2+: list sent referrals + mark appointment complete
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
  clients: [],     // [{ ...client, proposals: [...], sent_referrals: [...] }]
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
  // Load clients with nested client_proposals → proposals → published_proposals,
  // PLUS each client's outgoing referrals (where they are referrer_client_id).
  // The `sent_referrals:referrals!referrer_client_id` syntax disambiguates the
  // FK because referrals has both referrer_client_id and referred_client_id.
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
          published_proposals (id, slug)
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
  // For the "assign proposal" dropdown on each client row.
  // Pull published_proposals so we can show a slug-derived label when address is NULL.
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

  const referralCount = (client.sent_referrals || []).length;
  const referralBadge = referralCount > 0
    ? `<span class="badge proposals" style="background:#fff4d4;color:#7a5a10;">${referralCount} referral${referralCount === 1 ? '' : 's'}</span>`
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
      </div>
      <div style="display:flex; gap:6px;">
        ${viewButton}
        <button class="btn btn-small btn-danger unassign-btn" data-assignment-id="${escapeAttr(a.id)}">Unassign</button>
      </div>
    </div>
  `;
}

// ── Phase 4.0c Round 2+: referrals section ─────────────────────────────────
function renderReferralsSection(client) {
  const referrals = client.sent_referrals || [];
  const creditCents = Number(client.referral_credit_cents || 0);
  const usedCents   = Number(client.referral_credit_used_cents || 0);
  const cap         = 250000; // $2500
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

  // Status pill
  const pillStyles = {
    sent:      { bg: '#eef3f8', fg: '#2b4a73', label: 'Invite sent' },
    scheduled: { bg: '#fff4d4', fg: '#7a5a10', label: 'Appt scheduled' },
    completed: { bg: '#e8eee9', fg: '#4a6654', label: 'Complete (cap reached)' },
    credited:  { bg: '#e8eee9', fg: '#4a6654', label: '✓ Credited $500' },
  };
  const pill = pillStyles[status] || { bg: '#f0f0f0', fg: '#666', label: status };

  // Mark-complete button: show only when status is 'sent' or 'scheduled'.
  // The API enforces ownership; if the caller doesn't own this client's referrals
  // they'll get a clean 403 and the showStatus error will explain.
  const showButton = status === 'sent' || status === 'scheduled';
  const button = showButton
    ? `<button class="btn btn-small mark-complete-btn" data-referral-id="${escapeAttr(referral.id)}">Mark appt complete</button>`
    : '';

  // Date line: prefer the most recent meaningful timestamp
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

  // Toggle expand on row click (but not when clicking buttons/links/selects)
  card.querySelector('.client-row').addEventListener('click', (e) => {
    if (e.target.closest('button, select, a, input, textarea')) return;
    if (ctx.expandedIds.has(client.id)) {
      ctx.expandedIds.delete(client.id);
    } else {
      ctx.expandedIds.add(client.id);
    }
    card.classList.toggle('expanded');
  });

  // Assign
  card.querySelector('.assign-btn')?.addEventListener('click', async () => {
    const sel = card.querySelector('.assign-select');
    const proposalId = sel.value;
    if (!proposalId) return;
    await handleAssignProposal(client.id, proposalId);
  });

  // Send login link
  card.querySelector('.send-link-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    await handleSendLoginLink(client, btn);
  });

  // Edit
  card.querySelector('.edit-btn')?.addEventListener('click', () => {
    handleEditClient(client);
  });

  // Delete
  card.querySelector('.delete-btn')?.addEventListener('click', () => {
    handleDeleteClient(client);
  });

  // Unassign individual proposals
  card.querySelectorAll('.unassign-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const assignmentId = e.currentTarget.dataset.assignmentId;
      await handleUnassign(assignmentId);
    });
  });

  // Mark referral appointment complete (Phase 4.0c R2+)
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

  // Update all client_proposals in status='draft' to 'sent'
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
  render();
}

async function handleEditClient(client) {
  const newNameVal = prompt('Full name:', client.name);
  if (newNameVal === null) return;
  const newPhoneVal = prompt('Phone:', client.phone || '');
  if (newPhoneVal === null) return;
  const newAddressVal = prompt('Address:', client.address || '');
  if (newAddressVal === null) return;
  const newNotesVal = prompt('Notes:', client.notes || '');
  if (newNotesVal === null) return;

  const { error } = await supabase
    .from('clients')
    .update({
      name: newNameVal.trim() || client.name,
      phone: newPhoneVal.trim() || null,
      address: newAddressVal.trim() || null,
      notes: newNotesVal.trim() || null,
    })
    .eq('id', client.id);

  if (error) return showStatus('error', `Could not update: ${error.message}`);
  showStatus('success', 'Client updated.');
  await loadClients();
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
  render();
}

// Phase 4.0c R2+: mark referral's design appointment complete via the API.
// The API enforces auth (designer/master role) + ownership (clients.created_by
// === auth.uid()) + atomic credit award. Browser-side just orchestrates.
async function handleMarkComplete(referralId, btn) {
  if (!confirm('Mark this design appointment as complete? This will award $500 credit to the referrer (capped at $2,500 total).')) return;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Marking…';

  // Get fresh JWT for the API call
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
    render();
  } catch (err) {
    showStatus('error', `Network error: ${err.message}`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Slug / address helpers ─────────────────────────────────────────────────
// A proposals row can have many published_proposals (one per publish event).
// published_proposals doesn't have created_at, but the slug itself encodes
// the date and version: "1728-whitham-ave-2026-04-22-3" = April 22, v3.
// We parse those out to sort reliably, including when version > 9.
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

// Display name for a proposal — falls back through:
//   1. proposals.address (preferred, human-edited)
//   2. the latest slug, cleaned up ("1728-whitham-ave-2026-04-21-3" → "1728 Whitham Ave")
//   3. "Untitled proposal"
function getDisplayAddress(proposal) {
  if (proposal?.address) return proposal.address;
  const slug = getLatestSlug(proposal);
  if (slug) {
    // Strip a trailing YYYY-MM-DD(-N) and convert dashes → spaces, title-case.
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
