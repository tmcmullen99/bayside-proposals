// ═══════════════════════════════════════════════════════════════════════════
// Admin tool: Belgard catalog sync (Phase 1.5 Sprint 2 Part A).
//
// Runs three phases against the Belgard website to populate
// belgard_materials.primary_image_url for any rows where it's currently NULL:
//
//   1. DISCOVER — for each selected Belgard category URL, POST to
//      /api/sync-belgard-catalog. Server fetches the index page and hands
//      the HTML to Claude to extract structured product data. Accumulate
//      all products across categories into local state.
//
//   2. MATCH — for each discovered product, normalize its product_name and
//      look for belgard_materials rows with the same normalized name. Bucket
//      each discovered product as: ready (match + NULL image), full (match +
//      image already set), or miss (no catalog row matches).
//
//   3. APPLY — for each ready product, UPDATE belgard_materials SET
//      primary_image_url = ? WHERE product_name matches AND
//      primary_image_url IS NULL. Never overwrites — that's the whole
//      safety contract.
//
// This is an admin tool. It doesn't use the editor shell or sidebar — it's
// a standalone page at /admin/belgard-sync. Tim runs it once (or when he
// wants to refresh missing entries), reviews the results, clicks Apply.
// Subsequent proposals automatically benefit from the enriched catalog.
//
// Phase 5B P2: master-only URL gating. Closes the gap where any signed-in
// designer could navigate directly here and run a Belgard sync.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireMaster } from '/js/auth-util.js';

const CATEGORIES = [
  { id: 'pavers',          label: 'Pavers & Slabs',      url: 'https://www.belgard.com/products/pavers/' },
  { id: 'permeable',       label: 'Permeable & Grid Pavers', url: 'https://www.belgard.com/products/permeable-pavers/' },
  { id: 'porcelain',       label: 'Porcelain Pavers',    url: 'https://www.belgard.com/products/porcelain-pavers/' },
  { id: 'retaining-walls', label: 'Retaining Walls',     url: 'https://www.belgard.com/products/retaining-walls/' },
  { id: 'accessories',     label: 'Caps, Coping & Edgers', url: 'https://www.belgard.com/products/accessories/' },
  { id: 'fire-pits',       label: 'Fire Pit Kits',       url: 'https://www.belgard.com/products/fire-pit-kits/' },
  { id: 'outdoor-kitchens', label: 'Outdoor Kitchens & Fireplaces', url: 'https://www.belgard.com/products/outdoor-kitchens-and-fireplaces/' }
];

const state = {
  catalogRows: [],       // all belgard_materials rows (loaded once)
  selectedCategories: new Set(CATEGORIES.map(c => c.id)), // all checked by default
  discovering: false,
  discoveredProducts: [],  // [{ category, product_name, url, collection, hero_image_url, description }]
  discoveryLog: [],
  matched: null,           // after match phase: { ready, full, miss }
  applying: false,
  applyResults: null       // after apply phase: { updated, skipped, errors }
};

// ───────────────────────────────────────────────────────────────────────────
// Entry
// ───────────────────────────────────────────────────────────────────────────
init();

async function init() {
  // Phase 5B P2: master-only gate. Designers get redirected to /admin/.
  if (!await requireMaster()) return;

  renderCategories();
  wireCategoryCheckboxes();

  document.getElementById('bsDiscoverBtn').addEventListener('click', runDiscovery);
  document.getElementById('bsApplyBtn').addEventListener('click', runApply);
  document.getElementById('bsDoneReload').addEventListener('click', () => {
    // Reset all phase UI and reload catalog stats
    resetToDiscoverPhase();
  });

  await loadCatalogStats();
}

// ───────────────────────────────────────────────────────────────────────────
// Catalog stats (top bar)
// ───────────────────────────────────────────────────────────────────────────
async function loadCatalogStats() {
  // Pull id + product_name + primary_image_url for every row. We'll reuse
  // this dataset for the match phase too, so no need to re-query.
  const { data, error } = await supabase
    .from('belgard_materials')
    .select('id, product_name, color, size_spec, primary_image_url, swatch_url');

  if (error) {
    document.getElementById('bsStatTotal').textContent = '?';
    document.getElementById('bsStatPopulated').textContent = '?';
    document.getElementById('bsStatMissing').textContent = '?';
    console.error('Could not load catalog:', error);
    return;
  }

  state.catalogRows = data || [];
  const total = state.catalogRows.length;
  const populated = state.catalogRows.filter(r => !!r.primary_image_url).length;
  const missing = total - populated;

  document.getElementById('bsStatTotal').textContent = total.toLocaleString();
  document.getElementById('bsStatPopulated').textContent = populated.toLocaleString();
  document.getElementById('bsStatMissing').textContent = missing.toLocaleString();
}

// ───────────────────────────────────────────────────────────────────────────
// Category checkbox UI
// ───────────────────────────────────────────────────────────────────────────
function renderCategories() {
  const wrap = document.getElementById('bsCategoriesList');
  wrap.innerHTML = CATEGORIES.map(c => `
    <label class="bs-category">
      <input type="checkbox" data-cat="${c.id}" ${state.selectedCategories.has(c.id) ? 'checked' : ''}>
      <span class="bs-category-label">${escapeHtml(c.label)}</span>
    </label>
  `).join('');
}

function wireCategoryCheckboxes() {
  document.getElementById('bsCategoriesList').addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb || cb.tagName !== 'INPUT') return;
    const id = cb.dataset.cat;
    if (cb.checked) state.selectedCategories.add(id);
    else state.selectedCategories.delete(id);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 1: Discover
// ───────────────────────────────────────────────────────────────────────────
async function runDiscovery() {
  if (state.discovering) return;

  const selected = CATEGORIES.filter(c => state.selectedCategories.has(c.id));
  if (selected.length === 0) {
    showDiscoverError('Select at least one category first.');
    return;
  }

  state.discovering = true;
  state.discoveredProducts = [];
  state.discoveryLog = [];
  clearDiscoverError();

  const btn = document.getElementById('bsDiscoverBtn');
  btn.disabled = true;
  btn.textContent = 'Discovering…';

  renderDiscoverProgress({ current: 0, total: selected.length, running: true });

  for (let i = 0; i < selected.length; i++) {
    const cat = selected[i];
    renderDiscoverProgress({
      current: i,
      total: selected.length,
      running: true,
      currentLabel: cat.label
    });

    try {
      const res = await fetch('/api/sync-belgard-catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: cat.url })
      });
      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.success) {
        const msg = json?.error || `HTTP ${res.status}`;
        state.discoveryLog.push({ kind: 'error', text: `✗ ${cat.label}: ${msg}` });
      } else {
        const products = json.products || [];
        for (const p of products) {
          state.discoveredProducts.push({ ...p, category_id: cat.id, category_label: cat.label });
        }
        state.discoveryLog.push({
          kind: 'ok',
          text: `✓ ${cat.label}: ${products.length} product${products.length === 1 ? '' : 's'}`
        });
      }
    } catch (err) {
      state.discoveryLog.push({ kind: 'error', text: `✗ ${cat.label}: ${err.message}` });
    }

    renderDiscoverProgress({
      current: i + 1,
      total: selected.length,
      running: true,
      currentLabel: cat.label
    });
  }

  state.discovering = false;
  btn.disabled = false;
  btn.textContent = 'Discover products →';

  renderDiscoverProgress({ current: selected.length, total: selected.length, running: false });

  if (state.discoveredProducts.length === 0) {
    showDiscoverError('No products were discovered. Check the log above for errors.');
    return;
  }

  // Move to match phase
  runMatching();
  showReviewPanel();
}

function renderDiscoverProgress({ current, total, running, currentLabel }) {
  const wrap = document.getElementById('bsDiscoverProgress');
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  const logHtml = state.discoveryLog.map(entry =>
    `<div class="bs-progress-log-entry-${entry.kind === 'error' ? 'error' : 'ok'}">${escapeHtml(entry.text)}</div>`
  ).join('');

  const labelText = running
    ? `Fetching ${currentLabel || '…'} (${current + (current < total ? 1 : 0)} of ${total})`
    : `Discovery complete — ${state.discoveredProducts.length} products found across ${total} categor${total === 1 ? 'y' : 'ies'}`;

  wrap.innerHTML = `
    <div class="bs-progress">
      <div class="bs-progress-label">${escapeHtml(labelText)}</div>
      <div class="bs-progress-bar">
        <div class="bs-progress-fill" style="width:${pct}%"></div>
      </div>
      ${logHtml ? `<div class="bs-progress-log">${logHtml}</div>` : ''}
    </div>
  `;
}

function showDiscoverError(msg) {
  const el = document.getElementById('bsDiscoverError');
  el.innerHTML = `<div class="bs-error">${escapeHtml(msg)}</div>`;
}

function clearDiscoverError() {
  document.getElementById('bsDiscoverError').innerHTML = '';
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 2: Match discovered products to catalog rows
// ───────────────────────────────────────────────────────────────────────────
function runMatching() {
  // Build an index of catalog rows by normalized product_name.
  const catalogIndex = new Map();
  for (const row of state.catalogRows) {
    const key = normalizeName(row.product_name);
    if (!key) continue;
    if (!catalogIndex.has(key)) catalogIndex.set(key, []);
    catalogIndex.get(key).push(row);
  }

  // For each discovered product, decide its status.
  const enriched = state.discoveredProducts.map(p => {
    const key = normalizeName(p.product_name);
    const matchedRows = catalogIndex.get(key) || [];

    let status, readyCount = 0, fullCount = 0;
    if (matchedRows.length === 0) {
      status = 'miss';
    } else {
      for (const r of matchedRows) {
        if (r.primary_image_url) fullCount++;
        else readyCount++;
      }
      if (readyCount > 0) status = 'ready';
      else status = 'full';
    }

    return {
      ...p,
      normalized_name: key,
      matched_rows: matchedRows,
      ready_count: readyCount,
      full_count: fullCount,
      status
    };
  });

  state.matched = {
    all: enriched,
    ready: enriched.filter(p => p.status === 'ready'),
    full:  enriched.filter(p => p.status === 'full'),
    miss:  enriched.filter(p => p.status === 'miss')
  };

  renderReview();
}

function showReviewPanel() {
  document.getElementById('bsReviewPanel').style.display = 'block';
  document.getElementById('bsReviewPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderReview() {
  const m = state.matched;
  if (!m) return;

  // Stats
  const readyRows = m.ready.reduce((n, p) => n + p.ready_count, 0);
  const fullRows = m.full.reduce((n, p) => n + p.full_count, 0);

  document.getElementById('bsReviewStats').innerHTML = `
    <div class="bs-review-stat ready"><strong>${m.ready.length}</strong> products ready — will write to <strong>${readyRows}</strong> catalog row${readyRows === 1 ? '' : 's'}</div>
    <div class="bs-review-stat full"><strong>${m.full.length}</strong> already populated — skipped</div>
    <div class="bs-review-stat miss"><strong>${m.miss.length}</strong> no local catalog match</div>
  `;

  // Table — sort ready first, then full, then miss
  const sorted = [...m.ready, ...m.full, ...m.miss];

  const rows = sorted.map(p => {
    const thumb = p.hero_image_url
      ? `<img src="${escapeAttr(p.hero_image_url)}" alt="" loading="lazy">`
      : `<div class="bs-product-thumb-placeholder">${escapeHtml(p.product_name.slice(0, 3).toUpperCase())}</div>`;

    const statusLabel = {
      ready: `Ready · ${p.ready_count} row${p.ready_count === 1 ? '' : 's'}`,
      full:  `Full · ${p.full_count} row${p.full_count === 1 ? '' : 's'}`,
      miss:  'No match'
    }[p.status];

    const appliedBadge = p.applied ? ` <span class="bs-row-status done">Written</span>` : '';

    return `
      <tr data-discovery-idx="${state.matched.all.indexOf(p)}">
        <td><div class="bs-product-thumb">${thumb}</div></td>
        <td>
          <div class="bs-product-name">${escapeHtml(p.product_name)}</div>
          <div class="bs-product-meta">
            ${p.collection ? escapeHtml(p.collection) + ' · ' : ''}
            <a href="${escapeAttr(p.url)}" target="_blank" rel="noopener">View on belgard.com ↗</a>
          </div>
        </td>
        <td><span class="bs-row-status ${p.status}">${escapeHtml(statusLabel)}</span>${appliedBadge}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('bsReviewTableWrap').innerHTML = `
    <table class="bs-review-table">
      <thead>
        <tr>
          <th style="width: 80px;">Image</th>
          <th>Product</th>
          <th style="width: 220px;">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  const applyBtn = document.getElementById('bsApplyBtn');
  applyBtn.disabled = m.ready.length === 0;
  applyBtn.textContent = m.ready.length === 0
    ? 'Nothing to apply'
    : `Apply ${readyRows} write${readyRows === 1 ? '' : 's'} →`;

  document.getElementById('bsApplySummary').textContent =
    m.ready.length === 0
      ? 'Every matched product already has a primary image. Nothing to do here.'
      : `Clicking will write hero image URLs to ${readyRows} row${readyRows === 1 ? '' : 's'} across ${m.ready.length} product group${m.ready.length === 1 ? '' : 's'}. Only NULL fields are touched.`;
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 3: Apply — write to catalog
// ───────────────────────────────────────────────────────────────────────────
async function runApply() {
  if (state.applying) return;
  const m = state.matched;
  if (!m || m.ready.length === 0) return;

  state.applying = true;
  clearApplyError();

  const btn = document.getElementById('bsApplyBtn');
  btn.disabled = true;
  btn.textContent = 'Writing…';

  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const product of m.ready) {
    if (!product.hero_image_url) {
      skipped += product.ready_count;
      continue;
    }

    // Write to every row that matches this product_name AND has NULL primary_image_url.
    // The WHERE condition is the safety net — even if our local state is slightly
    // stale, the NULL check in Postgres prevents overwriting existing data.
    const targetIds = product.matched_rows
      .filter(r => !r.primary_image_url)
      .map(r => r.id);

    if (targetIds.length === 0) continue;

    const { error, data } = await supabase
      .from('belgard_materials')
      .update({ primary_image_url: product.hero_image_url })
      .in('id', targetIds)
      .is('primary_image_url', null)
      .select('id');

    if (error) {
      errors.push(`${product.product_name}: ${error.message}`);
      continue;
    }

    const wrote = data?.length || 0;
    updated += wrote;
    skipped += targetIds.length - wrote;

    // Patch local state so the UI reflects the write
    for (const row of product.matched_rows) {
      if (targetIds.includes(row.id)) {
        row.primary_image_url = product.hero_image_url;
      }
    }
    product.applied = true;
    product.ready_count = 0;
    product.full_count = product.matched_rows.length;
    if (product.matched_rows.length > 0) product.status = 'full';
  }

  state.applying = false;
  state.applyResults = { updated, skipped, errors };

  if (errors.length > 0) {
    showApplyError(`${errors.length} write${errors.length === 1 ? '' : 's'} failed:\n• ${errors.slice(0, 5).join('\n• ')}${errors.length > 5 ? `\n… and ${errors.length - 5} more` : ''}`);
  }

  // Refresh catalog stats and re-render review table
  await loadCatalogStats();
  renderReview();
  showDonePanel();
}

function showApplyError(msg) {
  const el = document.getElementById('bsApplyError');
  el.innerHTML = `<div class="bs-error" style="white-space:pre-line;">${escapeHtml(msg)}</div>`;
}

function clearApplyError() {
  document.getElementById('bsApplyError').innerHTML = '';
}

function showDonePanel() {
  const r = state.applyResults || { updated: 0, skipped: 0, errors: [] };
  document.getElementById('bsDonePanel').style.display = 'block';

  const title = r.errors.length > 0
    ? `Sync complete with ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`
    : '✓ Sync complete';

  const summary = [
    `<strong>${r.updated}</strong> catalog row${r.updated === 1 ? '' : 's'} enriched with primary images.`,
    r.skipped > 0 ? `${r.skipped} skipped (already populated or NULL check blocked).` : null,
    `Every future proposal that uses these Belgard materials will now show the hero image in its material card.`
  ].filter(Boolean).join(' ');

  document.getElementById('bsDoneTitle').textContent = title;
  document.getElementById('bsDoneSummary').innerHTML = summary;
  document.getElementById('bsDonePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetToDiscoverPhase() {
  state.discoveredProducts = [];
  state.discoveryLog = [];
  state.matched = null;
  state.applyResults = null;

  document.getElementById('bsDiscoverProgress').innerHTML = '';
  document.getElementById('bsReviewPanel').style.display = 'none';
  document.getElementById('bsDonePanel').style.display = 'none';
  clearDiscoverError();
  clearApplyError();

  loadCatalogStats();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ───────────────────────────────────────────────────────────────────────────
// Name normalization — used on both sides of the match
// ───────────────────────────────────────────────────────────────────────────
function normalizeName(name) {
  if (!name) return '';
  return String(name)
    // Strip trademark / copyright symbols
    .replace(/[®™©]/g, '')
    // Strip generic product type suffixes (Paver, Slab, Kit, Step, Wall)
    // when they appear as a trailing word. Case-insensitive.
    .replace(/\s+(pavers?|slabs?|kits?|steps?|walls?)\b/gi, '')
    // Collapse non-alphanumeric runs to single space (handles hyphens, em-dashes, punctuation)
    .replace(/[^\w\s]/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}
