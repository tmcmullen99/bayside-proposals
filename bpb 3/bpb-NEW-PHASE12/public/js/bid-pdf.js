// ═══════════════════════════════════════════════════════════════════════════
// Bid PDF section.
//
// States: empty → parsing → review → committed (or → error).
//
// On upload: POST to /api/parse-bid-pdf, which forwards to Claude API.
// On commit: writes client info + bid totals to proposals, creates
// proposal_sections rows for each extracted scope section.
//
// On re-entry (if already committed), reads parsed_bid_data from the proposal
// row and jumps straight to the committed state.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

const state = {
  proposalId: null,
  container: null,
  onSave: null,
  phase: 'empty', // empty | parsing | review | committed | error
  parsed: null,
  error: null,
  editedClient: {}
};

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────
export async function initBidPdf({ proposalId, container, onSave }) {
  Object.assign(state, {
    proposalId,
    container,
    onSave,
    phase: 'empty',
    parsed: null,
    error: null,
    editedClient: {}
  });

  container.innerHTML = `<div class="mp-loading">Loading…</div>`;

  // If the proposal already has parsed bid data, jump to committed state
  const { data: proposal } = await supabase
    .from('proposals')
    .select('parsed_bid_data')
    .eq('id', proposalId)
    .single();

  if (proposal?.parsed_bid_data) {
    state.parsed = proposal.parsed_bid_data;
    state.phase = 'committed';
  }

  render();
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────
function render() {
  state.container.innerHTML = `
    <div class="section-header">
      <span class="eyebrow">Section 02</span>
      <h2>Bid PDF</h2>
      <p class="section-sub">Upload a JobNimbus bid PDF. Claude extracts the client info, scope sections, and totals — review, then commit.</p>
    </div>
    ${renderPhase()}
  `;
  attachEvents();
}

function renderPhase() {
  switch (state.phase) {
    case 'empty': return renderUploadZone();
    case 'parsing': return renderParsing();
    case 'review': return renderReview();
    case 'committed': return renderCommitted();
    case 'error': return renderError();
    default: return '';
  }
}

function renderUploadZone() {
  return `
    <div class="bp-upload-zone" id="uploadZone">
      <input type="file" id="pdfInput" accept="application/pdf" hidden>
      <div class="bp-upload-icon">📄</div>
      <div class="bp-upload-title">Drop a JobNimbus bid PDF</div>
      <div class="bp-upload-sub">or click to select · max 30 MB · extraction takes 10–30 seconds</div>
      <button class="btn primary" id="selectPdfBtn" type="button">Choose PDF</button>
    </div>
  `;
}

function renderParsing() {
  return `
    <div class="bp-parsing">
      <div class="bp-spinner"></div>
      <div class="bp-parsing-title">Parsing bid PDF…</div>
      <div class="bp-parsing-sub">Reading client info, scope sections, line items, and totals. Usually 10–30 seconds.</div>
    </div>
  `;
}

function renderReview() {
  const p = state.parsed || {};
  const client = { ...(p.client || {}), ...state.editedClient };
  const sections = p.sections || [];
  const totals = p.totals || {};
  const materials = p.materials_mentioned || [];

  return `
    <div class="bp-review">
      <div class="bp-review-header">
        <span class="eyebrow">Extracted · review before committing</span>
        <button class="btn ghost" id="resetBtn">← Start over</button>
      </div>

      <div class="bp-review-section">
        <h3>Client</h3>
        <div class="bp-field-grid">
          ${renderField('client_name', 'Client name', client.client_name)}
          ${renderField('project_label', 'Project label', client.project_label)}
          ${renderField('client_email', 'Email', client.client_email)}
          ${renderField('client_phone', 'Phone', client.client_phone)}
          ${renderField('proposal_date', 'Proposal date', client.proposal_date)}
          ${renderField('bayside_estimate_number', 'Estimate #', client.bayside_estimate_number)}
        </div>
      </div>

      <div class="bp-review-section">
        <h3>Project address</h3>
        <div class="bp-field-grid">
          ${renderField('project_address', 'Street', client.project_address)}
          ${renderField('project_city', 'City', client.project_city)}
          ${renderField('project_state', 'State', client.project_state)}
          ${renderField('project_zip', 'ZIP', client.project_zip)}
        </div>
      </div>

      <div class="bp-review-section">
        <h3>Scope sections <span class="bp-count">${sections.length}</span></h3>
        <div class="bp-sections-list">
          ${sections.map((s, i) => renderSectionCard(s, i)).join('')}
        </div>
      </div>

      <div class="bp-review-section">
        <h3>Totals</h3>
        <dl class="kv bp-totals">
          <dt>Subtotal</dt><dd>${formatMoney(totals.subtotal)}</dd>
          <dt>Discount</dt><dd>${formatMoney(totals.discount_amount)}</dd>
          <dt>Final total</dt><dd><strong>${formatMoney(totals.final_total)}</strong></dd>
        </dl>
      </div>

      ${materials.length ? `
        <div class="bp-review-section">
          <h3>Materials mentioned <span class="bp-count">${materials.length}</span></h3>
          <div class="bp-materials-list">
            ${materials.map(m => renderMaterialChip(m)).join('')}
          </div>
          <p class="hint">Reference only — you'll still pick exact catalog products in the Materials section.</p>
        </div>
      ` : ''}

      <div class="bp-commit-bar">
        <button class="btn primary" id="commitBtn">Commit to proposal →</button>
        <span class="hint">Populates client fields and creates ${sections.length} section record${sections.length === 1 ? '' : 's'}.</span>
      </div>
    </div>
  `;
}

function renderField(key, label, value) {
  return `
    <div class="bp-field">
      <label for="field_${key}">${escapeHtml(label)}</label>
      <input type="text" id="field_${key}" data-key="${key}" value="${escapeHtml(value || '')}" placeholder="—">
    </div>
  `;
}

function renderSectionCard(s, idx) {
  const items = s.line_items || [];
  return `
    <div class="bp-section-card">
      <div class="bp-section-head">
        <span class="bp-section-num">${String(idx + 1).padStart(2, '0')}</span>
        <div class="bp-section-name">${escapeHtml(s.name || '—')}</div>
        <div class="bp-section-total ${s.total_amount < 0 ? 'negative' : ''}">${formatMoney(s.total_amount)}</div>
      </div>
      ${items.length ? `
        <ul class="bp-section-items">
          ${items.map(li => `<li>${escapeHtml(li)}</li>`).join('')}
        </ul>
      ` : `<div class="bp-section-empty">No line items extracted</div>`}
    </div>
  `;
}

function renderMaterialChip(m) {
  const mfr = m.manufacturer || '?';
  const name = m.product_name || '?';
  const bits = [m.color, m.size_spec].filter(Boolean);
  return `
    <div class="bp-material-chip">
      <div class="bp-material-head">
        <strong>${escapeHtml(mfr)}</strong>
        <span>${escapeHtml(name)}</span>
      </div>
      ${bits.length ? `<div class="bp-material-specs">${bits.map(escapeHtml).join(' · ')}</div>` : ''}
      ${m.application ? `<div class="bp-material-app">${escapeHtml(m.application)}</div>` : ''}
    </div>
  `;
}

function renderCommitted() {
  const p = state.parsed || {};
  const c = p.client || {};
  const t = p.totals || {};
  const sectionCount = p.sections?.length || 0;

  return `
    <div class="bp-committed">
      <div class="bp-committed-header">
        <span class="eyebrow">✓ Committed</span>
        <h3>Bid parsed and saved</h3>
      </div>
      <dl class="kv">
        <dt>Client</dt><dd>${escapeHtml(c.client_name || '—')}</dd>
        <dt>Address</dt><dd>${escapeHtml([c.project_address, c.project_city, c.project_state, c.project_zip].filter(Boolean).join(', ') || '—')}</dd>
        <dt>Sections</dt><dd>${sectionCount}</dd>
        <dt>Final total</dt><dd><strong>${formatMoney(t.final_total)}</strong></dd>
      </dl>
      <div class="bp-commit-bar">
        <button class="btn" id="reuploadBtn">Re-upload a different bid</button>
        <span class="hint">Replacing overwrites the extracted data and recreates the section rows.</span>
      </div>
    </div>
  `;
}

function renderError() {
  return `
    <div class="error-box"><strong>Parsing failed:</strong> ${escapeHtml(state.error || 'Unknown error')}</div>
    <div class="bp-commit-bar">
      <button class="btn" id="resetBtn">← Try again</button>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Events
// ───────────────────────────────────────────────────────────────────────────
function attachEvents() {
  const c = state.container;

  const selectBtn = c.querySelector('#selectPdfBtn');
  const pdfInput = c.querySelector('#pdfInput');
  const uploadZone = c.querySelector('#uploadZone');

  selectBtn?.addEventListener('click', () => pdfInput.click());
  pdfInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleUpload(file);
  });

  if (uploadZone) {
    uploadZone.addEventListener('click', (e) => {
      if (e.target === uploadZone || e.target.classList.contains('bp-upload-title') ||
          e.target.classList.contains('bp-upload-sub') || e.target.classList.contains('bp-upload-icon')) {
        pdfInput.click();
      }
    });
    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.type !== 'application/pdf') {
        state.phase = 'error';
        state.error = `Expected PDF, got ${file.type || 'unknown type'}`;
        render();
        return;
      }
      handleUpload(file);
    });
  }

  c.querySelector('#resetBtn')?.addEventListener('click', () => {
    state.phase = 'empty';
    state.parsed = null;
    state.error = null;
    state.editedClient = {};
    render();
  });

  c.querySelectorAll('input[data-key]').forEach(input => {
    input.addEventListener('input', () => {
      state.editedClient[input.dataset.key] = input.value;
    });
  });

  c.querySelector('#commitBtn')?.addEventListener('click', commitToProposal);

  c.querySelector('#reuploadBtn')?.addEventListener('click', () => {
    if (!confirm('Re-uploading will delete the existing bid sections and overwrite the parsed data. Continue?')) return;
    state.phase = 'empty';
    state.parsed = null;
    state.editedClient = {};
    render();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Upload handler
// ───────────────────────────────────────────────────────────────────────────
async function handleUpload(file) {
  state.phase = 'parsing';
  state.error = null;
  render();

  const fd = new FormData();
  fd.append('pdf', file);

  try {
    const res = await fetch('/api/parse-bid-pdf', { method: 'POST', body: fd });
    const json = await res.json().catch(() => null);

    if (!res.ok || !json?.success) {
      state.phase = 'error';
      state.error = json?.error || `HTTP ${res.status}`;
      render();
      return;
    }

    state.parsed = json.parsed;
    state.editedClient = {};
    state.phase = 'review';
    render();
  } catch (err) {
    state.phase = 'error';
    state.error = `Network error: ${err.message}`;
    render();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Commit handler
// ───────────────────────────────────────────────────────────────────────────
async function commitToProposal() {
  const btn = state.container.querySelector('#commitBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Committing…';
  }

  const p = state.parsed || {};
  const mergedClient = { ...(p.client || {}), ...state.editedClient };
  const totals = p.totals || {};
  const sections = p.sections || [];

  // Build proposals update payload (strip empties)
  const updates = {
    client_name: mergedClient.client_name || null,
    client_email: mergedClient.client_email || null,
    client_phone: mergedClient.client_phone || null,
    project_address: mergedClient.project_address || null,
    project_city: mergedClient.project_city || null,
    project_state: mergedClient.project_state || null,
    project_zip: mergedClient.project_zip || null,
    project_label: mergedClient.project_label || null,
    bayside_estimate_number: mergedClient.bayside_estimate_number || null,
    bid_subtotal: totals.subtotal ?? null,
    bid_discount_amount: totals.discount_amount ?? null,
    bid_total_amount: totals.final_total ?? null,
    parsed_bid_data: p
  };

  if (mergedClient.proposal_date && /^\d{4}-\d{2}-\d{2}$/.test(mergedClient.proposal_date)) {
    updates.designed_date = mergedClient.proposal_date;
  }

  // 1. Update proposals row
  const { error: proposalErr } = await supabase
    .from('proposals')
    .update(updates)
    .eq('id', state.proposalId);

  if (proposalErr) {
    alert('Failed to update proposal:\n' + proposalErr.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Commit to proposal →'; }
    return;
  }

  // 2. Delete existing bid_section rows for this proposal
  const { error: deleteErr } = await supabase
    .from('proposal_sections')
    .delete()
    .eq('proposal_id', state.proposalId)
    .eq('section_type', 'bid_section');

  if (deleteErr) {
    alert('Proposal updated but could not clear old sections:\n' + deleteErr.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Commit to proposal →'; }
    return;
  }

  // 3. Insert new proposal_sections
  if (sections.length > 0) {
    const sectionRows = sections.map((s, idx) => ({
      proposal_id: state.proposalId,
      section_type: 'bid_section',
      name: s.name || `Section ${idx + 1}`,
      display_order: idx,
      total_amount: typeof s.total_amount === 'number' ? s.total_amount : null,
      line_items: s.line_items || []
    }));

    const { error: insertErr } = await supabase
      .from('proposal_sections')
      .insert(sectionRows);

    if (insertErr) {
      alert('Proposal updated but failed to create sections:\n' + insertErr.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Commit to proposal →'; }
      return;
    }
  }

  state.phase = 'committed';
  render();
  state.onSave?.();
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function formatMoney(n) {
  if (n === null || n === undefined) return '—';
  const num = typeof n === 'number' ? n : parseFloat(n);
  if (isNaN(num)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
