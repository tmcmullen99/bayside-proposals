// ═══════════════════════════════════════════════════════════════════════════
// Bulk Material Swatches Upload — MULTI-FOLDER (admin)
//
// Workflow:
//   1. Tim drops many product folders at once from Finder (one drop, N folders)
//   2. Tool walks the dropped directory tree, groups files by their top-level
//      folder name. Each folder becomes its own "family" object in ctx.families.
//   3. For each family, runs detectFamily() on the folder name to match against
//      belgard_materials.product_name. Parses filenames to extract colors.
//      Matches colors to catalog variants, skipping those that already have
//      swatch_url populated.
//   4. Renders one .family-card per folder in the container. User can review,
//      override product family, or remove individual folders from the batch.
//   5. Clicks global "Upload all" → iterates every family with matched colors,
//      uploads each color's image to Supabase Storage once, updates all catalog
//      rows for that color. Global progress bar tracks across all folders.
//
// Filename parser (same as single-folder version):
//   /^imgi_\d+_\d+_(?:NC_)?(.+?)_(?:DF|CM)_D[\dx]+/i
//   Group 1: color words (underscore-separated) → replace _ with space
//
// Product family detection:
//   Folder name → strip ™®, _, noise tokens (Pavers, Belgard, Wall, etc.)
//   → match against DISTINCT product_name list (prefix match, case-insensitive)
//   → multiple matches returned (Dimensions matches "Dimensions 12" +
//     "Dimensions 18" etc.)
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

// ── DOM references ─────────────────────────────────────────────────────────
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const familiesContainer = document.getElementById('familiesContainer');
const globalActionBar = document.getElementById('globalActionBar');
const gSumFolders = document.getElementById('gSumFolders');
const gSumImages = document.getElementById('gSumImages');
const gSumMatched = document.getElementById('gSumMatched');
const gSumRows = document.getElementById('gSumRows');
const globalReset = document.getElementById('globalReset');
const globalUpload = document.getElementById('globalUpload');
const globalProgress = document.getElementById('globalProgress');
const globalProgressBar = document.getElementById('globalProgressBar');
const globalProgressText = document.getElementById('globalProgressText');
const globalProgressPct = document.getElementById('globalProgressPct');
const statusBox = document.getElementById('status');

// ── State ──────────────────────────────────────────────────────────────────
// families: { [folderName]: familyObject }
// familyObject: {
//   folderName, familyKey, matchedProducts[],
//   colorsByKey: { [normColor]: { name, colorLabel, file, blobUrl, status, variants[], reason, alreadyHave } },
//   cardEl (DOM), isDone
// }
const ctx = {
  catalog: [],
  productFamilies: [],
  families: {},       // keyed by folderName, order preserved via Object insertion
};

// Noise tokens to strip when deriving product family from folder name.
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

// Regex for Belgard bulk-downloaded filenames
const FILENAME_REGEX = /^imgi_\d+_\d+_(?:NC_)?(.+?)_(?:DF|CM)_D[\dx]+/i;

// ── Bootstrap ──────────────────────────────────────────────────────────────
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
  const uniq = Array.from(new Set(ctx.catalog.map(r => r.product_name))).sort();
  ctx.productFamilies = uniq;
}

function attachEventListeners() {
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

  fileInput.addEventListener('change', (e) => {
    handleFlatFileList(Array.from(e.target.files));
  });

  globalUpload.addEventListener('click', runGlobalUpload);
  globalReset.addEventListener('click', resetAll);
}

// ── Drop handling ──────────────────────────────────────────────────────────
// When user drops N folders at once, dataTransfer.items gives us N entries.
// Each is a directory (or loose file). We walk each directory and group files
// by their top-level folder name.
async function handleDrop(e) {
  // folderMap: { folderName: [File, File, ...] }
  const folderMap = {};
  const looseFiles = [];

  const items = Array.from(e.dataTransfer.items || []);
  if (items.length && items[0].webkitGetAsEntry) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry) continue;
      if (entry.isDirectory) {
        const files = [];
        await walkDir(entry, files);
        folderMap[entry.name] = files;
      } else if (entry.isFile) {
        const file = await entryToFile(entry);
        if (file) looseFiles.push(file);
      }
    }
  } else {
    // Fallback: flat file list
    for (const file of e.dataTransfer.files) looseFiles.push(file);
  }

  // If loose files were also dropped (not inside a folder), group them under
  // a pseudo-folder so they still get processed.
  if (looseFiles.length > 0) {
    folderMap['(loose files)'] = (folderMap['(loose files)'] || []).concat(looseFiles);
  }

  if (Object.keys(folderMap).length === 0) {
    showStatus('error', 'No folders detected. Drag one or more product folders from Finder.');
    return;
  }

  for (const [folderName, files] of Object.entries(folderMap)) {
    ingestFolder(folderName, files);
  }

  updateGlobalBar();
  renderFamilies();
  scrollToGlobalBar();
}

// Fallback for file picker (click-select): use webkitRelativePath to group.
function handleFlatFileList(files) {
  if (files.length === 0) return;

  const folderMap = {};
  for (const file of files) {
    const rel = file.webkitRelativePath || '';
    const top = rel.split('/')[0] || '(loose files)';
    if (!folderMap[top]) folderMap[top] = [];
    folderMap[top].push(file);
  }

  for (const [folderName, fs] of Object.entries(folderMap)) {
    ingestFolder(folderName, fs);
  }

  updateGlobalBar();
  renderFamilies();
  scrollToGlobalBar();
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

// ── Ingest a single folder's files into the state ─────────────────────────
function ingestFolder(folderName, files) {
  // Filter to images
  const imageFiles = files.filter(f =>
    /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name)
  );

  if (imageFiles.length === 0) {
    // Skip folders with no images silently
    return;
  }

  // If this folder was already ingested earlier this session, replace it
  if (ctx.families[folderName]?.blobUrls) {
    for (const url of ctx.families[folderName].blobUrls) {
      URL.revokeObjectURL(url);
    }
  }

  const family = {
    folderName,
    familyKey: '',
    matchedProducts: [],
    colorsByKey: {},
    blobUrls: [],
    isDone: false,
    isUploading: false,
  };

  detectFamily(family);
  parseAndMatch(family, imageFiles);

  ctx.families[folderName] = family;
}

// ── Product family detection ───────────────────────────────────────────────
function detectFamily(family) {
  const tokens = family.folderName
    .replace(/[®™©]/g, '')
    .replace(/[_\-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t && !FOLDER_NOISE.includes(t));

  const familyLower = tokens.join(' ').trim();

  if (!familyLower) {
    family.familyKey = '';
    family.matchedProducts = [];
    return;
  }

  // Prefix match in both directions
  const matched = ctx.productFamilies.filter(p =>
    p.toLowerCase().startsWith(familyLower) ||
    familyLower.startsWith(p.toLowerCase())
  );

  family.familyKey = familyLower;
  family.matchedProducts = matched;
}

// ── Parse files + match to catalog ─────────────────────────────────────────
function parseColor(filename) {
  const base = filename.replace(/\.(jpe?g|png|webp)$/i, '');
  const match = base.match(FILENAME_REGEX);
  if (!match) return null;
  return match[1].replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeColor(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Lower rank = better preferred file when we see duplicates of the same color.
// Belgard bulk downloads typically include three copies per color:
//   *-1024x1024.jpg  (best — hi-res)
//   *.jpg            (base — probably same)
//   * (1).jpg        (browser-added duplicate — worst)
function filePreferenceRank(filename) {
  if (/1024x1024/i.test(filename)) return 0;
  if (/\s\(\d+\)\./.test(filename)) return 2;
  return 1;
}

function parseAndMatch(family, files) {
  family.colorsByKey = {};

  for (const file of files) {
    const color = parseColor(file.name);
    if (!color) {
      const key = `__unparsed_${file.name}`;
      family.colorsByKey[key] = {
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
    const existing = family.colorsByKey[key];

    if (existing && existing.file) {
      const existingRank = filePreferenceRank(existing.file.name);
      const newRank = filePreferenceRank(file.name);
      if (newRank >= existingRank) continue;
    }

    family.colorsByKey[key] = {
      name: file.name,
      colorLabel: color,
      file,
      status: 'pending',
      variants: [],
    };
  }

  // Match colors to catalog
  matchFamilyColors(family);

  // Build blob URLs for thumbnails
  for (const key in family.colorsByKey) {
    const entry = family.colorsByKey[key];
    if (entry.file && !entry.blobUrl) {
      entry.blobUrl = URL.createObjectURL(entry.file);
      family.blobUrls.push(entry.blobUrl);
    }
  }
}

function matchFamilyColors(family) {
  for (const key in family.colorsByKey) {
    const entry = family.colorsByKey[key];
    if (entry.status === 'fail') continue;
    if (entry.status === 'uploaded') continue; // don't overwrite post-upload state

    const candidates = ctx.catalog.filter(row =>
      family.matchedProducts.includes(row.product_name) &&
      normalizeColor(row.color) === key
    );

    if (candidates.length === 0) {
      entry.status = 'warn';
      entry.variants = [];
      entry.reason = family.matchedProducts.length === 0
        ? 'No product family matched this folder'
        : `No catalog variant matches "${entry.colorLabel}" in ${family.matchedProducts.join(' / ')}`;
      continue;
    }

    const needSwatch = candidates.filter(c => !c.swatch_url);
    const alreadyHave = candidates.length - needSwatch.length;

    if (needSwatch.length === 0) {
      entry.status = 'skip';
      entry.variants = candidates;
      entry.reason = `All ${candidates.length} variants already have a swatch`;
      entry.alreadyHave = alreadyHave;
    } else {
      entry.status = 'match';
      entry.variants = needSwatch;
      entry.alreadyHave = alreadyHave;
      entry.reason = '';
    }
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderFamilies() {
  familiesContainer.innerHTML = '';

  const families = Object.values(ctx.families);
  for (const family of families) {
    const card = renderFamilyCard(family);
    familiesContainer.appendChild(card);
    family.cardEl = card;
  }
}

function renderFamilyCard(family) {
  const card = document.createElement('div');
  card.className = 'family-card';
  if (family.isDone) card.classList.add('is-done');
  if (family.isUploading) card.classList.add('is-uploading');

  const entries = Object.values(family.colorsByKey);
  const imageCount = entries.filter(e => e.file).length;
  const matchedEntries = entries.filter(e => e.status === 'match');
  const skippedEntries = entries.filter(e => e.status === 'skip');
  const warnEntries = entries.filter(e => e.status === 'warn');
  const uploadedEntries = entries.filter(e => e.status === 'uploaded');
  const totalRowsToUpdate = matchedEntries.reduce((s, e) => s + e.variants.length, 0);
  const totalRowsWritten = uploadedEntries.reduce((s, e) => s + (e.variantsWritten || 0), 0);

  // Header: title (detected family or warning), override dropdown, remove btn
  const title = family.matchedProducts.length > 0
    ? escapeHtml(family.matchedProducts.join(' · '))
    : `<span style="color: var(--danger);">Could not auto-detect product</span>`;

  const overrideOptions = ['<option value="">(auto-detected)</option>']
    .concat(ctx.productFamilies.map(p =>
      `<option value="${escapeHtml(p)}"${family.matchedProducts.length === 1 && family.matchedProducts[0] === p ? ' selected' : ''}>${escapeHtml(p)}</option>`
    )).join('');

  card.innerHTML = `
    <div class="family-header">
      <div class="family-title-wrap">
        <div class="family-title">
          ${title}
          <small>${escapeHtml(family.folderName)}</small>
        </div>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <div class="family-override">
          Override:
          <select data-folder="${escapeHtml(family.folderName)}" class="family-override-select">
            ${overrideOptions}
          </select>
        </div>
        <button class="family-remove" data-folder="${escapeHtml(family.folderName)}" title="Remove this folder">×</button>
      </div>
    </div>

    <div class="family-summary">
      <div class="summary-box">
        <div class="summary-num">${imageCount}</div>
        <div class="summary-label">Images</div>
      </div>
      <div class="summary-box">
        <div class="summary-num ${matchedEntries.length > 0 ? 'green' : ''}">${matchedEntries.length}</div>
        <div class="summary-label">Matched</div>
      </div>
      <div class="summary-box">
        <div class="summary-num ${totalRowsToUpdate > 0 ? 'green' : ''}">${totalRowsToUpdate}</div>
        <div class="summary-label">Rows to write</div>
      </div>
      <div class="summary-box">
        <div class="summary-num">${skippedEntries.length}</div>
        <div class="summary-label">Already had swatch</div>
      </div>
      ${warnEntries.length > 0 ? `
        <div class="summary-box">
          <div class="summary-num" style="color:var(--warn-text);">${warnEntries.length}</div>
          <div class="summary-label">No match</div>
        </div>
      ` : ''}
      ${uploadedEntries.length > 0 ? `
        <div class="summary-box">
          <div class="summary-num green">${uploadedEntries.length}</div>
          <div class="summary-label">Uploaded<br>(${totalRowsWritten} rows)</div>
        </div>
      ` : ''}
    </div>

    <div class="preview-grid" data-folder="${escapeHtml(family.folderName)}">
      ${renderPreviewGrid(family)}
    </div>
  `;

  // Wire up the override dropdown
  card.querySelector('.family-override-select')?.addEventListener('change', (e) => {
    const chosen = e.target.value;
    if (chosen) {
      family.matchedProducts = [chosen];
      family.familyKey = chosen.toLowerCase();
    } else {
      // Re-detect from folder name
      detectFamily(family);
    }
    matchFamilyColors(family);
    renderFamilies();
    updateGlobalBar();
  });

  // Wire up the remove button
  card.querySelector('.family-remove')?.addEventListener('click', () => {
    // Revoke blob URLs to free memory
    for (const url of family.blobUrls) URL.revokeObjectURL(url);
    delete ctx.families[family.folderName];
    renderFamilies();
    updateGlobalBar();
  });

  return card;
}

function renderPreviewGrid(family) {
  const entries = Object.values(family.colorsByKey);
  // Sort: uploaded first, then match, then skip, then warn, then fail
  const rank = { uploaded: 0, match: 1, skip: 2, warn: 3, fail: 4, pending: 99 };
  entries.sort((a, b) => (rank[a.status] ?? 99) - (rank[b.status] ?? 99));

  return entries.map(e => {
    const statusLabel = {
      match: `${e.variants.length} ✓`,
      uploaded: `✓ wrote ${e.variantsWritten || 0}`,
      skip: 'skipped',
      warn: 'no match',
      fail: 'failed',
    }[e.status] || e.status;

    const thumb = e.blobUrl
      ? `<img src="${escapeAttr(e.blobUrl)}" alt="">`
      : `<span style="color:var(--muted);font-size:10px;">no preview</span>`;

    const info = e.status === 'match'
      ? `${e.variants.length} variant${e.variants.length === 1 ? '' : 's'}${e.alreadyHave ? ` · ${e.alreadyHave} had` : ''}`
      : e.status === 'uploaded'
        ? (e.reason || `wrote ${e.variantsWritten || 0} rows`)
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
}

// ── Global summary bar ─────────────────────────────────────────────────────
function updateGlobalBar() {
  const families = Object.values(ctx.families);
  if (families.length === 0) {
    globalActionBar.classList.remove('visible');
    return;
  }

  let totalImages = 0;
  let totalMatched = 0;
  let totalRows = 0;

  for (const f of families) {
    const entries = Object.values(f.colorsByKey);
    totalImages += entries.filter(e => e.file).length;
    const matched = entries.filter(e => e.status === 'match');
    totalMatched += matched.length;
    totalRows += matched.reduce((s, e) => s + e.variants.length, 0);
  }

  gSumFolders.textContent = families.length;
  gSumImages.textContent = totalImages;
  gSumMatched.textContent = totalMatched;
  gSumRows.textContent = totalRows;

  globalActionBar.classList.add('visible');

  if (totalMatched === 0) {
    globalUpload.disabled = true;
    globalUpload.textContent = 'Nothing to upload';
  } else {
    globalUpload.disabled = false;
    globalUpload.textContent = `Upload all → (${totalRows} rows)`;
  }
}

// ── Global upload orchestration ────────────────────────────────────────────
async function runGlobalUpload() {
  const families = Object.values(ctx.families);

  // Build a flat list of all match entries across all families
  const allJobs = [];
  for (const family of families) {
    for (const entry of Object.values(family.colorsByKey)) {
      if (entry.status === 'match') {
        allJobs.push({ family, entry });
      }
    }
  }

  if (allJobs.length === 0) return;

  globalUpload.disabled = true;
  globalReset.disabled = true;
  globalProgress.classList.add('visible');

  let done = 0;
  let uploadedColors = 0;
  let rowsWritten = 0;
  let errors = 0;

  for (const job of allJobs) {
    const { family, entry } = job;
    family.isUploading = true;
    if (family.cardEl) family.cardEl.classList.add('is-uploading');

    globalProgressText.textContent =
      `[${family.folderName}] Uploading ${entry.colorLabel}… (${done + 1}/${allJobs.length})`;

    try {
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
        entry.reason = `Storage: ${uploadErr.message}`;
        errors++;
      } else {
        const { data: pub } = supabase.storage
          .from('proposal-photos')
          .getPublicUrl(storagePath);
        const publicUrl = `${pub.publicUrl}?v=${Date.now()}`;

        const ids = entry.variants.map(v => v.id);
        const { error: updateErr } = await supabase
          .from('belgard_materials')
          .update({ swatch_url: publicUrl })
          .in('id', ids)
          .is('swatch_url', null);

        if (updateErr) {
          console.error('Update error', entry.colorLabel, updateErr);
          entry.status = 'fail';
          entry.reason = `DB: ${updateErr.message}`;
          errors++;
        } else {
          entry.status = 'uploaded';
          entry.variantsWritten = entry.variants.length;
          entry.reason = `Wrote to ${entry.variants.length} variants`;
          uploadedColors++;
          rowsWritten += entry.variants.length;

          // Patch local catalog so future drops see updated state
          for (const v of entry.variants) {
            const cached = ctx.catalog.find(c => c.id === v.id);
            if (cached) cached.swatch_url = publicUrl;
          }
        }
      }
    } catch (err) {
      console.error('Unexpected', entry.colorLabel, err);
      entry.status = 'fail';
      entry.reason = `Unexpected: ${err.message}`;
      errors++;
    }

    done++;
    const pct = Math.round((done / allJobs.length) * 100);
    globalProgressBar.style.width = `${pct}%`;
    globalProgressPct.textContent = `${pct}%`;
  }

  // Mark each family as done if all its match entries are now uploaded
  for (const family of families) {
    const stillMatching = Object.values(family.colorsByKey)
      .some(e => e.status === 'match');
    if (!stillMatching) {
      family.isDone = true;
      family.isUploading = false;
    }
  }

  // Re-render to show updated state
  renderFamilies();
  updateGlobalBar();

  globalProgress.classList.remove('visible');
  globalReset.disabled = false;

  if (errors === 0) {
    showStatus('success',
      `✓ All done. Uploaded ${uploadedColors} swatches, wrote ${rowsWritten} catalog rows across ${families.length} product${families.length === 1 ? '' : 's'}. ` +
      `You can drop more folders or close this page.`);
  } else {
    showStatus('error',
      `Finished with ${errors} errors. Succeeded: ${uploadedColors} swatches, ${rowsWritten} rows. ` +
      `Check the preview cards above to see which colors failed.`);
  }
}

// ── Reset ──────────────────────────────────────────────────────────────────
function resetAll() {
  for (const family of Object.values(ctx.families)) {
    for (const url of family.blobUrls) URL.revokeObjectURL(url);
  }
  ctx.families = {};
  familiesContainer.innerHTML = '';
  globalActionBar.classList.remove('visible');
  globalProgress.classList.remove('visible');
  fileInput.value = '';
  hideStatus();
}

// ── Utils ──────────────────────────────────────────────────────────────────
function scrollToGlobalBar() {
  setTimeout(() => {
    globalActionBar.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

function showStatus(type, msg) {
  statusBox.className = `status visible ${type}`;
  statusBox.textContent = msg;
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

function escapeAttr(str) {
  return escapeHtml(str);
}
