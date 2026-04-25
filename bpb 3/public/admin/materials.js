// ═══════════════════════════════════════════════════════════════════════════
// materials.js — Part A admin UI for third_party_materials (v2 with scraper).
//
// v2 additions (on top of v1):
//   - Paste-link panel calls /api/scrape-product (CF Function)
//   - Scrape result pre-fills the Add form, with filled fields visually
//     highlighted (green-tinted background) so Tim can see at a glance
//     what came from the scrape vs what still needs typing
//   - Source tags shown under the URL bar (og_title / jsonld / url_hostname
//     / etc.) so Tim can gauge confidence of each field
//   - Warnings from the Function are surfaced as inline hints under the URL
//
// Mirrors the pattern used by /admin/admin-clients.js. No auth gate — same
// as /admin/belgard-sync, /admin/material-swatches-bulk.
//
// Scope columns (matches information_schema.columns for third_party_materials
// as of 2026-04-24):
//   id, manufacturer, category, product_name, color, description,
//   image_url, catalog_url, created_at
// The three extra image/guide columns that exist in the schema are NOT
// exposed in this form — they're populated by other sprint flows.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

// ───────────────────────────────────────────────────────────────────────────
// DOM handles
// ───────────────────────────────────────────────────────────────────────────
const el = {
  counter:    document.getElementById('matCounter'),
  status:     document.getElementById('matStatus'),

  search:     document.getElementById('matSearch'),
  filterMfr:  document.getElementById('matFilterMfr'),
  filterCat:  document.getElementById('matFilterCat'),
  addBtn:     document.getElementById('matAddBtn'),
  scrapeBtn:  document.getElementById('matScrapeBtn'),
  csvBtn:     document.getElementById('matCsvBtn'),

  scrapePanel:  document.getElementById('matScrapePanel'),
  scrapeUrl:    document.getElementById('matScrapeUrl'),
  scrapeFetch:  document.getElementById('matScrapeFetch'),
  scrapeCancel: document.getElementById('matScrapeCancel'),
  scrapeResult: document.getElementById('matScrapeResult'),

  formPanel:  document.getElementById('matFormPanel'),
  formTitle:  document.getElementById('matFormTitle'),
  mfr:        document.getElementById('matMfr'),
  mfrList:    document.getElementById('matMfrList'),
  cat:        document.getElementById('matCat'),
  catList:    document.getElementById('matCatList'),
  product:    document.getElementById('matProduct'),
  color:      document.getElementById('matColor'),
  desc:       document.getElementById('matDesc'),
  imgUrl:     document.getElementById('matImgUrl'),
  catalogUrl: document.getElementById('matCatalogUrl'),
  formSave:   document.getElementById('matFormSave'),
  formCancel: document.getElementById('matFormCancel'),

  csvPanel:   document.getElementById('matCsvPanel'),
  csvDrop:    document.getElementById('matCsvDrop'),
  csvInput:   document.getElementById('matCsvInput'),
  csvPreview: document.getElementById('matCsvPreview'),
  csvSummary: document.getElementById('matCsvSummary'),
  csvErrors:  document.getElementById('matCsvErrors'),
  csvImport:  document.getElementById('matCsvImport'),
  csvReset:   document.getElementById('matCsvReset'),

  empty:      document.getElementById('matEmpty'),
  tableWrap:  document.getElementById('matTableWrap'),
  tableBody:  document.getElementById('matTableBody'),
};

// ───────────────────────────────────────────────────────────────────────────
// State
// ───────────────────────────────────────────────────────────────────────────
const ctx = {
  materials:    [],
  manufacturers: [],
  categories:    [],
  editingId:    null,
  searchTerm:   '',
  filterMfr:    '',
  filterCat:    '',
  csvPending:   null,
};

// ───────────────────────────────────────────────────────────────────────────
// Bootstrap
// ───────────────────────────────────────────────────────────────────────────
(async function init() {
  attachListeners();
  await loadMaterials();
  render();
})();

async function loadMaterials() {
  const { data, error } = await supabase
    .from('third_party_materials')
    .select('id, manufacturer, category, product_name, color, description, image_url, catalog_url, created_at')
    .order('manufacturer', { ascending: true })
    .order('product_name', { ascending: true });

  if (error) {
    showStatus('error', `Could not load materials: ${error.message}`);
    ctx.materials = [];
    return;
  }
  ctx.materials = data || [];

  const mfrSet = new Set();
  const catSet = new Set();
  for (const m of ctx.materials) {
    if (m.manufacturer) mfrSet.add(m.manufacturer);
    if (m.category)     catSet.add(m.category);
  }
  ctx.manufacturers = [...mfrSet].sort((a, b) => a.localeCompare(b));
  ctx.categories    = [...catSet].sort((a, b) => a.localeCompare(b));
}

// ───────────────────────────────────────────────────────────────────────────
// Event wiring
// ───────────────────────────────────────────────────────────────────────────
function attachListeners() {
  el.search.addEventListener('input', (e) => {
    ctx.searchTerm = e.target.value.trim().toLowerCase();
    renderTable();
  });
  el.filterMfr.addEventListener('change', (e) => {
    ctx.filterMfr = e.target.value;
    renderTable();
  });
  el.filterCat.addEventListener('change', (e) => {
    ctx.filterCat = e.target.value;
    renderTable();
  });

  el.addBtn.addEventListener('click',    () => openForm(null));
  el.formCancel.addEventListener('click', closeForm);
  el.formSave.addEventListener('click',  handleSave);

  el.scrapeBtn.addEventListener('click',    toggleScrapePanel);
  el.scrapeFetch.addEventListener('click',  handleScrape);
  el.scrapeCancel.addEventListener('click', closeScrapePanel);
  el.scrapeUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleScrape(); }
  });

  el.csvBtn.addEventListener('click',      toggleCsvPanel);
  el.csvInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleCsvFile(file);
  });
  el.csvImport.addEventListener('click', handleCsvImport);
  el.csvReset.addEventListener('click',  resetCsv);

  ['dragenter', 'dragover'].forEach(evt => {
    el.csvDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      el.csvDrop.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    el.csvDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      el.csvDrop.classList.remove('drag-over');
    });
  });
  el.csvDrop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleCsvFile(file);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────────────────
function render() {
  renderFilters();
  renderDatalists();
  renderTable();
}

function renderFilters() {
  const renderOptions = (selectEl, values, currentValue) => {
    const first = selectEl.querySelector('option');
    selectEl.innerHTML = '';
    selectEl.appendChild(first);
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      if (v === currentValue) opt.selected = true;
      selectEl.appendChild(opt);
    }
  };
  renderOptions(el.filterMfr, ctx.manufacturers, ctx.filterMfr);
  renderOptions(el.filterCat, ctx.categories,    ctx.filterCat);
}

function renderDatalists() {
  el.mfrList.innerHTML = ctx.manufacturers
    .map(v => `<option value="${escapeAttr(v)}">`).join('');
  el.catList.innerHTML = ctx.categories
    .map(v => `<option value="${escapeAttr(v)}">`).join('');
}

function renderTable() {
  const visible = ctx.materials.filter(m => {
    if (ctx.filterMfr && m.manufacturer !== ctx.filterMfr) return false;
    if (ctx.filterCat && m.category     !== ctx.filterCat) return false;
    if (ctx.searchTerm) {
      const hay = [
        m.manufacturer, m.category, m.product_name, m.color, m.description,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(ctx.searchTerm)) return false;
    }
    return true;
  });

  el.counter.textContent = ctx.materials.length === 0
    ? '0 materials'
    : `${visible.length} of ${ctx.materials.length} material${ctx.materials.length === 1 ? '' : 's'}`;

  if (ctx.materials.length === 0) {
    el.empty.style.display = 'block';
    el.tableWrap.style.display = 'none';
    return;
  }

  el.empty.style.display = 'none';
  el.tableWrap.style.display = 'block';

  if (visible.length === 0) {
    el.tableBody.innerHTML = `
      <tr><td colspan="4" style="text-align:center; padding:32px; color:var(--bp-muted);">
        No materials match those filters.
      </td></tr>`;
    return;
  }

  el.tableBody.innerHTML = visible.map(renderRow).join('');

  el.tableBody.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', () => openForm(btn.dataset.editId));
  });
  el.tableBody.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', () => handleDelete(btn.dataset.deleteId));
  });
}

function renderRow(m) {
  const subLine = [m.color, m.description].filter(Boolean).join(' · ');
  return `
    <tr>
      <td><div class="bp-mat-row-mfr">${escapeHtml(m.manufacturer)}</div></td>
      <td>
        <div class="bp-mat-row-product">${escapeHtml(m.product_name)}</div>
        ${subLine ? `<div class="bp-mat-row-sub">${escapeHtml(subLine)}</div>` : ''}
      </td>
      <td><span class="bp-mat-row-chip">${escapeHtml(m.category)}</span></td>
      <td class="bp-mat-col-actions">
        <div class="bp-mat-row-actions">
          <button class="bp-mat-btn-small" data-edit-id="${escapeAttr(m.id)}">Edit</button>
          <button class="bp-mat-btn-small bp-mat-btn-danger" data-delete-id="${escapeAttr(m.id)}">Remove</button>
        </div>
      </td>
    </tr>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Scrape-link panel
// ───────────────────────────────────────────────────────────────────────────
function toggleScrapePanel() {
  el.formPanel.classList.remove('visible');
  el.csvPanel.classList.remove('visible');
  const wasOpen = el.scrapePanel.classList.contains('visible');
  el.scrapePanel.classList.toggle('visible');
  if (!wasOpen) {
    el.scrapeUrl.focus();
    el.scrapePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function closeScrapePanel() {
  el.scrapePanel.classList.remove('visible');
  el.scrapeResult.classList.remove('visible');
  el.scrapeResult.innerHTML = '';
}

async function handleScrape() {
  const url = el.scrapeUrl.value.trim();
  if (!url) {
    showStatus('error', 'Paste a product URL first.');
    el.scrapeUrl.focus();
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    showStatus('error', 'URL must start with http:// or https://');
    return;
  }

  el.scrapeFetch.disabled = true;
  el.scrapeFetch.textContent = 'Fetching…';
  el.scrapeResult.classList.remove('visible');

  let data;
  try {
    const resp = await fetch('/api/scrape-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    data = await resp.json();
  } catch (err) {
    el.scrapeFetch.disabled = false;
    el.scrapeFetch.textContent = 'Fetch details';
    showStatus('error', `Could not reach scraper: ${err.message}`);
    return;
  }

  el.scrapeFetch.disabled = false;
  el.scrapeFetch.textContent = 'Fetch details';

  // Both success and graceful-fail responses carry `extracted` + `sources`.
  // Only hard failures (invalid URL, bad request) have none.
  const ext = data?.extracted;
  if (!ext) {
    showStatus('error', `Scrape failed: ${data?.error || 'unknown error'}${data?.detail ? ' — ' + data.detail : ''}`);
    return;
  }

  // Open the form and pre-fill whatever we got
  openForm(null);   // switches to Add mode and clears first
  prefillFormFrom(ext);

  // Render the scrape-result summary with source tags + warnings
  renderScrapeSummary(data);

  // Highlight based on success vs warnings
  if (data.ok) {
    showStatus('ok', 'Scrape succeeded. Review the form below and click Save.');
  } else {
    showStatus('warn', 'Partial scrape — some fields are from the URL only. Review carefully before saving.');
  }
}

function prefillFormFrom(ext) {
  // Clear highlight class on all inputs first
  [el.mfr, el.cat, el.product, el.color, el.desc, el.imgUrl, el.catalogUrl]
    .forEach(input => input.classList.remove('bp-mat-filled-by-scrape'));

  const setIf = (input, val) => {
    if (val != null && val !== '') {
      input.value = val;
      input.classList.add('bp-mat-filled-by-scrape');
    }
  };
  setIf(el.mfr,        ext.manufacturer);
  setIf(el.cat,        ext.category);
  setIf(el.product,    ext.product_name);
  setIf(el.desc,       ext.description);
  setIf(el.imgUrl,     ext.image_url);
  setIf(el.catalogUrl, ext.catalog_url);
  // Color stays blank — we never extract it in v1
}

function renderScrapeSummary(data) {
  const ext = data.extracted || {};
  const sources = data.sources || {};
  const warnings = data.warnings || [];

  const labels = {
    manufacturer: 'Manufacturer',
    product_name: 'Product name',
    description:  'Description',
    category:     'Category',
    image_url:    'Image URL',
    catalog_url:  'Catalog URL',
  };

  const rows = Object.keys(labels).map(k => {
    const v = ext[k];
    const src = sources[k];
    if (!v) {
      return `<li><strong>${labels[k]}:</strong> <em style="color:var(--bp-muted);">not found</em></li>`;
    }
    const short = String(v).length > 90 ? String(v).slice(0, 90) + '…' : v;
    return `<li><strong>${labels[k]}:</strong> ${escapeHtml(short)}` +
           (src ? `<span class="bp-mat-src-tag">${escapeHtml(src)}</span>` : '') +
           `</li>`;
  }).join('');

  const warnHtml = warnings.length > 0
    ? `<div style="margin-top:10px;padding:8px 10px;background:var(--bp-warn-bg);color:var(--bp-warn);border-radius:3px;">
         ${warnings.map(w => `<div>${escapeHtml(w)}</div>`).join('')}
       </div>`
    : '';

  const statusLine = data.ok
    ? `<strong style="color:var(--bp-ok);">✓ Fetched ${data.status}</strong> in ${data.elapsed_ms}ms`
    : `<strong style="color:var(--bp-warn);">⚠ ${data.error || 'partial'}</strong>` +
      (data.status ? ` — upstream ${data.status}` : '');

  el.scrapeResult.innerHTML = `
    <div style="margin-bottom:6px;">${statusLine}</div>
    <ul style="margin:6px 0 0;">${rows}</ul>
    ${warnHtml}
  `;
  el.scrapeResult.classList.add('visible');
}

// ───────────────────────────────────────────────────────────────────────────
// Add / Edit form
// ───────────────────────────────────────────────────────────────────────────
function openForm(editId) {
  ctx.editingId = editId || null;
  el.csvPanel.classList.remove('visible');

  if (editId) {
    const m = ctx.materials.find(x => x.id === editId);
    if (!m) {
      showStatus('error', 'Could not find that material.');
      return;
    }
    el.formTitle.textContent = 'Edit material';
    el.mfr.value        = m.manufacturer || '';
    el.cat.value        = m.category || '';
    el.product.value    = m.product_name || '';
    el.color.value      = m.color || '';
    el.desc.value       = m.description || '';
    el.imgUrl.value     = m.image_url || '';
    el.catalogUrl.value = m.catalog_url || '';
  } else {
    el.formTitle.textContent = 'Add material';
    el.mfr.value = '';
    el.cat.value = '';
    el.product.value = '';
    el.color.value = '';
    el.desc.value = '';
    el.imgUrl.value = '';
    el.catalogUrl.value = '';
  }
  // Clear any previous scrape-fill highlighting
  [el.mfr, el.cat, el.product, el.color, el.desc, el.imgUrl, el.catalogUrl]
    .forEach(input => input.classList.remove('bp-mat-filled-by-scrape'));

  el.formPanel.classList.add('visible');
  // Don't steal focus if caller is about to pre-fill (from scrape)
  if (!editId) setTimeout(() => el.mfr.focus(), 0);
  el.formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeForm() {
  el.formPanel.classList.remove('visible');
  ctx.editingId = null;
}

async function handleSave() {
  const row = {
    manufacturer: el.mfr.value.trim(),
    category:     el.cat.value.trim(),
    product_name: el.product.value.trim(),
    color:        el.color.value.trim() || null,
    description:  el.desc.value.trim() || null,
    image_url:    el.imgUrl.value.trim() || null,
    catalog_url:  el.catalogUrl.value.trim() || null,
  };

  if (!row.manufacturer) return showStatus('error', 'Manufacturer is required.');
  if (!row.category)     return showStatus('error', 'Category is required.');
  if (!row.product_name) return showStatus('error', 'Product name is required.');

  el.formSave.disabled = true;
  el.formSave.textContent = ctx.editingId ? 'Saving…' : 'Adding…';

  let error;
  if (ctx.editingId) {
    ({ error } = await supabase
      .from('third_party_materials')
      .update(row)
      .eq('id', ctx.editingId));
  } else {
    ({ error } = await supabase
      .from('third_party_materials')
      .insert(row));
  }

  el.formSave.disabled = false;
  el.formSave.textContent = 'Save material';

  if (error) {
    if (error.code === '23505') {
      return showStatus('error', 'A material with that exact manufacturer + product + color already exists.');
    }
    return showStatus('error', `Could not save: ${error.message}`);
  }

  showStatus('ok', ctx.editingId
    ? `Updated ${row.manufacturer} · ${row.product_name}.`
    : `Added ${row.manufacturer} · ${row.product_name}.`);
  closeForm();
  closeScrapePanel();      // also close scrape panel if it was open
  await loadMaterials();
  render();
}

async function handleDelete(id) {
  const m = ctx.materials.find(x => x.id === id);
  if (!m) return;
  const label = `${m.manufacturer} · ${m.product_name}${m.color ? ' · ' + m.color : ''}`;
  if (!confirm(`Remove "${label}"?\n\nThis can't be undone. Any proposal that references this material directly may fail to render its card.`)) return;

  const { error } = await supabase
    .from('third_party_materials')
    .delete()
    .eq('id', id);

  if (error) {
    if (error.code === '23503') {
      return showStatus('error',
        `Cannot remove "${label}" — it's still referenced by at least one proposal. ` +
        `Remove it from those proposals first, then try again.`);
    }
    return showStatus('error', `Could not remove: ${error.message}`);
  }
  showStatus('ok', `Removed ${label}.`);
  await loadMaterials();
  render();
}

// ───────────────────────────────────────────────────────────────────────────
// CSV bulk import (unchanged from v1)
// ───────────────────────────────────────────────────────────────────────────
function toggleCsvPanel() {
  el.formPanel.classList.remove('visible');
  el.scrapePanel.classList.remove('visible');
  el.csvPanel.classList.toggle('visible');
  if (el.csvPanel.classList.contains('visible')) {
    resetCsv();
    el.csvPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function resetCsv() {
  ctx.csvPending = null;
  el.csvInput.value = '';
  el.csvPreview.classList.remove('visible');
  el.csvSummary.innerHTML = '';
  el.csvErrors.innerHTML = '';
}

async function handleCsvFile(file) {
  if (!file.name.toLowerCase().endsWith('.csv') && !file.type.includes('csv')) {
    if (!confirm(`"${file.name}" doesn't look like a CSV. Try to parse it anyway?`)) return;
  }
  let text;
  try {
    text = await file.text();
  } catch (err) {
    return showStatus('error', `Could not read file: ${err.message}`);
  }
  previewCsv(text);
}

function previewCsv(text) {
  let rows;
  try {
    rows = parseCsv(text);
  } catch (err) {
    showStatus('error', `CSV parse error: ${err.message}`);
    resetCsv();
    return;
  }
  if (rows.length < 2) {
    showStatus('error', 'CSV needs at least a header row and one data row.');
    resetCsv();
    return;
  }

  const header = rows[0].map(h => h.trim().toLowerCase());
  const required = ['manufacturer', 'category', 'product_name'];
  const missing = required.filter(r => !header.includes(r));
  if (missing.length > 0) {
    showStatus('error',
      `CSV is missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. ` +
      `Header row must include: manufacturer, category, product_name.`);
    resetCsv();
    return;
  }

  const idx = {
    manufacturer: header.indexOf('manufacturer'),
    category:     header.indexOf('category'),
    product_name: header.indexOf('product_name'),
    color:        header.indexOf('color'),
    description:  header.indexOf('description'),
    image_url:    header.indexOf('image_url'),
    catalog_url:  header.indexOf('catalog_url'),
  };

  const validRows = [];
  const errors = [];
  const existingKey = new Set(
    ctx.materials.map(m => rowKey(m.manufacturer, m.product_name, m.color || ''))
  );
  const seenInFile = new Set();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(v => v == null || String(v).trim() === '')) continue;

    const rowNum = i + 1;
    const cell = (i2) => (i2 >= 0 && i2 < r.length ? String(r[i2]).trim() : '');
    const manufacturer = cell(idx.manufacturer);
    const category     = cell(idx.category);
    const product_name = cell(idx.product_name);
    const color        = cell(idx.color) || null;
    const description  = cell(idx.description) || null;
    const image_url    = cell(idx.image_url) || null;
    const catalog_url  = cell(idx.catalog_url) || null;

    if (!manufacturer) { errors.push(`Row ${rowNum}: manufacturer is empty`); continue; }
    if (!category)     { errors.push(`Row ${rowNum}: category is empty`); continue; }
    if (!product_name) { errors.push(`Row ${rowNum}: product_name is empty`); continue; }

    if (image_url && !/^https?:\/\//i.test(image_url)) {
      errors.push(`Row ${rowNum}: image_url must start with http:// or https://`);
      continue;
    }
    if (catalog_url && !/^https?:\/\//i.test(catalog_url)) {
      errors.push(`Row ${rowNum}: catalog_url must start with http:// or https://`);
      continue;
    }

    const key = rowKey(manufacturer, product_name, color || '');
    if (seenInFile.has(key)) {
      errors.push(`Row ${rowNum}: duplicate of an earlier row (${manufacturer} · ${product_name}${color ? ' · ' + color : ''})`);
      continue;
    }
    seenInFile.add(key);

    const dupeInDb = existingKey.has(key);

    validRows.push({
      _row: rowNum,
      _dupe: dupeInDb,
      manufacturer, category, product_name,
      color, description, image_url, catalog_url,
    });
  }

  ctx.csvPending = { validRows, errors };
  renderCsvPreview();
}

function renderCsvPreview() {
  const { validRows, errors } = ctx.csvPending;
  const dupes = validRows.filter(r => r._dupe).length;
  const fresh = validRows.length - dupes;

  el.csvSummary.innerHTML =
    `<strong>${validRows.length}</strong> row${validRows.length === 1 ? '' : 's'} will be imported` +
    (dupes > 0 ? ` <span style="color:var(--bp-muted);">(${fresh} new, ${dupes} match existing by mfr+product+color)</span>` : '') +
    (errors.length > 0 ? ` · <span style="color:var(--bp-danger);"><strong>${errors.length}</strong> row${errors.length === 1 ? '' : 's'} skipped</span>` : '');

  if (errors.length > 0) {
    el.csvErrors.innerHTML = errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
  } else {
    el.csvErrors.innerHTML = '';
  }

  el.csvImport.disabled = validRows.length === 0;
  el.csvPreview.classList.add('visible');
}

async function handleCsvImport() {
  if (!ctx.csvPending || ctx.csvPending.validRows.length === 0) return;

  const { validRows } = ctx.csvPending;
  const dupes = validRows.filter(r => r._dupe).length;
  if (dupes > 0) {
    const proceed = confirm(
      `${dupes} of the ${validRows.length} rows appear to duplicate existing materials by manufacturer + product + color. ` +
      `They will be inserted as additional rows (the schema doesn't enforce uniqueness).\n\n` +
      `Import anyway?`
    );
    if (!proceed) return;
  }

  el.csvImport.disabled = true;
  el.csvImport.textContent = 'Importing…';

  const payload = validRows.map(({ _row, _dupe, ...rest }) => rest);

  const { error } = await supabase
    .from('third_party_materials')
    .insert(payload);

  el.csvImport.disabled = false;
  el.csvImport.textContent = 'Import valid rows';

  if (error) {
    return showStatus('error', `CSV import failed: ${error.message}`);
  }

  showStatus('ok', `Imported ${payload.length} material${payload.length === 1 ? '' : 's'} from CSV.`);
  resetCsv();
  el.csvPanel.classList.remove('visible');
  await loadMaterials();
  render();
}

/**
 * RFC 4180-ish CSV parser. Single pass, state machine.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    if (ch === '\n' || ch === '\r')          { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (inQuotes) throw new Error('Unterminated quoted field');
  return rows;
}

function rowKey(mfr, product, color) {
  return [mfr, product, color].map(s => String(s || '').toLowerCase().trim()).join('|');
}

// ───────────────────────────────────────────────────────────────────────────
// Utils
// ───────────────────────────────────────────────────────────────────────────
function showStatus(kind, msg) {
  let klass = 'bp-mat-status visible ';
  if (kind === 'ok')         klass += 'ok';
  else if (kind === 'warn')  klass += 'warn';
  else                       klass += 'error';
  el.status.className = klass;
  el.status.textContent = msg;
  el.status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (kind === 'ok') {
    setTimeout(() => {
      if (el.status.textContent === msg) {
        el.status.className = 'bp-mat-status';
        el.status.textContent = '';
      }
    }, 5000);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}
