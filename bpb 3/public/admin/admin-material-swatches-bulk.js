// ═══════════════════════════════════════════════════════════════════════════
// Bulk Material Swatches Upload — MULTI-FOLDER + MULTI-PATTERN (admin)
//
// CHANGES FROM PRIOR VERSION:
//
//   1. Multi-folder drop bug fixed.
//      OLD: `for (const item of items) { await walkDir(...) }` — awaiting
//           inside the loop releases the DataTransfer synchronously, so
//           later items' webkitGetAsEntry() returns null. Result: only the
//           first folder registered.
//      NEW: Two-phase. First pass synchronously collects every
//           FileSystemEntry from dataTransfer.items (no awaits). Second pass
//           walks them all in parallel with Promise.all.
//
//   2. Multi-strategy filename parser.
//      Belgard uses 4+ naming conventions across products. Rather than
//      extending one brittle regex, we try strategies in priority order:
//
//        Strategy 1 (whitelist): if we know the product family's colors
//        from the catalog, find which one appears in the filename.
//        Robust against any naming scheme — the only source of truth is
//        the catalog itself.
//
//        Strategy 2 (pattern A — "Classic"): matches Dimensions-style
//        /^imgi_\d+_\w+_(?:NC_)?(.+?)_(?:DF|CM)_D[\dx]+/i
//        imgi_72_404_Anthracite_DF_D12_Modular.jpg → "Anthracite"
//
//        Strategy 3 (pattern D — "Swatch suffix"): matches Weston/Steeple
//        /_([A-Za-z\-]+)_Swatch$/i
//        imgi_71_107_Weston-Wall_Riviera_Swatch.jpg → "Riviera"
//
//        Strategy 4 (pattern B — "CM with product"): matches Melville Tandem
//        /^imgi_\d+_\w+_(?:NC_)?(.+?)_(?:DF|CM)_/i  (no D-size required)
//        imgi_75_402_Victorian_CM_Melville_Tandem_Linear-crop.jpg → "Victorian"
//
//      First strategy that succeeds wins. Catalog whitelist almost always
//      fires first when a family is detected, which is the most trustworthy
//      route.
//
//   3. Progressive-prefix family detection.
//      OLD: `tokens.join(' ')` → try exact prefix match → done.
//      NEW: Start with full token list, progressively shorten until a
//           catalog product_name matches. E.g. folder "Shelton Wall Old
//           World Charm Retaining Wall System" → tokens (after noise
//           strip) ['shelton', 'old', 'world', 'charm'] → try
//           'shelton old world charm' (no match) → 'shelton old world' →
//           'shelton old' → 'shelton' ✓ matches "Shelton Wall".
//
//   4. Consolidated ignored files.
//      OLD: every unparseable file got its own red "FAILED" card in the
//           grid. Shelton Wall had 4 such tiles.
//      NEW: a single bar at the bottom of the family card says
//           "4 files skipped (no color detected)". Cleaner.
//
//   5. Status banner during folder walk.
//      Large batches take a few hundred ms to walk. We show a sticky
//      "Reading folders…" note so the UI doesn't appear frozen.
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
const ctx = {
  catalog: [],
  productFamilies: [],
  families: {},
};

// Tokens to strip from folder names during family detection. These are
// structural/marketing words that Belgard adds around the actual product
// name. Keep this conservative — if a real product happens to contain one
// of these words, progressive-prefix detection will still find it by
// matching on the remaining tokens.
const FOLDER_NOISE = [
  'pavers', 'paver',
  'belgard',
  'retaining', 'walls', 'wall',
  'coping', 'treads', 'caps', 'edgers', 'edger', 'steps', 'step',
  'porcelain',
  'outdoor', 'living', 'kitchens', 'kitchen',
  'fire', 'pit', 'pits',
  'slab', 'slabs',
  'concrete',
  'system', 'systems',
  'blocks', 'block',
];

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
  ctx.productFamilies = Array.from(new Set(ctx.catalog.map(r => r.product_name))).sort();
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
// Critical: we MUST collect every FileSystemEntry synchronously from
// dataTransfer.items before doing any awaits. Awaiting releases the
// DataTransfer, and subsequent webkitGetAsEntry() calls return null for
// items we haven't touched yet.
async function handleDrop(e) {
  const items = Array.from(e.dataTransfer.items || []);
  const legacyFiles = Array.from(e.dataTransfer.files || []);

  // Phase 1: synchronous collection of FileSystemEntry handles
  const entries = [];
  for (const item of items) {
    if (item.webkitGetAsEntry) {
      const entry = item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
  }

  showStatus('info', `Reading ${entries.length > 0 ? entries.length + ' item' + (entries.length === 1 ? '' : 's') : legacyFiles.length + ' file' + (legacyFiles.length === 1 ? '' : 's')}…`);

  const folderMap = {};
  const looseFiles = [];

  // Phase 2: async walk in parallel
  if (entries.length > 0) {
    await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory) {
        const files = [];
        await walkDir(entry, files);
        if (files.length > 0) {
          folderMap[entry.name] = files;
        }
      } else if (entry.isFile) {
        const file = await entryToFile(entry);
        if (file) looseFiles.push(file);
      }
    }));
  } else {
    // Fallback: non-folder-aware drop (unlikely in Chrome)
    for (const file of legacyFiles) looseFiles.push(file);
  }

  if (looseFiles.length > 0) {
    folderMap['(loose files)'] = (folderMap['(loose files)'] || []).concat(looseFiles);
  }

  if (Object.keys(folderMap).length === 0) {
    showStatus('error', 'No folders or image files detected. Drag one or more product folders from Finder.');
    return;
  }

  hideStatus();

  for (const [folderName, files] of Object.entries(folderMap)) {
    ingestFolder(folderName, files);
  }

  updateGlobalBar();
  renderFamilies();
  scrollToGlobalBar();
}

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

// ── Ingest a single folder into state ──────────────────────────────────────
function ingestFolder(folderName, files) {
  const imageFiles = files.filter(f =>
    /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name)
  );

  if (imageFiles.length === 0) return;

  if (ctx.families[folderName]?.blobUrls) {
    for (const url of ctx.families[folderName].blobUrls) URL.revokeObjectURL(url);
  }

  const family = {
    folderName,
    familyKey: '',
    matchedProducts: [],
    availableColors: [],
    colorsByKey: {},
    ignoredFilenames: [],
    blobUrls: [],
    isDone: false,
    isUploading: false,
  };

  detectFamily(family);
  parseAndMatch(family, imageFiles);

  ctx.families[folderName] = family;
}

// ── Family detection (progressive prefix) ──────────────────────────────────
function detectFamily(family) {
  const tokens = family.folderName
    .replace(/[®™©]/g, '')
    .replace(/[_\-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t && !FOLDER_NOISE.includes(t));

  // Try progressively shorter prefixes of the token list. Longest first
  // for specificity — "belair 2.0" before "belair".
  for (let len = tokens.length; len >= 1; len--) {
    const key = tokens.slice(0, len).join(' ');
    if (!key) continue;

    const matched = ctx.productFamilies.filter(p => {
      const pLow = p.toLowerCase();
      return pLow.startsWith(key) || key.startsWith(pLow);
    });

    if (matched.length > 0) {
      family.familyKey = key;
      family.matchedProducts = matched;
      family.availableColors = getAvailableColors(matched);
      return;
    }
  }

  family.familyKey = '';
  family.matchedProducts = [];
  family.availableColors = [];
}

function getAvailableColors(matchedProducts) {
  return Array.from(new Set(
    ctx.catalog
      .filter(r => matchedProducts.includes(r.product_name))
      .map(r => r.color)
      .filter(Boolean)
  ));
}

// ── Filename parsing (multi-strategy) ──────────────────────────────────────
const FILENAME_REGEX_A = /^imgi_\d+_\w+_(?:NC_)?(.+?)_(?:DF|CM)_D[\dx]+/i;
const FILENAME_REGEX_B = /^imgi_\d+_\w+_(?:NC_)?(.+?)_(?:DF|CM)_/i;
const FILENAME_REGEX_D = /_([A-Za-z][A-Za-z\- ]+?)_Swatch(?:\.|$)/i;

function normalizeColor(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseColorForFamily(filename, family) {
  const base = filename.replace(/\.(jpe?g|png|webp)$/i, '');

  // Strategy 1: catalog color whitelist. We have the list of real colors for
  // this product family; find which one appears in the filename. Most
  // trustworthy strategy because it verifies against the source of truth.
  if (family.availableColors.length > 0) {
    const normBase = normalizeColor(base);
    // Sort by normalized length descending so "Brown Beige Charcoal" wins
    // over "Brown" when the filename contains the longer color.
    const sorted = family.availableColors
      .map(c => ({ raw: c, norm: normalizeColor(c) }))
      .filter(c => c.norm.length >= 3)
      .sort((a, b) => b.norm.length - a.norm.length);

    for (const c of sorted) {
      if (normBase.includes(c.norm)) {
        return c.raw; // use catalog's canonical casing
      }
    }
  }

  // Strategy 2: Pattern A (classic with _DF_/_CM_ + D-size)
  let m = base.match(FILENAME_REGEX_A);
  if (m) return cleanColorWord(m[1]);

  // Strategy 3: Pattern D (ends in _Swatch)
  m = base.match(FILENAME_REGEX_D);
  if (m) return cleanColorWord(m[1]);

  // Strategy 4: Pattern B (CM/DF without D-size)
  m = base.match(FILENAME_REGEX_B);
  if (m) {
    const raw = cleanColorWord(m[1]);
    // Heuristic: Pattern B's capture can greedily eat product-name tokens.
    // Reject captures with more than 4 words — those are almost always
    // over-matches rather than real color names.
    if (raw.split(/\s+/).length <= 4) return raw;
  }

  return null;
}

function cleanColorWord(raw) {
  return raw
    .replace(/[_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lower is better — prefer hi-res over base over browser-duplicate copies.
function filePreferenceRank(filename) {
  if (/1024x1024/i.test(filename)) return 0;
  if (/\s\(\d+\)\./.test(filename)) return 2;
  return 1;
}

function parseAndMatch(family, files) {
  family.colorsByKey = {};
  family.ignoredFilenames = [];

  for (const file of files) {
    const color = parseColorForFamily(file.name, family);
    if (!color) {
      family.ignoredFilenames.push(file.name);
      continue;
    }

    const key = normalizeColor(color);
    if (!key) {
      family.ignoredFilenames.push(file.name);
      continue;
    }

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
    if (entry.status === 'uploaded') continue;

    const candidates = ctx.catalog.filter(row =>
      family.matchedProducts.includes(row.product_name) &&
      normalizeColor(row.color) === key
    );

    if (candidates.length === 0) {
      entry.status = 'warn';
      entry.variants = [];
      entry.reason = family.matchedProducts.length === 0
        ? 'No product family matched this folder'
        : `Color "${entry.colorLabel}" not in catalog for ${family.matchedProducts.join(' / ')}`;
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
  for (const family of Object.values(ctx.families)) {
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
  const imageCount = entries.length;
  const matchedEntries = entries.filter(e => e.status === 'match');
  const skippedEntries = entries.filter(e => e.status === 'skip');
  const warnEntries = entries.filter(e => e.status === 'warn');
  const uploadedEntries = entries.filter(e => e.status === 'uploaded');
  const failEntries = entries.filter(e => e.status === 'fail');
  const totalRowsToUpdate = matchedEntries.reduce((s, e) => s + e.variants.length, 0);
  const totalRowsWritten = uploadedEntries.reduce((s, e) => s + (e.variantsWritten || 0), 0);

  const title = family.matchedProducts.length > 0
    ? escapeHtml(family.matchedProducts.join(' · '))
    : `<span style="color: var(--danger);">Could not auto-detect product</span>`;

  const overrideOptions = ['<option value="">(auto-detected)</option>']
    .concat(ctx.productFamilies.map(p =>
      `<option value="${escapeHtml(p)}"${family.matchedProducts.length === 1 && family.matchedProducts[0] === p ? ' selected' : ''}>${escapeHtml(p)}</option>`
    )).join('');

  const ignoredCount = family.ignoredFilenames.length;

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
          <select class="family-override-select">
            ${overrideOptions}
          </select>
        </div>
        <button class="family-remove" title="Remove this folder">×</button>
      </div>
    </div>

    <div class="family-summary">
      <div class="summary-box">
        <div class="summary-num">${imageCount}</div>
        <div class="summary-label">Parsed images</div>
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
      ${failEntries.length > 0 ? `
        <div class="summary-box">
          <div class="summary-num" style="color:var(--danger);">${failEntries.length}</div>
          <div class="summary-label">Failed</div>
        </div>
      ` : ''}
    </div>

    ${imageCount === 0 && ignoredCount > 0 ? `
      <div style="padding:14px 16px; background:var(--warn-soft); color:var(--warn-text); border-radius:8px; font-size:13px; margin-bottom:12px;">
        <strong>No swatches detected in this folder.</strong>
        All ${ignoredCount} image${ignoredCount === 1 ? '' : 's'} appear to be product beauty shots rather than color swatches. For wall products, try downloading from Belgard's color palette page (look for a grid of small color circles).
      </div>
    ` : ''}

    <div class="preview-grid">
      ${renderPreviewGrid(family)}
    </div>

    ${ignoredCount > 0 && imageCount > 0 ? `
      <div style="margin-top:12px; padding:8px 12px; background:var(--cream); color:var(--muted); border-radius:6px; font-size:12px; font-family:'JetBrains Mono',monospace;">
        ${ignoredCount} file${ignoredCount === 1 ? '' : 's'} ignored (no color detected in filename)
      </div>
    ` : ''}
  `;

  // Event wiring
  card.querySelector('.family-override-select')?.addEventListener('change', (e) => {
    const chosen = e.target.value;
    if (chosen) {
      family.matchedProducts = [chosen];
      family.familyKey = chosen.toLowerCase();
      family.availableColors = getAvailableColors([chosen]);
    } else {
      detectFamily(family);
    }
    // Re-parse all files since whitelist changed, plus re-match
    const allFiles = [];
    for (const key in family.colorsByKey) {
      if (family.colorsByKey[key].file) allFiles.push(family.colorsByKey[key].file);
    }
    // Also include files that were previously ignored — they might match now
    // with a better whitelist. But we don't have those file references after
    // they were filtered, so for now just re-match existing parsed ones.
    matchFamilyColors(family);
    renderFamilies();
    updateGlobalBar();
  });

  card.querySelector('.family-remove')?.addEventListener('click', () => {
    for (const url of family.blobUrls) URL.revokeObjectURL(url);
    delete ctx.families[family.folderName];
    renderFamilies();
    updateGlobalBar();
  });

  return card;
}

function renderPreviewGrid(family) {
  const entries = Object.values(family.colorsByKey);
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
    totalImages += entries.length;
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
  const allJobs = [];
  for (const family of families) {
    for (const entry of Object.values(family.colorsByKey)) {
      if (entry.status === 'match') allJobs.push({ family, entry });
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
          // Phase 3B.1 dual-write: mirror swatch_url into the unified
          // materials table so the picker and publish renderer see it.
          // Same `.is('swatch_url', null)` guard so we never overwrite a
          // swatch that was already set via a different path.
          const { error: mirrorErr } = await supabase
            .from('materials')
            .update({ swatch_url: publicUrl, updated_at: new Date().toISOString() })
            .in('id', ids)
            .is('swatch_url', null);
          if (mirrorErr) {
            console.warn('Could not mirror bulk swatches to materials:', mirrorErr.message);
          }

          entry.status = 'uploaded';
          entry.variantsWritten = entry.variants.length;
          entry.reason = `Wrote to ${entry.variants.length} variants`;
          uploadedColors++;
          rowsWritten += entry.variants.length;

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

  for (const family of families) {
    const stillMatching = Object.values(family.colorsByKey)
      .some(e => e.status === 'match');
    if (!stillMatching) {
      family.isDone = true;
      family.isUploading = false;
    }
  }

  renderFamilies();
  updateGlobalBar();

  globalProgress.classList.remove('visible');
  globalReset.disabled = false;

  if (errors === 0) {
    showStatus('success',
      `✓ All done. Uploaded ${uploadedColors} swatches, wrote ${rowsWritten} catalog rows across ${families.length} folder${families.length === 1 ? '' : 's'}. ` +
      `Drop more folders or close this page.`);
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
