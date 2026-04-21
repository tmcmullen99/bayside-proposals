// Dashboard — lists all proposals, creates new drafts, redirects to editor.
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

    return `
      <tr onclick="window.location.href='/editor?id=${p.id}'" style="cursor: pointer;">
        <td>
          <div class="project-name">${escapeHtml(displayName)}</div>
          <div class="project-address">${escapeHtml(address)}</div>
        </td>
        <td><span class="status-badge ${status}">${status}</span></td>
        <td class="tnum" style="text-transform: capitalize;">${escapeHtml(typeLabel)}</td>
        <td class="tnum">${amount}</td>
        <td class="date">${updated}</td>
      </tr>
    `;
  }).join('');

  content.innerHTML = `
    <table class="ledger">
      <thead>
        <tr>
          <th>Project</th>
          <th style="width: 120px;">Status</th>
          <th style="width: 140px;">Type</th>
          <th style="width: 120px;">Amount</th>
          <th style="width: 140px;">Updated</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
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
