// ═══════════════════════════════════════════════════════════════════════════
// Sprint 3 Part A — Material Swatch Admin
//
// Lets Tim upload per-color swatch images for Belgard product variants.
// On upload: image goes to Supabase Storage at swatches/{id}.{ext}, and the
// public URL is written to belgard_materials.swatch_url. Published proposals
// (publish.js) already prefer swatch_url over primary_image_url, so the
// Whitham proposal immediately reflects accurate colors after upload.
//
// No CF Function required — direct Supabase client upload, same pattern as
// the property photos uploader. No SQL migration — swatch_url column
// exists from Sprint 1.5 and anon UPDATE policy exists from Sprint 2A
// hotfix 011.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

const BUCKET = 'proposal-photos';
const SWATCH_PREFIX = 'swatches';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// In-memory catalog, filtered by search/state each render
let allMaterials = [];
let filter = { search: '', swatchState: 'all' };

// ───────────────────────────────────────────────────────────────────────────
// Init
// ───────────────────────────────────────────────────────────────────────────
init();

async function init() {
  wireControls();
  await loadCatalog();
}

async function loadCatalog() {
  const { data, error } = await supabase
    .from('belgard_materials')
    .select('*')
    .order('product_name', { ascending: true });

  if (error) {
    renderError(`Could not load catalog: ${error.message}`);
    return;
  }

  allMaterials = data || [];
  render();
}

function wireControls() {
  document.getElementById('searchInput').addEventListener('input', (e) => {
    filter.search = (e.target.value || '').toLowerCase().trim();
    render();
  });
  document.getElementById('filterState').addEventListener('change', (e) => {
    filter.swatchState = e.target.value;
    render();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────
function render() {
  const filtered = allMaterials.filter(matchesFilter);

  // Group by product name
  const groups = new Map();
  for (const m of filtered) {
    const key = m.product_name || 'Unnamed product';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  // Update counter
  const totalWithSwatch = allMaterials.filter((m) => m.swatch_url).length;
  document.getElementById('counter').textContent =
    `${totalWithSwatch}/${allMaterials.length} uploaded · showing ${filtered.length}`;

  const container = document.getElementById('results');

  if (filtered.length === 0) {
    container.innerHTML = renderEmptyState();
    return;
  }

  const groupsHtml = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productName, variants]) => renderProductGroup(productName, variants))
    .join('');

  container.innerHTML = groupsHtml;
  wireCardActions();
}

function matchesFilter(m) {
  if (filter.search) {
    const haystack = [
      m.product_name,
      colorNameOf(m),
      m.category_name, // might not exist; cheap to check
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filter.search)) return false;
  }
  if (filter.swatchState === 'missing' && m.swatch_url) return false;
  if (filter.swatchState === 'has' && !m.swatch_url) return false;
  return true;
}

function renderProductGroup(productName, variants) {
  const withSwatch = variants.filter((v) => v.swatch_url).length;
  const total = variants.length;
  const complete = withSwatch === total;

  const cardsHtml = variants
    .slice()
    .sort((a, b) => colorNameOf(a).localeCompare(colorNameOf(b)))
    .map(renderVariantCard)
    .join('');

  return `
    <section class="product-group">
      <header class="product-group-header">
        <div class="product-group-title">
          ${escapeHtml(productName)}
          <small>${total} ${total === 1 ? 'variant' : 'variants'}</small>
        </div>
        <div class="product-group-count ${complete ? 'complete' : ''}">
          ${withSwatch} / ${total} swatches
        </div>
      </header>
      <div class="variant-grid">${cardsHtml}</div>
    </section>
  `;
}

function renderVariantCard(m) {
  const colorName = colorNameOf(m);
  const sizes = sizeSummaryOf(m);
  const hasSwatch = !!m.swatch_url;

  const swatchPreview = hasSwatch
    ? `<img src="${escapeAttr(m.swatch_url)}" alt="${escapeAttr(colorName)}" loading="lazy">`
    : `<div class="no-swatch">No swatch</div>`;

  const primaryBtn = hasSwatch
    ? `<label class="upload-btn upload-btn-secondary">
         Replace
         <input type="file" accept="image/*" data-id="${m.id}" data-action="upload" hidden>
       </label>`
    : `<label class="upload-btn upload-btn-primary">
         Upload swatch
         <input type="file" accept="image/*" data-id="${m.id}" data-action="upload" hidden>
       </label>`;

  const removeBtn = hasSwatch
    ? `<button type="button" class="upload-btn upload-btn-danger"
         data-id="${m.id}" data-action="remove" title="Remove swatch">✕</button>`
    : '';

  return `
    <div class="variant-card ${hasSwatch ? 'has-swatch' : 'missing'}" data-card-id="${m.id}">
      <div class="swatch-preview">${swatchPreview}</div>
      <div class="variant-info">
        <div class="color-name">${escapeHtml(colorName)}</div>
        ${sizes ? `<div class="sizes">${escapeHtml(sizes)}</div>` : ''}
      </div>
      <div class="variant-actions">
        ${primaryBtn}
        ${removeBtn}
      </div>
    </div>
  `;
}

function renderEmptyState() {
  if (allMaterials.length === 0) {
    return `<div class="empty">No Belgard materials in catalog yet. Run a catalog sync first.</div>`;
  }
  return `<div class="empty">No variants match your filters. Try a different search term or clear the state filter.</div>`;
}

function renderError(msg) {
  document.getElementById('results').innerHTML =
    `<div class="empty" style="color:var(--danger);">${escapeHtml(msg)}</div>`;
}

// ───────────────────────────────────────────────────────────────────────────
// Card interactions
// ───────────────────────────────────────────────────────────────────────────
function wireCardActions() {
  document.querySelectorAll('input[data-action="upload"]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      const id = e.target.dataset.id;
      if (file && id) handleUpload(id, file, e.target);
    });
  });

  document.querySelectorAll('button[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (id) handleRemove(id);
    });
  });
}

async function handleUpload(materialId, file, inputEl) {
  if (!file.type.startsWith('image/')) {
    showStatus('Please select an image file.', 'error');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showStatus(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 5 MB.`, 'error');
    return;
  }

  const card = document.querySelector(`[data-card-id="${materialId}"]`);
  if (card) card.classList.add('uploading');

  try {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${SWATCH_PREFIX}/${materialId}.${ext}`;

    // Upload (upsert: true so Replace overwrites the previous file)
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, {
        upsert: true,
        contentType: file.type,
        cacheControl: '3600',
      });

    if (uploadErr) throw uploadErr;

    // Get public URL with cache-buster so the UI refreshes
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = `${urlData.publicUrl}?v=${Date.now()}`;

    // Update the catalog row (legacy table)
    const { error: updateErr } = await supabase
      .from('belgard_materials')
      .update({ swatch_url: publicUrl })
      .eq('id', materialId);

    if (updateErr) throw updateErr;

    // Phase 3B.1 contract: mirror into the unified materials table so the
    // picker (which reads from materials, not belgard_materials) reflects
    // the new swatch immediately. Same dual-write pattern materials.js
    // uses on its primary_image_url backfill — non-fatal so a dropped
    // mirror doesn't fail the whole upload (data is still in legacy and
    // a re-run of the backfill SQL recovers it).
    const { error: mirrorErr } = await supabase
      .from('materials')
      .update({ swatch_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', materialId);
    if (mirrorErr) {
      console.warn('Could not mirror swatch_url to materials:', mirrorErr.message);
    }

    // Mutate in-memory state and re-render
    const m = allMaterials.find((x) => x.id === materialId);
    if (m) m.swatch_url = publicUrl;

    render();
    const colorName = m ? colorNameOf(m) : 'variant';
    showStatus(`Uploaded swatch for ${colorName}.`, 'success');
  } catch (err) {
    if (card) card.classList.remove('uploading');
    showStatus(`Upload failed: ${err.message || String(err)}`, 'error');
  }

  // Reset input so selecting the same file again still fires change
  if (inputEl) inputEl.value = '';
}

async function handleRemove(materialId) {
  const m = allMaterials.find((x) => x.id === materialId);
  if (!m || !m.swatch_url) return;

  const colorName = colorNameOf(m);
  if (!confirm(`Remove the swatch for ${colorName}? The image will be deleted from storage.`)) {
    return;
  }

  const card = document.querySelector(`[data-card-id="${materialId}"]`);
  if (card) card.classList.add('uploading');

  try {
    // Try to delete from storage. Path is deterministic but we also need to
    // handle the case where an older file exists with a different extension.
    // Defensive approach: strip the cache-buster and infer path from URL.
    const storagePath = extractStoragePath(m.swatch_url);
    if (storagePath) {
      const { error: delErr } = await supabase.storage.from(BUCKET).remove([storagePath]);
      // Non-fatal if the file doesn't exist — just log.
      if (delErr) console.warn('Storage delete failed (non-fatal):', delErr);
    }

    // Clear the column (legacy table)
    const { error: updateErr } = await supabase
      .from('belgard_materials')
      .update({ swatch_url: null })
      .eq('id', materialId);

    if (updateErr) throw updateErr;

    // Phase 3B.1 dual-write: also clear from the unified materials table.
    const { error: mirrorErr } = await supabase
      .from('materials')
      .update({ swatch_url: null, updated_at: new Date().toISOString() })
      .eq('id', materialId);
    if (mirrorErr) {
      console.warn('Could not mirror swatch_url removal to materials:', mirrorErr.message);
    }

    m.swatch_url = null;
    render();
    showStatus(`Removed swatch for ${colorName}.`, 'success');
  } catch (err) {
    if (card) card.classList.remove('uploading');
    showStatus(`Remove failed: ${err.message || String(err)}`, 'error');
  }
}

// Extract the storage path (after the bucket segment) from a Supabase public
// URL. Works for URLs like:
//   https://<proj>.supabase.co/storage/v1/object/public/proposal-photos/swatches/<id>.jpg?v=123
function extractStoragePath(publicUrl) {
  try {
    const marker = `/object/public/${BUCKET}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return null;
    let path = publicUrl.substring(idx + marker.length);
    // Strip query string
    const q = path.indexOf('?');
    if (q !== -1) path = path.substring(0, q);
    return path;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

// Best-effort color name extraction. Different catalog imports have used
// different column names, so we try a few in priority order.
function colorNameOf(m) {
  return (
    m.color_name ||
    m.color ||
    m.variant_name ||
    m.variant ||
    m.name ||
    '—'
  );
}

// Best-effort size/variant summary (e.g. "12x6, 12x9, 12x12"). Optional.
function sizeSummaryOf(m) {
  if (m.sizes && typeof m.sizes === 'string') return m.sizes;
  if (Array.isArray(m.sizes)) return m.sizes.join(', ');
  if (m.size) return m.size;
  return '';
}

let statusTimer = null;
function showStatus(msg, kind) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = `status visible ${kind || ''}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, 4500);
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
