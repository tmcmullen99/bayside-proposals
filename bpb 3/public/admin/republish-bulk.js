// ═══════════════════════════════════════════════════════════════════════════
// /admin/republish-bulk.js
//
// Bulk republish for stale published proposals. Uses the existing publish.js
// module — same code path as clicking "Publish new version" in the editor —
// so new material swatches and any other catalog updates get baked into a
// fresh snapshot for each selected bid.
//
// Strategy: process bids serially. publish.js holds module-level state
// (proposalId, currentData) so it is NOT re-entrant; running two republishes
// in parallel would race. The hidden #publishMount div in the page is
// rendered offscreen so we can drive the publish UI without blocking the user.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { initPublish, handlePublish } from '/js/publish.js';

// ───────────────────────────────────────────────────────────────────────────
// State
// ───────────────────────────────────────────────────────────────────────────

// Latest published row per proposal_id. We dedupe so the table shows one row
// per bid (the most recent published version), not one row per snapshot.
let bids = [];

// Map of proposal_id → row state for the table.
// Status: 'idle' | 'queued' | 'running' | 'success' | 'failed'
const rowState = new Map();

// Set of proposal_ids that are currently checked in the UI.
const selectedIds = new Set();

let isRunning = false;

// ───────────────────────────────────────────────────────────────────────────
// DOM
// ───────────────────────────────────────────────────────────────────────────

const resultsEl = document.getElementById('results');
const counterEl = document.getElementById('counter');
const statusEl = document.getElementById('statusBanner');
const selectAllBtn = document.getElementById('selectAllBtn');
const selectNoneBtn = document.getElementById('selectNoneBtn');
const republishBtn = document.getElementById('republishBtn');
const publishMount = document.getElementById('publishMount');

// ───────────────────────────────────────────────────────────────────────────
// Init
// ───────────────────────────────────────────────────────────────────────────

async function init() {
  await loadBids();
  attachControls();
}

async function loadBids() {
  // Pull every published_proposals row, group by proposal_id, keep latest
  // by published_at. Joins to proposals for client_name / project_address
  // so we can show a real label even if title was empty at publish time.
  const { data, error } = await supabase
    .from('published_proposals')
    .select('id, proposal_id, slug, title, project_address, total_amount, published_at')
    .order('published_at', { ascending: false });

  if (error) {
    showStatus('Failed to load published proposals: ' + error.message, 'error');
    resultsEl.innerHTML = '<div class="empty">Could not load.</div>';
    return;
  }

  // Group by proposal_id, keep the most recent published_at
  const seen = new Map();
  for (const row of (data || [])) {
    if (!seen.has(row.proposal_id)) seen.set(row.proposal_id, row);
  }

  bids = Array.from(seen.values()).sort((a, b) =>
    (a.project_address || a.title || '').localeCompare(b.project_address || b.title || '')
  );

  // Initialize row state
  for (const b of bids) rowState.set(b.proposal_id, { status: 'idle', error: null });

  renderTable();
  updateCounter();
}

// ───────────────────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────────────────

function renderTable() {
  if (bids.length === 0) {
    resultsEl.innerHTML = '<div class="empty">No published bids yet. Publish a bid in the editor first.</div>';
    return;
  }

  const headerHtml = `
    <div class="bids-row header">
      <div class="col-checkbox"></div>
      <div class="col-address">Address</div>
      <div class="col-slug">Latest slug</div>
      <div class="col-published">Published</div>
      <div class="col-status">Status</div>
    </div>
  `;

  const rowsHtml = bids.map((b) => {
    const checked = selectedIds.has(b.proposal_id) ? 'checked' : '';
    const state = rowState.get(b.proposal_id) || { status: 'idle' };
    const statusLabel = renderStatusLabel(state);
    const publishedDate = formatDate(b.published_at);
    const slugUrl = `/p/${b.slug}`;
    const address = b.project_address || b.title || '(untitled)';

    return `
      <div class="bids-row" data-pid="${escapeHtml(b.proposal_id)}">
        <div class="col-checkbox">
          <input type="checkbox" data-checkbox="${escapeHtml(b.proposal_id)}" ${checked}>
        </div>
        <div class="col-address" title="${escapeHtml(address)}">${escapeHtml(address)}</div>
        <div class="col-slug" title="${escapeHtml(b.slug)}">
          <a href="${escapeHtml(slugUrl)}" target="_blank" rel="noopener">${escapeHtml(b.slug)}</a>
        </div>
        <div class="col-published">${escapeHtml(publishedDate)}</div>
        <div class="col-status ${state.status}">${statusLabel}</div>
      </div>
    `;
  }).join('');

  resultsEl.innerHTML = `<div class="bids-table">${headerHtml}${rowsHtml}</div>`;

  // Wire checkbox listeners
  resultsEl.querySelectorAll('input[data-checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const pid = cb.getAttribute('data-checkbox');
      if (cb.checked) selectedIds.add(pid);
      else selectedIds.delete(pid);
      updateCounter();
      updateRepublishBtn();
    });
  });
}

function renderStatusLabel(state) {
  switch (state.status) {
    case 'queued': return 'Queued';
    case 'running': return 'Publishing…';
    case 'success': return 'Done';
    case 'failed': {
      const msg = state.error ? `<span class="err-msg" title="${escapeHtml(state.error)}">${escapeHtml(state.error)}</span>` : '';
      return `Failed${msg}`;
    }
    default: return '—';
  }
}

function updateRowStatus(proposalId, status, error = null) {
  rowState.set(proposalId, { status, error });
  const row = resultsEl.querySelector(`.bids-row[data-pid="${proposalId}"]`);
  if (!row) return;
  const cell = row.querySelector('.col-status');
  cell.className = `col-status ${status}`;
  cell.innerHTML = renderStatusLabel({ status, error });
}

function updateCounter() {
  counterEl.textContent = `${selectedIds.size} of ${bids.length} selected`;
}

function updateRepublishBtn() {
  republishBtn.disabled = isRunning || selectedIds.size === 0;
  republishBtn.textContent = isRunning
    ? 'Publishing…'
    : `Republish ${selectedIds.size || ''} ${selectedIds.size === 1 ? 'bid' : 'bids'}`.trim();
}

function showStatus(msg, kind = 'info') {
  statusEl.className = `status-banner visible ${kind}`;
  statusEl.textContent = msg;
}

function hideStatus() {
  statusEl.className = 'status-banner';
  statusEl.textContent = '';
}

// ───────────────────────────────────────────────────────────────────────────
// Controls
// ───────────────────────────────────────────────────────────────────────────

function attachControls() {
  selectAllBtn.addEventListener('click', () => {
    if (isRunning) return;
    bids.forEach(b => selectedIds.add(b.proposal_id));
    renderTable();
    updateCounter();
    updateRepublishBtn();
  });

  selectNoneBtn.addEventListener('click', () => {
    if (isRunning) return;
    selectedIds.clear();
    renderTable();
    updateCounter();
    updateRepublishBtn();
  });

  republishBtn.addEventListener('click', () => {
    if (isRunning || selectedIds.size === 0) return;
    if (!confirm(`Republish ${selectedIds.size} bid${selectedIds.size === 1 ? '' : 's'}? This will create a new published version for each. The old versions stay in place under their original slugs.`)) return;
    runBatch();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Batch republish
// ───────────────────────────────────────────────────────────────────────────

async function runBatch() {
  isRunning = true;
  updateRepublishBtn();
  hideStatus();
  selectAllBtn.disabled = true;
  selectNoneBtn.disabled = true;

  // Snapshot the selection so user can't change it mid-run by editing checkboxes
  const queue = bids.filter(b => selectedIds.has(b.proposal_id));
  queue.forEach(b => updateRowStatus(b.proposal_id, 'queued'));

  let successes = 0;
  let failures = 0;

  for (const bid of queue) {
    updateRowStatus(bid.proposal_id, 'running');
    try {
      await republishOne(bid.proposal_id);
      updateRowStatus(bid.proposal_id, 'success');
      successes++;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      updateRowStatus(bid.proposal_id, 'failed', msg);
      failures++;
    }
  }

  isRunning = false;
  selectAllBtn.disabled = false;
  selectNoneBtn.disabled = false;
  updateRepublishBtn();

  if (failures === 0) {
    showStatus(`Republished ${successes} bid${successes === 1 ? '' : 's'}. New versions are live.`, 'info');
  } else if (successes === 0) {
    showStatus(`All ${failures} republish${failures === 1 ? '' : 'es'} failed. See per-row errors above.`, 'error');
  } else {
    showStatus(`Republished ${successes}, ${failures} failed. See per-row errors above.`, 'warn');
  }

  // Reload bid list so latest published_at reflects new versions
  await loadBids();
}

// Republish a single proposal: mount the publish module into the hidden
// container, wait for its data to load, click Publish, wait for the row to
// appear in published_proposals.
async function republishOne(proposalId) {
  // Clear any prior mount
  publishMount.innerHTML = '';

  // initPublish renders a UI into `container`, including a #bpPublishBtn that
  // is disabled while loading and enabled once data is ready.
  await initPublish({
    proposalId,
    container: publishMount,
    onSave: () => {},
  });

  // Wait until the publish button exists and is enabled — that means reload()
  // has finished and currentData is populated.
  const btn = await waitForPublishButton();
  if (!btn) throw new Error('Publish button did not appear within timeout');

  // Capture the count of existing published rows for this proposal so we
  // can confirm a new one was inserted.
  const beforeCount = await countPublishedRows(proposalId);

  // Trigger the publish — same code path the button click runs.
  await handlePublish();

  // Verify a new row appeared
  const afterCount = await countPublishedRows(proposalId);
  if (afterCount <= beforeCount) {
    throw new Error('No new published_proposals row was created');
  }
}

// Polls for the publish button. Up to 30 seconds — generous because
// initPublish loads sections, materials, photos, regions, install guide
// data, etc., and large bids on slow connections take a while.
async function waitForPublishButton(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btn = publishMount.querySelector('#bpPublishBtn');
    if (btn && !btn.disabled) return btn;
    await sleep(150);
  }
  return null;
}

async function countPublishedRows(proposalId) {
  const { count, error } = await supabase
    .from('published_proposals')
    .select('id', { count: 'exact', head: true })
    .eq('proposal_id', proposalId);
  if (error) throw new Error('Could not check published_proposals: ' + error.message);
  return count || 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

init();
