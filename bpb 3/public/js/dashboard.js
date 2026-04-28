// Dashboard — lists all proposals, creates new drafts, redirects to editor.
// Phase 2D: per-row delete with branded confirm modal.
import { supabase } from './supabase-client.js';

const content = document.getElementById('content');
const errorBox = document.getElementById('errorBox');
const newBtn = document.getElementById('newProposalBtn');

// ───────────────────────────────────────────────────────────────────────────
// Load and render proposals
// ───────────────────────────────────────────────────────────────────────────
async function loadProposals() {
  content.innerHTML = '<div class="loading">Loading proposals…</div>';
  errorBox.innerHTML = '';

  const { data, error } = await supabase
    .from('proposals')
    .select('id, client_name, project_address, project_city, proposal_type, status, bid_total_amount, updated_at, created_at')
    .order('updated_at', { ascending: false });

  if (error) {
    errorBox.innerHTML = `<div class="error-box">Failed to load proposals: ${escapeHtml(error.message)}</div>`;
    content.innerHTML = '';
    return;
  }

  if (!data || data.length === 0) {
    renderEmptyState();
    return;
  }

  renderTable(data);
}

function renderEmptyState() {
  content.innerHTML = `
    <div class="empty-state">
      <div class="headline">No proposals yet.</div>
      <div class="sub">Start a new proposal to upload a bid PDF, pick materials, and generate a finished Bayside page.</div>
      <button id="emptyNewBtn" class="btn primary">Create your first proposal →</button>
    </div>
  `;
  document.getElementById('emptyNewBtn').addEventListener('click', createProposal);
}

function renderTable(proposals) {
  const rows = proposals.map(p => {
    const displayName = p.client_name || '(unnamed draft)';
    const address = [p.project_address, p.project_city].filter(Boolean).join(', ') || '—';
    const status = p.status || 'draft';
    const typeLabel = p.proposal_type ? p.proposal_type.replace('_', ' ') : '—';
    const amount = p.bid_total_amount
      ? '$' + Number(p.bid_total_amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
      : '—';
    const updated = formatDate(p.updated_at || p.created_at);

    // data-id attribute on the row lets click handlers + delete handlers
    // know which proposal to act on without inline JS interpolation.
    return `
      <tr data-proposal-id="${escapeHtml(p.id)}" class="proposal-row" style="cursor: pointer;">
        <td>
          <div class="project-name">${escapeHtml(displayName)}</div>
          <div class="project-address">${escapeHtml(address)}</div>
        </td>
        <td><span class="status-badge ${status}">${status}</span></td>
        <td class="tnum" style="text-transform: capitalize;">${escapeHtml(typeLabel)}</td>
        <td class="tnum">${amount}</td>
        <td class="date">${updated}</td>
        <td class="row-actions">
          <button type="button" class="row-delete-btn" aria-label="Delete proposal" title="Delete proposal">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M2.5 4 H11.5 M5.5 4 V2.5 H8.5 V4 M3.5 4 L4 12 H10 L10.5 4"/>
            </svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  content.innerHTML = `
    <style>
      .row-actions { width: 44px; text-align: center; }
      .row-delete-btn {
        background: transparent; border: none; padding: 6px;
        border-radius: 6px; cursor: pointer;
        color: #b0b0b0;
        opacity: 0.6;
        transition: color 0.15s, background 0.15s, opacity 0.15s;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .proposal-row:hover .row-delete-btn { opacity: 1; }
      .row-delete-btn:hover { background: #fef2f2; color: #b91c1c; opacity: 1; }
      .row-delete-btn:focus-visible { outline: 2px solid #b91c1c; outline-offset: 1px; opacity: 1; }
      .proposal-row.deleting { opacity: 0.4; pointer-events: none; transition: opacity 0.2s; }
      .proposal-row.fading-out { opacity: 0; transition: opacity 0.3s; }
    </style>
    <table class="ledger">
      <thead>
        <tr>
          <th>Project</th>
          <th style="width: 120px;">Status</th>
          <th style="width: 140px;">Type</th>
          <th style="width: 120px;">Amount</th>
          <th style="width: 140px;">Updated</th>
          <th style="width: 44px;"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Wire up row click → open editor; delete button click → open modal.
  // Done after innerHTML so we don't have inline onclick attributes.
  content.querySelectorAll('.proposal-row').forEach(row => {
    const proposalId = row.dataset.proposalId;
    const matchingProposal = proposals.find(p => p.id === proposalId);

    row.addEventListener('click', () => {
      window.location.href = `/editor?id=${proposalId}`;
    });

    const delBtn = row.querySelector('.row-delete-btn');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // do not also trigger the row's navigate
      showDeleteModal(matchingProposal, row);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Delete confirm modal
// ───────────────────────────────────────────────────────────────────────────
let _deleteOverlay = null;

function showDeleteModal(proposal, rowEl) {
  // Build (or reuse) the overlay
  if (!_deleteOverlay) _deleteOverlay = buildDeleteModal();

  const displayName = proposal.client_name || '(unnamed draft)';
  const address = [proposal.project_address, proposal.project_city].filter(Boolean).join(', ');
  const amount = proposal.bid_total_amount
    ? '$' + Number(proposal.bid_total_amount).toLocaleString('en-US', { maximumFractionDigits: 0 })
    : null;

  // Populate the modal with this proposal's data
  _deleteOverlay.querySelector('.bpb-del-name').textContent = displayName;
  const addrEl = _deleteOverlay.querySelector('.bpb-del-addr');
  if (address) {
    addrEl.textContent = address + (amount ? ' · ' + amount : '');
    addrEl.style.display = '';
  } else if (amount) {
    addrEl.textContent = amount;
    addrEl.style.display = '';
  } else {
    addrEl.style.display = 'none';
  }

  // Reset state
  const errEl = _deleteOverlay.querySelector('.bpb-del-error');
  errEl.style.display = 'none';
  errEl.textContent = '';
  const confirmBtn = _deleteOverlay.querySelector('.bpb-del-confirm');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Yes, delete permanently';

  // Wire confirm to this specific proposal/row
  confirmBtn.onclick = () => deleteProposal(proposal, rowEl);

  _deleteOverlay.style.display = 'flex';
}

function closeDeleteModal() {
  if (_deleteOverlay) _deleteOverlay.style.display = 'none';
}

function buildDeleteModal() {
  const overlay = document.createElement('div');
  overlay.id = 'bpb-del-overlay';
  overlay.innerHTML =
    '<style>' +
    '#bpb-del-overlay {' +
    '  position: fixed; inset: 0; z-index: 10000;' +
    '  background: rgba(26, 31, 46, 0.55);' +
    '  display: none; align-items: center; justify-content: center;' +
    '  padding: 24px;' +
    "  font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;" +
    '  animation: bpbDelFade 0.18s ease-out;' +
    '}' +
    '@keyframes bpbDelFade { from { opacity: 0; } to { opacity: 1; } }' +
    '@keyframes bpbDelSlide { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }' +
    '.bpb-del-modal {' +
    '  background: #fff;' +
    '  border-radius: 16px;' +
    '  max-width: 460px; width: 100%;' +
    '  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.36);' +
    '  padding: 32px;' +
    '  animation: bpbDelSlide 0.22s ease-out;' +
    '  color: #353535;' +
    '}' +
    '.bpb-del-eyebrow {' +
    "  font-family: 'JetBrains Mono', ui-monospace, monospace;" +
    '  font-size: 11px; letter-spacing: 0.22em;' +
    '  color: #b91c1c; text-transform: uppercase;' +
    '  margin-bottom: 8px; font-weight: 600;' +
    '}' +
    '.bpb-del-title {' +
    '  font-size: 22px; font-weight: 600;' +
    '  color: #1a1f2e; letter-spacing: -0.012em;' +
    '  margin: 0 0 16px 0;' +
    '}' +
    '.bpb-del-target {' +
    '  background: #faf8f3;' +
    '  border-radius: 10px;' +
    '  padding: 14px 16px;' +
    '  margin-bottom: 20px;' +
    '}' +
    '.bpb-del-name { font-weight: 600; color: #1a1f2e; font-size: 15px; }' +
    '.bpb-del-addr { color: #666; font-size: 13px; margin-top: 4px; }' +
    '.bpb-del-warning {' +
    '  font-size: 13px; line-height: 1.6;' +
    '  color: #353535;' +
    '  margin-bottom: 24px;' +
    '}' +
    '.bpb-del-warning strong { color: #1a1f2e; }' +
    '.bpb-del-warning ul {' +
    '  margin: 8px 0 0 0; padding-left: 20px;' +
    '  color: #666; font-size: 12px;' +
    '}' +
    '.bpb-del-warning li { padding: 2px 0; }' +
    '.bpb-del-error {' +
    '  background: #fef2f2; color: #b91c1c;' +
    '  border: 1px solid #fecaca; border-radius: 8px;' +
    '  padding: 10px 14px; font-size: 13px;' +
    '  margin-bottom: 16px;' +
    '}' +
    '.bpb-del-actions {' +
    '  display: flex; gap: 10px; justify-content: flex-end;' +
    '}' +
    '.bpb-del-btn {' +
    '  padding: 11px 18px; border-radius: 10px;' +
    '  font: inherit; font-weight: 600; font-size: 14px;' +
    '  cursor: pointer; border: 1px solid transparent;' +
    '  transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.12s, opacity 0.15s;' +
    '}' +
    '.bpb-del-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }' +
    '.bpb-del-cancel {' +
    '  background: #fff; color: #353535;' +
    '  border-color: #e5e5e5;' +
    '}' +
    '.bpb-del-cancel:hover:not(:disabled) { background: #faf8f3; border-color: #353535; }' +
    '.bpb-del-confirm {' +
    '  background: #b91c1c; color: #fff;' +
    '  box-shadow: 0 6px 16px rgba(185, 28, 28, 0.22);' +
    '}' +
    '.bpb-del-confirm:hover:not(:disabled) { background: #991616; transform: translateY(-1px); }' +
    '@media (max-width: 480px) {' +
    '  .bpb-del-modal { padding: 24px 20px; }' +
    '  .bpb-del-actions { flex-direction: column-reverse; }' +
    '  .bpb-del-btn { width: 100%; }' +
    '}' +
    '</style>' +
    '<div class="bpb-del-modal" role="dialog" aria-modal="true" aria-labelledby="bpbDelTitle">' +
    '  <div class="bpb-del-eyebrow">Permanent action</div>' +
    '  <h2 id="bpbDelTitle" class="bpb-del-title">Delete this proposal?</h2>' +
    '  <div class="bpb-del-target">' +
    '    <div class="bpb-del-name"></div>' +
    '    <div class="bpb-del-addr"></div>' +
    '  </div>' +
    '  <div class="bpb-del-warning">' +
    '    <strong>This cannot be undone.</strong> Deleting will permanently remove:' +
    '    <ul>' +
    '      <li>All sections, materials, photos, regions, and site plan data</li>' +
    '      <li>Every published version (live <code>/p/&lt;slug&gt;</code> pages will 404)</li>' +
    '      <li>All signature intents from prospects</li>' +
    '    </ul>' +
    '  </div>' +
    '  <div class="bpb-del-error"></div>' +
    '  <div class="bpb-del-actions">' +
    '    <button type="button" class="bpb-del-btn bpb-del-cancel">Cancel</button>' +
    '    <button type="button" class="bpb-del-btn bpb-del-confirm">Yes, delete permanently</button>' +
    '  </div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Close interactions: click outside, Cancel button, ESC key
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDeleteModal();
  });
  overlay.querySelector('.bpb-del-cancel').addEventListener('click', closeDeleteModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _deleteOverlay && _deleteOverlay.style.display !== 'none') {
      closeDeleteModal();
    }
  });

  return overlay;
}

async function deleteProposal(proposal, rowEl) {
  const confirmBtn = _deleteOverlay.querySelector('.bpb-del-confirm');
  const cancelBtn = _deleteOverlay.querySelector('.bpb-del-cancel');
  const errEl = _deleteOverlay.querySelector('.bpb-del-error');

  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = 'Deleting…';
  errEl.style.display = 'none';

  // Optimistic: dim the row immediately so the user sees the action register
  rowEl.classList.add('deleting');

  // FK cascades handle children: proposal_sections, proposal_materials,
  // proposal_images, proposal_regions, proposal_region_materials,
  // proposal_sitemaps, published_proposals, signature_intents all
  // ON DELETE CASCADE off proposals.id (verified in Phase 2D planning).
  const { error } = await supabase
    .from('proposals')
    .delete()
    .eq('id', proposal.id);

  if (error) {
    // Restore row + show error inside modal (don't auto-close)
    rowEl.classList.remove('deleting');
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    confirmBtn.textContent = 'Yes, delete permanently';
    errEl.textContent = 'Delete failed: ' + (error.message || 'Unknown error');
    errEl.style.display = 'block';
    return;
  }

  // Success: close modal, fade row out, then remove from DOM
  closeDeleteModal();
  rowEl.classList.remove('deleting');
  rowEl.classList.add('fading-out');
  setTimeout(() => {
    rowEl.remove();
    // If the table is now empty, swap to the empty state
    if (!content.querySelector('.proposal-row')) {
      renderEmptyState();
    }
  }, 320);
}

// ───────────────────────────────────────────────────────────────────────────
// Create a new proposal draft and redirect to the editor
// ───────────────────────────────────────────────────────────────────────────
async function createProposal() {
  newBtn.disabled = true;
  const btnText = newBtn.textContent;
  newBtn.textContent = 'Creating…';

  const { data, error } = await supabase
    .from('proposals')
    .insert({
      status: 'draft',
      proposal_type: 'bid',
      project_state: 'CA'
    })
    .select('id')
    .single();

  if (error) {
    errorBox.innerHTML = `<div class="error-box">Could not create proposal: ${escapeHtml(error.message)}</div>`;
    newBtn.disabled = false;
    newBtn.textContent = btnText;
    return;
  }

  window.location.href = `/editor?id=${data.id}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  if (diffHours < 24 * 7) return `${Math.floor(diffHours / 24)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ───────────────────────────────────────────────────────────────────────────
// Wire up
// ───────────────────────────────────────────────────────────────────────────
newBtn.addEventListener('click', createProposal);
loadProposals();
