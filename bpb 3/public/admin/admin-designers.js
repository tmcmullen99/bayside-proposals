// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-designers.js — Phase 5B Part 1
//
// Master-only UI for managing internal staff (master + designer profiles).
//
// Capabilities:
//   - List all profiles (active and inactive)
//   - Edit display_name inline
//   - Toggle is_active (deactivates the account; doesn't delete it)
//   - Change role between master ⇄ designer (with confirmation)
//   - Invite a new designer via /api/invite-designer
//
// Auth model:
//   requireMaster() guards the page entirely. RLS on profiles already
//   restricts SELECT/INSERT/UPDATE/DELETE to is_master() so direct supabase
//   client calls work without going through an API.
//
// Self-protection:
//   The currently-signed-in master cannot demote themselves or deactivate
//   themselves — buttons are disabled with a tooltip explaining why. This
//   prevents accidentally locking yourself out, which is hard to recover
//   from without database access.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireMaster, getCurrentSession } from '/js/auth-util.js';

// ───────────────────────────────────────────────────────────────────────────
// State
// ───────────────────────────────────────────────────────────────────────────

const ctx = {
  self: null,        // { user, profile } — the current signed-in master
  profiles: [],      // all profile rows
  searchTerm: '',
  editingId: null,   // id of profile whose display_name is being edited
};

// ───────────────────────────────────────────────────────────────────────────
// DOM
// ───────────────────────────────────────────────────────────────────────────

const loadingState = document.getElementById('loadingState');
const designersList = document.getElementById('designersList');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('searchInput');
const counter = document.getElementById('counter');
const statusBox = document.getElementById('status');

const inviteBtn = document.getElementById('inviteBtn');
const inviteModal = document.getElementById('inviteModal');
const inviteEmail = document.getElementById('inviteEmail');
const inviteName = document.getElementById('inviteName');
const inviteRole = document.getElementById('inviteRole');
const inviteSendBtn = document.getElementById('inviteSendBtn');
const inviteCancelBtn = document.getElementById('inviteCancelBtn');
const inviteCancelX = document.getElementById('inviteCancelX');

// ───────────────────────────────────────────────────────────────────────────
// Bootstrap
// ───────────────────────────────────────────────────────────────────────────

(async function init() {
  // requireMaster handles redirect-to-login + master-only check.
  ctx.self = await requireMaster();
  if (!ctx.self) return;

  await loadProfiles();
  attachListeners();
})();

async function loadProfiles() {
  loadingState.style.display = 'block';
  designersList.style.display = 'none';
  emptyState.style.display = 'none';

  // RLS allows masters to SELECT all rows including inactive ones.
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, display_name, role, is_active, created_at, updated_at')
    .order('role', { ascending: true })       // master first
    .order('is_active', { ascending: false }) // active before inactive
    .order('email', { ascending: true });

  if (error) {
    showStatus('error', `Could not load staff: ${error.message}`);
    ctx.profiles = [];
    loadingState.style.display = 'none';
    return;
  }

  ctx.profiles = data || [];
  render();
}

// ───────────────────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────────────────

function render() {
  loadingState.style.display = 'none';

  const term = ctx.searchTerm;
  const visible = term
    ? ctx.profiles.filter(p =>
        (p.email || '').toLowerCase().includes(term)
        || (p.display_name || '').toLowerCase().includes(term)
      )
    : ctx.profiles;

  counter.textContent = `${visible.length} of ${ctx.profiles.length} staff`;

  if (ctx.profiles.length === 0) {
    emptyState.style.display = 'block';
    designersList.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  designersList.style.display = 'grid';
  designersList.innerHTML = visible.map(renderCard).join('');
  wireRowHandlers();
}

function renderCard(profile) {
  const isMaster = profile.role === 'master';
  const isSelf = profile.id === ctx.self.user.id;
  const isEditing = ctx.editingId === profile.id;

  const initials = (profile.display_name || profile.email || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(s => s.charAt(0).toUpperCase())
    .join('') || '?';

  const cardClass = [
    'designer-card',
    isMaster ? 'is-master' : '',
    profile.is_active === false ? 'is-inactive' : '',
  ].filter(Boolean).join(' ');

  const nameCell = isEditing
    ? `<input type="text" class="display-name-edit"
              value="${escapeAttr(profile.display_name || '')}"
              data-name-input="${escapeAttr(profile.id)}"
              maxlength="80"
              placeholder="Display name">`
    : `<div class="display-name" data-name-display="${escapeAttr(profile.id)}">${escapeHtml(profile.display_name || '(no name set)')}</div>`;

  const selfBanner = isSelf ? '<span class="self-banner">You</span>' : '';
  const meta = profile.created_at
    ? `Joined ${formatDate(profile.created_at)}`
    : '';

  // Active toggle. Disabled for self to prevent self-lockout.
  const toggleClass = isSelf ? 'active-toggle is-disabled' : 'active-toggle';
  const toggleTitle = isSelf
    ? "Can't deactivate yourself"
    : (profile.is_active === false ? 'Click to reactivate' : 'Click to deactivate');
  const toggleEl = `
    <label class="${toggleClass}" title="${escapeAttr(toggleTitle)}">
      <input type="checkbox" data-toggle-active="${escapeAttr(profile.id)}"
             ${profile.is_active === false ? '' : 'checked'}
             ${isSelf ? 'disabled' : ''}>
      <span>${profile.is_active === false ? 'Inactive' : 'Active'}</span>
    </label>
  `;

  // Action buttons
  const editBtn = isEditing
    ? `<button class="btn btn-small" data-save-name="${escapeAttr(profile.id)}">Save</button>
       <button class="btn btn-small btn-secondary" data-cancel-edit="${escapeAttr(profile.id)}">Cancel</button>`
    : `<button class="btn btn-small btn-secondary" data-edit-name="${escapeAttr(profile.id)}">Edit name</button>`;

  // Role swap button. Disabled for self to prevent self-demotion.
  const roleBtnLabel = isMaster ? 'Demote to designer' : 'Promote to master';
  const roleBtnTitle = isSelf ? "Can't change your own role" : roleBtnLabel;
  const roleBtn = `<button class="btn btn-small btn-secondary"
                            data-toggle-role="${escapeAttr(profile.id)}"
                            ${isSelf ? 'disabled' : ''}
                            title="${escapeAttr(roleBtnTitle)}">${escapeHtml(roleBtnLabel)}</button>`;

  // Delete button. Disabled for self.
  const deleteBtn = `<button class="btn btn-small btn-danger"
                              data-delete="${escapeAttr(profile.id)}"
                              ${isSelf ? 'disabled' : ''}
                              title="${escapeAttr(isSelf ? "Can't delete yourself" : 'Permanently delete this account')}">Remove</button>`;

  return `
    <div class="${cardClass}" data-row-id="${escapeAttr(profile.id)}">
      <div class="avatar ${isMaster ? 'is-master' : ''}">${escapeHtml(initials)}</div>
      <div class="name-block">
        ${nameCell}
        <div class="email">${escapeHtml(profile.email || '')}</div>
      </div>
      <div class="meta">
        ${selfBanner}
        ${meta ? ` <span>${escapeHtml(meta)}</span>` : ''}
      </div>
      <span class="role-pill ${isMaster ? 'is-master' : 'is-designer'}">${isMaster ? 'Master' : 'Designer'}</span>
      ${toggleEl}
      <div class="row-actions">
        ${editBtn}
        ${roleBtn}
        ${deleteBtn}
      </div>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Wiring
// ───────────────────────────────────────────────────────────────────────────

function attachListeners() {
  searchInput.addEventListener('input', (e) => {
    ctx.searchTerm = e.target.value.trim().toLowerCase();
    render();
  });

  inviteBtn.addEventListener('click', openInviteModal);
  inviteCancelBtn.addEventListener('click', closeInviteModal);
  inviteCancelX.addEventListener('click', closeInviteModal);
  inviteModal.addEventListener('click', (e) => {
    if (e.target === inviteModal) closeInviteModal();
  });
  inviteSendBtn.addEventListener('click', handleInviteSend);
}

function wireRowHandlers() {
  designersList.querySelectorAll('[data-edit-name]').forEach(btn => {
    btn.addEventListener('click', () => {
      ctx.editingId = btn.getAttribute('data-edit-name');
      render();
      // Focus the new input
      const input = designersList.querySelector(`[data-name-input="${ctx.editingId}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    });
  });

  designersList.querySelectorAll('[data-cancel-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      ctx.editingId = null;
      render();
    });
  });

  designersList.querySelectorAll('[data-save-name]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-save-name');
      const input = designersList.querySelector(`[data-name-input="${id}"]`);
      if (!input) return;
      await handleSaveName(id, input.value.trim());
    });
  });

  // Save on Enter, cancel on Escape inside the name input
  designersList.querySelectorAll('[data-name-input]').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const id = input.getAttribute('data-name-input');
        handleSaveName(id, input.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        ctx.editingId = null;
        render();
      }
    });
  });

  designersList.querySelectorAll('[data-toggle-active]').forEach(input => {
    input.addEventListener('change', async () => {
      const id = input.getAttribute('data-toggle-active');
      const newActive = input.checked;
      await handleToggleActive(id, newActive, input);
    });
  });

  designersList.querySelectorAll('[data-toggle-role]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-toggle-role');
      handleToggleRole(id);
    });
  });

  designersList.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-delete');
      handleDelete(id);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Actions
// ───────────────────────────────────────────────────────────────────────────

async function handleSaveName(id, newName) {
  if (newName.length === 0) {
    showStatus('error', 'Display name is required.');
    return;
  }
  if (newName.length > 80) {
    showStatus('error', 'Display name too long (max 80 chars).');
    return;
  }

  const profile = ctx.profiles.find(p => p.id === id);
  if (!profile) return;
  if (newName === (profile.display_name || '')) {
    // No change; just exit edit mode
    ctx.editingId = null;
    render();
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({ display_name: newName })
    .eq('id', id);

  if (error) {
    showStatus('error', `Could not update name: ${error.message}`);
    return;
  }

  profile.display_name = newName;
  ctx.editingId = null;
  showStatus('success', `Updated name to "${newName}".`);
  render();
}

async function handleToggleActive(id, newActive, inputEl) {
  const profile = ctx.profiles.find(p => p.id === id);
  if (!profile) return;
  if (profile.id === ctx.self.user.id) return; // belt + suspenders

  // Optimistic; revert on error
  const prevActive = profile.is_active;

  const { error } = await supabase
    .from('profiles')
    .update({ is_active: newActive })
    .eq('id', id);

  if (error) {
    showStatus('error', `Could not toggle active: ${error.message}`);
    // Revert checkbox
    inputEl.checked = prevActive !== false;
    return;
  }

  profile.is_active = newActive;
  showStatus('success',
    `${profile.display_name || profile.email} is now ${newActive ? 'active' : 'inactive'}.`);
  render();
}

async function handleToggleRole(id) {
  const profile = ctx.profiles.find(p => p.id === id);
  if (!profile) return;
  if (profile.id === ctx.self.user.id) return;

  const newRole = profile.role === 'master' ? 'designer' : 'master';
  const verb = newRole === 'master' ? 'PROMOTE to master' : 'DEMOTE to designer';
  const consequence = newRole === 'master'
    ? 'They will gain full access to every admin tool, including catalog sync, JobNimbus probe, bulk republish, and this designers page.'
    : 'They will lose access to master-only tools (catalog sync, JobNimbus, bulk republish, this page).';

  if (!confirm(`${verb} ${profile.display_name || profile.email}?\n\n${consequence}\n\nClick OK to confirm.`)) {
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({ role: newRole })
    .eq('id', id);

  if (error) {
    showStatus('error', `Could not change role: ${error.message}`);
    return;
  }

  profile.role = newRole;
  showStatus('success',
    `${profile.display_name || profile.email} is now a ${newRole}.`);
  render();
}

async function handleDelete(id) {
  const profile = ctx.profiles.find(p => p.id === id);
  if (!profile) return;
  if (profile.id === ctx.self.user.id) return;

  if (!confirm(
    `Permanently remove ${profile.display_name || profile.email}?\n\n` +
    `This deletes their profiles row. Their auth.users record stays in Supabase ` +
    `(deleting that requires the dashboard). Recommended: deactivate instead, ` +
    `which preserves the audit trail.`
  )) {
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .delete()
    .eq('id', id);

  if (error) {
    showStatus('error', `Could not delete: ${error.message}`);
    return;
  }

  ctx.profiles = ctx.profiles.filter(p => p.id !== id);
  showStatus('success', `Removed ${profile.display_name || profile.email}.`);
  render();
}

// ───────────────────────────────────────────────────────────────────────────
// Invite flow
// ───────────────────────────────────────────────────────────────────────────

function openInviteModal() {
  inviteEmail.value = '';
  inviteName.value = '';
  inviteRole.value = 'designer';
  inviteSendBtn.disabled = false;
  inviteSendBtn.textContent = 'Send invite';
  inviteModal.style.display = 'flex';
  setTimeout(() => inviteEmail.focus(), 60);
}

function closeInviteModal() {
  inviteModal.style.display = 'none';
}

async function handleInviteSend() {
  const email = inviteEmail.value.trim().toLowerCase();
  const display_name = inviteName.value.trim();
  const role = inviteRole.value;

  if (!email || !email.includes('@')) {
    showStatus('error', 'Valid email is required.');
    return;
  }
  if (!display_name) {
    showStatus('error', 'Display name is required.');
    return;
  }
  if (role !== 'designer' && role !== 'master') {
    showStatus('error', 'Invalid role.');
    return;
  }

  inviteSendBtn.disabled = true;
  inviteSendBtn.textContent = 'Sending…';

  const session = await getCurrentSession();
  if (!session) {
    showStatus('error', 'Session expired. Refresh the page and sign in again.');
    inviteSendBtn.disabled = false;
    inviteSendBtn.textContent = 'Send invite';
    return;
  }

  try {
    const r = await fetch('/api/invite-designer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({ email, display_name, role }),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok && r.status !== 207) {
      showStatus('error', data.error || `Invite failed (HTTP ${r.status}).`);
      inviteSendBtn.disabled = false;
      inviteSendBtn.textContent = 'Send invite';
      return;
    }

    if (r.status === 207) {
      showStatus('error',
        `Invite sent but profile setup failed: ${data.error}. ` +
        `You may need to manually fix the profile via SQL.`);
    } else {
      showStatus('success',
        `Invited ${display_name} (${email}) as ${role}. They'll receive a magic-link email.`);
    }

    closeInviteModal();
    await loadProfiles();
  } catch (err) {
    showStatus('error', `Network error: ${err.message || String(err)}`);
    inviteSendBtn.disabled = false;
    inviteSendBtn.textContent = 'Send invite';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────

let statusTimer = null;
function showStatus(kind, msg) {
  statusBox.className = `status visible ${kind}`;
  statusBox.textContent = msg;
  statusBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  clearTimeout(statusTimer);
  if (kind === 'success') {
    statusTimer = setTimeout(() => {
      if (statusBox.textContent === msg) {
        statusBox.className = 'status';
        statusBox.textContent = '';
      }
    }, 5000);
  }
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
