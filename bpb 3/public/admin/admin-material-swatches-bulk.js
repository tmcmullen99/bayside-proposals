// ═══════════════════════════════════════════════════════════════════════════
// Bulk Material Swatches Upload (admin)
//
// Workflow:
//   1. Tim drops a folder of swatch images (e.g. "Dimensions™ Pavers _ Belgard")
//   2. Tool auto-detects product family from folder name by stripping noise
//      tokens ("Pavers", "Belgard", ™, ®, etc.) and fuzzy-matching against
//      belgard_materials.product_name
//   3. Parses each filename with this regex:
//        /^imgi_\d+_\d+_(?:NC_)?(.+?)_(?:DF|CM)_D[\dx]+_/
//      Group 1 = color words (underscore-separated), then converts _ → space
//   4. Dedupes by color, preferring files matching /1024x1024/ over plain over
//      " (1)" copies (all three are typically present per color in a bulk
//      download from Belgard's page)
//   5. Matches each color to catalog variants (product_name IN family ×
//      color IN parsed colors). Skips variants that already have a swatch_url.
//   6. Preview grid shows thumb + match status per color
//   7. Click Upload all → for each color: upload image ONCE to Supabase Storage
//      at swatches/{uuid}.{ext}, then UPDATE every catalog row in the family
//      with matching color to point at that URL
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

// DOM references
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const familyCard = document.getElementById('familyCard');
const familyTitle = document.getElementById('familyTitle');
const familyOverride = document.getElementById('familyOverride');
const sumImages = document.getElementById('sumImages');
const sumColors = document.getElementById('sumColors');
const sumMatches = document.getElementById('sumMatches');
const sumRows = document.getElementById('sumRows');
const previewGrid = document.getElementById('previewGrid');
const actionMsg = document.getElementById('actionMsg');
const uploadBtn = document.getElementById('uploadBtn');
const resetBtn = document.getElementById('resetBtn');
const statusBox = document.getElementById('status');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const progressPct = document.getElementById('progressPct');

// State
const ctx = {
  catalog: [],          // all belgard_materials rows
  productFamilies: [],  // DISTINCT product_name array from catalog
  folderName: '',       // original folder name from drop
  familyKey: '',        // auto-detected family (e.g. "Dimensions")
  matchedProducts: [],  // catalog products starting with familyKey
  colorsByKey: {},      // normalized_color → { name, file, blobUrl, status, variants[] }
};

// Noise tokens to strip from folder names when detecting product family.
// "Pavers", "Belgard", etc. appear in every Belgard folder because that's
// how Save Page As names the containing folder.
const FOLDER_NOISE = [
  'pavers', 'paver',
  'belgard',
  'retaining', 'walls', 'wall',
  'coping', 'treads', 'caps', 'edgers', 'steps', 'step',
  'porcelain',
  'outdoor', 'living', 'kitchens', 'kitchen',
  'fire', 'pit', 'pits',
  'slab', 'slabs',
  'concrete',
];

// ───────────────────────────────────────────────────────────────────────────
// Bootstrap
// ───────────────────────────────────────────────────────────────────────────
(async function init() {
  await loadCatalog();
  attachEventListeners();
})();

async function loadCatalog() {
  const { data, error } = await supabase
    .from('belgard_materials')
    .select('id, product_name, color, swatch_url')
    .order('product_name', { ascending: true });

  if (error) {
    showStatus('error', `Could not load catalog: ${error.message}`);
    return;
  }

  ctx.catalog = data || [];
  // Unique product names for the override dropdown
  const uniq = Array.from(new Set(ctx.catalog.map(r => r.product_name))).sort();
  ctx.productFamilies = uniq;

  familyOverride.innerHTML =
    '<option value="">(auto-detected above)</option>' +
    uniq.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
}

function attachEventListeners() {
  // Drag/drop
  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', handleDrop);

  // File picker fallback (click to select)
  fileInput.addEventListener('change', (e) => {
    handleFileList(Array.from(e.target.files));
  });

  // Family override dropdown: re-run matching with manually chosen family
  familyOverride.addEventListener('change', () => {
    const chosen = familyOverride.value;
    if (chosen) {
      ctx.familyKey = chosen;
      // Find all catalog products matching this family exactly (since override
      // picks one specific product_name, we use equality not prefix)
      ctx.matchedProducts = ctx.catalog
        .filter(r => r.product_name === chosen)
        .map(r => r.product_name);
      ctx.matchedProducts = Array.from(new Set(ctx.matchedProducts));
      rematchAndRender();
    }
  });

  uploadBtn.addEventListener('click', runUpload);
  resetBtn.addEventListener('click', resetAll);
}

// ───────────────────────────────────────────────────────────────────────────
// Drop handling
// ───────────────────────────────────────────────────────────────────────────
async function handleDrop(e) {
  const files = [];
  const items = e.dataTransfer.items;

  if (items && items.length && items[0].webkitGetAsEntry) {
    // Folder-aware drop: walk the directory tree
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry) continue;
      if (entry.isDirectory) {
        // Capture folder name for product matching
        if (!ctx.folderName) ctx.folderName = entry.name;
        await walkDir(entry, files);
      } else if (entry.isFile) {
        const file = await entryToFile(entry);
        if (file) files.push(file);
      }
    }
  } else {
    // Fallback: flat file list
    for (const file of e.dataTransfer.files) {
      files.push(file);
    }
  }

  handleFileList(files);
}

function walkDir(dirEntry, out) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader();
    const readAll = () => {
      reader.readEntries(async (entries) => {
        if (!entries.length) return resolve();
        for (const entry of entries) {
          if (entry.isFile) {
            const file = await entryToFile(entry);
            if (file) out.push(file);
          } else if (entry.isDirectory) {
            await walkDir(entry, out);
          }
        }
        readAll();
      });
    };
    readAll();
  });
}

function entryToFile(entry) {
  return new Promise((resolve) => {
    entry.file(resolve, () => resolve(null));
  });
}

function handleFileList(files) {
  // Filter to images only
  const imageFiles = files.filter(f =>
    /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name)
  );

  if (imageFiles.length === 0) {
    showStatus('error', 'No image files found. Please drop JPG/PNG/WEBP files.');
    return;
  }

  // If no folder name yet (user clicked to select files), derive one from
  // the first file's webkitRelativePath if available
  if (!ctx.folderName && imageFiles[0].webkitRelativePath) {
    ctx.folderName = imageFiles[0].webkitRelativePath.split('/')[0];
  }

  detectFamily();
  parseAndMatch(imageFiles);
  renderPreview();

  familyCard.classList.add('visible');
  familyCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ───────────────────────────────────────────────────────────────────────────
// Product family detection
// ───────────────────────────────────────────────────────────────────────────
function detectFamily() {
  if (!ctx.folderName) {
    // No folder name available — force manual override
    familyTitle.textContent = 'No product detected (choose manually →)';
    ctx.familyKey = '';
    ctx.matchedProducts = [];
    return;
  }

  // Tokenize: split on whitespace, underscores, non-word chars like ™®_
  const tokens = ctx.folderName
    .replace(/[®™©]/g, '')
    .replace(/[_\-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t && !FOLDER_NOISE.includes(t));

  // The remaining tokens are the product family name
  // Re-case them using the catalog as ground truth
  const familyLower = tokens.join(' ').trim();

  if (!familyLower) {
    familyTitle.textContent = 'Could not detect product (choose manually →)';
    ctx.familyKey = '';
    ctx.matchedProducts = [];
    return;
  }

  // Find all product_name values in the catalog that START WITH this family
  // (case-insensitive). E.g. "dimensions" matches "Dimensions 12",
  // "Dimensions 18", "Dimensions 24".
  const matched = ctx.productFamilies.filter(p =>
    p.toLowerCase().startsWith(familyLower) ||
    familyLower.startsWith(p.toLowerCase())
  );

  if (matched.length === 0) {
    familyTitle.innerHTML =
      `<span style="color: var(--danger);">No matching product</span> ` +
      `<small>folder: "${escapeHtml(ctx.folderName)}"</small>`;
    ctx.familyKey = '';
    ctx.matchedProducts = [];
    return;
  }

  ctx.familyKey = familyLower;
  ctx.matchedProducts = matched;
  familyTitle.innerHTML =
    `${escapeHtml(matched.join(' · '))} ` +
    `<small>from folder "${escapeHtml(ctx.folderName)}"</small>`;
}

// ───────────────────────────────────────────────────────────────────────────
// Filename parsing + catalog matching
// ───────────────────────────────────────────────────────────────────────────
// Regex breakdown:
//   ^imgi_         Prefix common to Belgard's Save Page As dumps
//   \d+_\d+_       Two numeric blocks (ID and category code)
//   (?:NC_)?       Optional "NC" prefix (Natural Collection or similar)
//   (.+?)          Group 1: color words (underscore-separated)
//   _(?:DF|CM)_    Separator: DF or CM (finish code)
//   D[\dx]+        Size code (D12, D3x12, D6x9, etc.)
const FILENAME_REGEX = /^imgi_\d+_\d+_(?:NC_)?(.+?)_(?:DF|CM)_D[\dx]+/i;

function parseColor(filename) {
  const base = filename.replace(/\.(jpe?g|png|webp)$/i, '');
  const match = base.match(FILENAME_REGEX);
  if (!match) return null;
  return match[1]
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeColor(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Preference ranking for duplicate files of the same color. Lower is better.
// Belgard bulk downloads typically give us three copies per color:
//   Anthracite_DF_D12_Modular-1024x1024.jpg    ← best (full res)
//   Anthracite_DF_D12_Modular.jpg              ← base (probably the same res)
//   Anthracite_DF_D12_Modular (1).jpg          ← browser-added duplicate
function filePreferenceRank(filename) {
  if (/1024x1024/i.test(filename)) return 0;
  if (/\s\(\d+\)\./.test(filename)) return 2;
  return 1;
}

function parseAndMatch(files) {
  ctx.colorsByKey = {};

  for (const file of files) {
    const color = parseColor(file.name);
    if (!color) {
      // Unparseable filename — track it as an error entry
      const key = `__unparsed_${file.name}`;
      ctx.colorsByKey[key] = {
        name: file.name,
        colorLabel: '(unparseable)',
        file,
        status: 'fail',
        variants: [],
        reason: 'Filename does not match expected Belgard pattern',
      };
      continue;
    }

    const key = normalizeColor(color);
    const existing = ctx.colorsByKey[key];

    // Keep the best-ranked file per color
    if (existing && existing.file) {
      const existingRank = filePreferenceRank(existing.file.name);
      const newRank = filePreferenceRank(file.name);
      if (newRank >= existingRank) continue; // keep existing
    }

    ctx.colorsByKey[key] = {
      name: file.name,
      colorLabel: color,
      file,
      status: 'pending',
      variants: [],
    };
  }

  // Match each detected color to catalog variants
  for (const key in ctx.colorsByKey) {
    const entry = ctx.colorsByKey[key];
    if (entry.status === 'fail') continue;

    const candidates = ctx.catalog.filter(row =>
      ctx.matchedProducts.includes(row.product_name) &&
      normalizeColor(row.color) === key
    );

    if (candidates.length === 0) {
      entry.status = 'warn';
      entry.variants = [];
      entry.reason = `No catalog variant matches color "${entry.colorLabel}" in ${ctx.matchedProducts.join(' / ') || 'the selected family'}`;
      continue;
    }

    // Filter out variants that already have a swatch_url (skip per user rule)
    const needSwatch = candidates.filter(c => !c.swatch_url);
    const alreadyHave = candidates.length - needSwatch.length;

    if (needSwatch.length === 0) {
      entry.status = 'skip';
      entry.variants = candidates;
      entry.reason = `All ${candidates.length} variants already have a swatch (skipping)`;
    } else {
      entry.status = 'match';
      entry.variants = needSwatch;
      entry.alreadyHave = alreadyHave;
    }
  }

  // Build blob URLs for thumbnails (only when the file is still present)
  for (const key in ctx.colorsByKey) {
    const entry = ctx.colorsByKey[key];
    if (entry.file) {
      entry.blobUrl = URL.createObjectURL(entry.file);
    }
  }
}

function rematchAndRender() {
  // Used when user changes family override. We rebuild the catalog match
  // for existing colors without re-parsing files.
  for (const key in ctx.colorsByKey) {
    const entry = ctx.colorsByKey[key];
    if (entry.status === 'fail') continue;

    const candidates = ctx.catalog.filter(row =>
      ctx.matchedProducts.includes(row.product_name) &&
      normalizeColor(row.color) === key
    );

    if (candidates.length === 0) {
      entry.status = 'warn';
      entry.variants = [];
      entry.reason = `No catalog variant matches color "${entry.colorLabel}" in ${ctx.matchedProducts.join(' / ') || 'the selected family'}`;
      continue;
    }

    const needSwatch = candidates.filter(c => !c.swatch_url);
    const alreadyHave = candidates.length - needSwatch.length;

    if (needSwatch.length === 0) {
      entry.status = 'skip';
      entry.variants = candidates;
      entry.reason = `All ${candidates.length} variants already have a swatch (skipping)`;
    } else {
      entry.status = 'match';
      entry.variants = needSwatch;
      entry.alreadyHave = alreadyHave;
    }
  }
  renderPreview();
}

// ───────────────────────────────────────────────────────────────────────────
// Preview rendering
// ───────────────────────────────────────────────────────────────────────────
function renderPreview() {
  const entries = Object.values(ctx.colorsByKey);
  const imageCount = entries.filter(e => e.file).length;
  const colorCount = entries.filter(e => e.status !== 'fail').length;
  const matchedEntries = entries.filter(e => e.status === 'match');
  const totalRowsToUpdate = matchedEntries.reduce((s, e) => s + e.variants.length, 0);

  sumImages.textContent = imageCount;
  sumColors.textContent = colorCount;
  sumMatches.textContent = matchedEntries.length;
  sumRows.textContent = totalRowsToUpdate;

  // Sort: matches first, then skips, then warns, then fails
  const rank = { match: 0, skip: 1, warn: 2, fail: 3, pending: 99 };
  entries.sort((a, b) => (rank[a.status] ?? 99) - (rank[b.status] ?? 99));

  previewGrid.innerHTML = entries.map(e => {
    const statusLabel = {
      match: `${e.variants.length} ✓`,
      skip: 'skipped',
      warn: 'no match',
      fail: 'unparseable',
    }[e.status] || e.status;

    const thumb = e.blobUrl
      ? `<img src="${e.blobUrl}" alt="">`
      : `<span style="color:var(--muted);font-size:11px;">no preview</span>`;

    const info = e.status === 'match'
      ? `${e.variants.length} variant${e.variants.length === 1 ? '' : 's'} · ${ctx.matchedProducts.length} product${ctx.matchedProducts.length === 1 ? '' : 's'}${e.alreadyHave ? ` · ${e.alreadyHave} already had` : ''}`
      : (e.reason || '');

    return `
      <div class="preview-card">
        <div class="preview-thumb">
          ${thumb}
          <span class="preview-status ${e.status}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="preview-body">
          <div class="preview-color">${escapeHtml(e.colorLabel)}</div>
          <div class="preview-info">${escapeHtml(info)}</div>
        </div>
      </div>
    `;
  }).join('');

  // Update action bar
  if (matchedEntries.length === 0) {
    actionMsg.textContent = 'Nothing to upload — no matches found.';
    uploadBtn.disabled = true;
  } else {
    actionMsg.textContent = `Ready to upload ${matchedEntries.length} swatches and write ${totalRowsToUpdate} catalog rows.`;
    uploadBtn.disabled = false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Upload execution
// ───────────────────────────────────────────────────────────────────────────
async function runUpload() {
  const matchedEntries = Object.values(ctx.colorsByKey).filter(e => e.status === 'match');
  if (matchedEntries.length === 0) return;

  uploadBtn.disabled = true;
  resetBtn.disabled = true;
  progressWrap.style.display = 'block';
  actionMsg.textContent = '';

  let done = 0;
  let uploadedCount = 0;
  let rowsUpdated = 0;
  let errors = 0;

  for (const entry of matchedEntries) {
    progressText.textContent = `Uploading ${entry.colorLabel}… (${done + 1}/${matchedEntries.length})`;

    try {
      // 1. Upload the file to Supabase Storage, keyed by first variant's ID
      //    (for uniqueness). Using the first variant means re-runs land at
      //    the same path, avoiding Storage bloat.
      const firstVariantId = entry.variants[0].id;
      const ext = entry.file.name.match(/\.(\w+)$/i)?.[1]?.toLowerCase() || 'jpg';
      const storagePath = `swatches/${firstVariantId}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from('proposal-photos')
        .upload(storagePath, entry.file, {
          upsert: true,
          contentType: entry.file.type || 'image/jpeg',
        });

      if (uploadErr) {
        console.error('Upload error', entry.colorLabel, uploadErr);
        entry.status = 'fail';
        entry.reason = `Storage upload failed: ${uploadErr.message}`;
        errors++;
        done++;
        updateProgress(done, matchedEntries.length);
        continue;
      }

      // 2. Get public URL with cache-buster
      const { data: publicUrlData } = supabase.storage
        .from('proposal-photos')
        .getPublicUrl(storagePath);
      const publicUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;

      // 3. Update every catalog variant for this color (that didn't already
      //    have a swatch). This is why we stored entry.variants already
      //    filtered to needSwatch-only.
      const ids = entry.variants.map(v => v.id);
      const { error: updateErr } = await supabase
        .from('belgard_materials')
        .update({ swatch_url: publicUrl })
        .in('id', ids)
        .is('swatch_url', null); // defensive: only write if still null

      if (updateErr) {
        console.error('Update error', entry.colorLabel, updateErr);
        entry.status = 'fail';
        entry.reason = `Catalog update failed: ${updateErr.message}`;
        errors++;
      } else {
        uploadedCount++;
        rowsUpdated += entry.variants.length;
        entry.status = 'skip'; // visually mark as done
        entry.reason = `✓ Uploaded and wrote to ${entry.variants.length} variants`;
      }
    } catch (err) {
      console.error('Unexpected error', entry.colorLabel, err);
      entry.status = 'fail';
      entry.reason = `Unexpected: ${err.message}`;
      errors++;
    }

    done++;
    updateProgress(done, matchedEntries.length);
  }

  // Final state
  progressWrap.style.display = 'none';
  renderPreview();

  if (errors === 0) {
    showStatus('success',
      `✓ Done. Uploaded ${uploadedCount} swatches, updated ${rowsUpdated} catalog rows. ` +
      `You can close this page or drop another product folder to continue.`);
  } else {
    showStatus('error',
      `Finished with ${errors} errors. ${uploadedCount} succeeded (${rowsUpdated} rows). ` +
      `Check the preview grid above for which colors failed.`);
  }

  uploadBtn.disabled = false;
  resetBtn.disabled = false;
  // Reload catalog so subsequent drops see updated swatch_urls
  await loadCatalog();
}

function updateProgress(done, total) {
  const pct = Math.round((done / total) * 100);
  progressBar.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
}

// ───────────────────────────────────────────────────────────────────────────
// Reset
// ───────────────────────────────────────────────────────────────────────────
function resetAll() {
  // Revoke any outstanding blob URLs
  for (const key in ctx.colorsByKey) {
    const entry = ctx.colorsByKey[key];
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  }
  ctx.colorsByKey = {};
  ctx.folderName = '';
  ctx.familyKey = '';
  ctx.matchedProducts = [];
  familyOverride.value = '';
  familyCard.classList.remove('visible');
  fileInput.value = '';
  hideStatus();
}

// ───────────────────────────────────────────────────────────────────────────
// Utils
// ───────────────────────────────────────────────────────────────────────────
function showStatus(type, msg) {
  statusBox.className = `status visible ${type}`;
  statusBox.textContent = msg;
  statusBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideStatus() {
  statusBox.className = 'status';
  statusBox.textContent = '';
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
