// ═══════════════════════════════════════════════════════════════════════════
// /admin/republish-bulk.js — hardened
//
// Bulk republish for stale published proposals. Same flow as before — uses
// publish.js to drive the existing publish path, processes bids serially —
// but with three resilience changes vs the original:
//
//   1. publish.js is LAZY imported (only when user clicks Republish), so a
//      problem loading or evaluating that 155K module can't prevent the bid
//      list from rendering.
//   2. Every async step is wrapped in try/catch with VISIBLE error messages
//      injected into the page. No more silent freezes — if anything goes
//      wrong you see what.
//   3. The Supabase query has a 15-second timeout race. If the network is
//      hung, the page tells you instead of spinning forever.
//
// Console diagnostics: every milestone logs to console.log/console.error so
// Cmd+Option+I → Console tab gives a precise breadcrumb if anything fails.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireMaster } from '/js/auth-util.js';

console.log('[republish-bulk] module loaded');

// ───────────────────────────────────────────────────────────────────────────
// State
// ───────────────────────────────────────────────────────────────────────────

let bids = [];
const rowState = new Map();
const selectedIds = new Set();
let isRunning = false;

// publish.js exports — populated lazily when first republish is triggered
let _initPublish = null;
let _handlePublish = null;

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

// Hard-fail check: if any required element is missing, the HTML deployed
// out of sync with the JS. Tell the user, don't spin forever.
const requiredEls = {
  resultsEl, counterEl, statusEl, selectAllBtn, selectNoneBtn,
  republishBtn, publishMount,
};
for (const [name, el] of Object.entries(requiredEls)) {
  if (!el) {
    console.error('[republish-bulk] missing required DOM element:', name);
    document.body.innerHTML +=
      `<div style="background:#fbe6e6;color:#b04040;padding:20px;margin:20px;border-radius:8px;font-family:system-ui,sans-serif;">
        <strong>Page error:</strong> required element <code>${name}</code> not found.
        The page HTML and JS may be out of sync — try a hard refresh
        (<kbd>Cmd+Shift+R</kbd>). If that doesn't help, redeploy <code>republish-bulk.html</code>.
      </div>`;
    throw new Error(`Missing element: ${name}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Init
// ───────────────────────────────────────────────────────────────────────────

(async function init() {
  try {
    console.log('[republish-bulk] init started');

    // Phase 5B P2: master-only gate. Designers get redirected to /admin/.
    if (!await requireMaster()) return;

    attachControls();
    await loadBids();
    console.log('[republish-bulk] init complete');
  } catch (err) {
    console.error('[republish-bulk] init failed:', err);
    showFatalError('Could not load published bids', err);
  }
})();

async function loadBids() {
  console.log('[republish-bulk] loadBids: querying published_proposals…');

  // Race the query against a 15s timeout so we never spin forever on
  // a hung network.
  let result;
  try {
    result = await Promise.race([
      supabase
        .from('published_proposals')
        .select('id, proposal_id, slug, title, project_address, total_amount, published_at')
        .order('published_at', { ascending: false }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout — Supabase did not respond within 15 seconds')), 15000)
      ),
    ]);
  } catch (err) {
    console.error('[republish-bulk] loadBids fetch threw:', err);
    showFatalError('Could not load published bids', err);
    return;
  }

  const { data, error } = result;
  if (error) {
    console.error('[republish-bulk] loadBids error:', error);
    showFatalError('Could not load published bids', error);
    return;
  }

  console.log('[republish-bulk] loadBids: got', (data || []).length, 'rows');

  // Group by proposal_id, keep most recent published_at per bid
  const seen = new Map();
  for (const row of (data || [])) {
    if (!seen.has(row.proposal_id)) seen.set(row.proposal_id, row);
  }

  bids = Array.from(seen.values()).sort((a, b) =>
    (a.project_address || a.title || '').localeCompare(b.project_address || b.title || '')
  );

  for (const b of bids) rowState.set(b.proposal_id, { status: 'idle', error: null });

  console.log('[republish-bulk] loadBids: deduped to', bids.length, 'unique bids');
  renderTable();
  updateCounter();
}

// Lazy-loads publish.js. Called the first time runBatch() runs. Returns
// {initPublish, handlePublish} or throws with a clear message.
async function loadPublishModule() {
  if (_initPublish && _handlePublish) {
    return { initPublish: _initPublish, handlePublish: _handlePublish };
  }

  console.log('[republish-bulk] lazy-loading /js/publish.js…');
  let mod;
  try {
    // Cache-bust the dynamic import. Some browsers cache module imports
    // independently of static-resource hard-refresh, so a stale publish.js
    // can hide a fresh deploy. The query string forces a fresh fetch.
    mod = await import('/js/publish.js?v=' + Date.now());
  } catch (err) {
    console.error('[republish-bulk] failed to import publish.js:', err);
    throw new Error('Could not load publish module: ' + (err.message || String(err)));
  }

  if (typeof mod.initPublish !== 'function') {
    throw new Error('publish.js does not export initPublish — redeploy publish.js');
  }
  if (typeof mod.handlePublish !== 'function') {
    throw new Error('publish.js does not export handlePublish — redeploy publish.js with the export added');
  }

  _initPublish = mod.initPublish;
  _handlePublish = mod.handlePublish;
  console.log('[republish-bulk] publish.js loaded');
  return { initPublish: _initPublish, handlePublish: _handlePublish };
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
      const msg = state.error
        ? `<span class="err-msg" title="${escapeHtml(state.error)}">${escapeHtml(state.error)}</span>`
        : '';
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

// Visible fatal-error renderer. Replaces the loading placeholder with an
// actionable error message + manual reload button.
function showFatalError(headline, err) {
  const msg = (err && (err.message || err.error_description || err.error)) || String(err);
  resultsEl.innerHTML = `
    <div class="empty" style="color:#b04040;background:#fff;text-align:left;">
      <strong>${escapeHtml(headline)}</strong>
      <div style="margin-top:8px;font-size:13px;color:#666;line-height:1.5;">
        ${escapeHtml(msg)}
      </div>
      <div style="margin-top:16px;display:flex;gap:10px;">
        <button type="button" class="btn btn-ghost" id="reloadBtn">Reload page</button>
        <button type="button" class="btn btn-ghost" id="retryBtn">Retry query</button>
      </div>
      <div style="margin-top:14px;font-size:12px;color:#999;">
        Tip: open DevTools (Cmd+Option+I) → Console tab and look for red errors —
        the diagnostic logs there usually pinpoint what failed.
      </div>
    </div>
  `;
  document.getElementById('reloadBtn')?.addEventListener('click', () => {
    window.location.reload();
  });
  document.getElementById('retryBtn')?.addEventListener('click', async () => {
    resultsEl.innerHTML = '<div class="loading"><span class="spinner"></span>Retrying…</div>';
    try {
      await loadBids();
    } catch (e) {
      showFatalError('Retry failed', e);
    }
  });
  counterEl.textContent = 'error';
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
    if (!confirm(
      `Republish ${selectedIds.size} bid${selectedIds.size === 1 ? '' : 's'}? ` +
      `This will create a new published version for each. The old versions ` +
      `stay in place under their original slugs.`
    )) return;
    runBatch().catch(err => {
      console.error('[republish-bulk] runBatch threw:', err);
      showStatus('Batch failed: ' + (err.message || String(err)), 'error');
      isRunning = false;
      updateRepublishBtn();
    });
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

  // Lazy-load publish.js up front so the first bid doesn't pay the cost
  // mid-batch and so we can fail fast if the module is broken.
  let publishMod;
  try {
    publishMod = await loadPublishModule();
  } catch (err) {
    isRunning = false;
    selectAllBtn.disabled = false;
    selectNoneBtn.disabled = false;
    updateRepublishBtn();
    showStatus(err.message, 'error');
    return;
  }

  const queue = bids.filter(b => selectedIds.has(b.proposal_id));
  queue.forEach(b => updateRowStatus(b.proposal_id, 'queued'));

  let successes = 0;
  let failures = 0;

  for (const bid of queue) {
    updateRowStatus(bid.proposal_id, 'running');
    try {
      await republishOne(bid.proposal_id, publishMod);
      updateRowStatus(bid.proposal_id, 'success');
      successes++;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.error('[republish-bulk] republishOne failed for', bid.proposal_id, err);
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

  await loadBids();
}

async function republishOne(proposalId, publishMod) {
  publishMount.innerHTML = '';

  await publishMod.initPublish({
    proposalId,
    container: publishMount,
    onSave: () => {},
  });

  const btn = await waitForPublishButton();
  if (!btn) throw new Error('Publish button did not appear within 30s — initPublish may have failed');

  const beforeCount = await countPublishedRows(proposalId);
  await publishMod.handlePublish();
  const afterCount = await countPublishedRows(proposalId);
  if (afterCount <= beforeCount) {
    throw new Error('No new published_proposals row was created — handlePublish ran but didn\'t insert');
  }
}

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
