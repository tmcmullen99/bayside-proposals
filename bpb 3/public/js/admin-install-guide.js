// ═══════════════════════════════════════════════════════════════════════════
// Admin tool: Install guide parse (Phase 1.5 Sprint 2 Part B.1).
//
// Drives /admin/install-guide-parse.html through three phases:
//
//   1. PARSE — POST /api/parse-install-guide → Claude reads the Belgard
//      master PDF and returns ~5 structured sections with key ICPI points.
//
//   2. REVIEW — for each parsed section, show:
//        • title, page range, summary, key points preview
//        • auto-selected category chips (based on section_key → name match)
//      Tim adjusts category selections per section.
//
//   3. WRITE — on approval:
//        a. DELETE from installation_guide_sections where source matches
//           (cascade clears join table too)
//        b. INSERT new sections
//        c. INSERT join-table rows (section_id × category_id)
//
// Sections with zero categories checked are skipped entirely — there'd be
// no way for publish.js to find them at render time.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

const state = {
  categories: [],           // all belgard_categories rows
  existingSections: [],     // current installation_guide_sections rows
  existingLinks: [],        // current join-table rows with category info
  parseRunning: false,
  parsedSections: null,     // raw API response after parse
  writeRunning: false,
  writeResult: null         // { inserted, links, errors }
};

// Category-matching heuristics: which belgard_categories.name substrings
// should be auto-selected for each section_key suggestion from Claude.
const CATEGORY_MATCHERS = {
  'pavers':        ['paver', 'slab'],                    // catches "Pavers", "Pavers & Slabs", "Permeable Pavers"
  'porcelain':     ['porcelain'],
  'walls':         ['wall', 'retaining'],                // catches "Retaining Walls", "Freestanding Walls"
  'accessories':   ['accessor', 'coping', 'edger', 'cap', 'step'],
  'fire-features': ['fire']                              // catches "Fire Pits", "Fire Features", "Fireplaces"
};

// ───────────────────────────────────────────────────────────────────────────
// Entry
// ───────────────────────────────────────────────────────────────────────────
init();

async function init() {
  document.getElementById('igParseBtn').addEventListener('click', runParse);
  document.getElementById('igApplyBtn').addEventListener('click', runWrite);
  document.getElementById('igDoneReload').addEventListener('click', () => {
    window.location.reload();
  });

  await loadState();
}

// ───────────────────────────────────────────────────────────────────────────
// Load existing data
// ───────────────────────────────────────────────────────────────────────────
async function loadState() {
  // Categories — used for the chip picker in the review phase
  const { data: catsData, error: catsErr } = await supabase
    .from('belgard_categories')
    .select('id, name')
    .order('name', { ascending: true });

  if (catsErr) {
    console.error('Could not load belgard_categories:', catsErr);
    state.categories = [];
  } else {
    state.categories = catsData || [];
  }

  // Existing sections
  const { data: secsData, error: secsErr } = await supabase
    .from('installation_guide_sections')
    .select('id, title, section_key, page_start, page_end, summary, source_pdf_url, created_at')
    .order('section_key', { ascending: true });

  if (secsErr) {
    console.error('Could not load installation_guide_sections:', secsErr);
    state.existingSections = [];
  } else {
    state.existingSections = secsData || [];
  }

  // Existing join-table rows (with category names for display)
  const { data: linksData, error: linksErr } = await supabase
    .from('installation_guide_section_categories')
    .select('section_id, category_id, belgard_categories(name)');

  if (linksErr) {
    console.error('Could not load join table:', linksErr);
    state.existingLinks = [];
  } else {
    state.existingLinks = linksData || [];
  }

  renderStats();
  renderExisting();
}

function renderStats() {
  document.getElementById('igStatSections').textContent    = state.existingSections.length;
  document.getElementById('igStatLinks').textContent       = state.existingLinks.length;
  document.getElementById('igStatCategories').textContent  = state.categories.length;
}

function renderExisting() {
  const panel = document.getElementById('igExistingPanel');
  const list  = document.getElementById('igExistingList');

  if (state.existingSections.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';

  // Group links by section_id for quick lookup
  const linksBySection = new Map();
  for (const link of state.existingLinks) {
    if (!linksBySection.has(link.section_id)) linksBySection.set(link.section_id, []);
    linksBySection.get(link.section_id).push(link.belgard_categories?.name || '?');
  }

  list.innerHTML = state.existingSections.map(s => {
    const cats = linksBySection.get(s.id) || [];
    const catText = cats.length > 0 ? cats.join(' · ') : 'no categories linked';
    return `
      <div class="ig-existing-row">
        <div>
          <div class="ig-existing-title">${escapeHtml(s.title)}</div>
          <div class="ig-existing-meta">
            <span class="ig-section-key-badge">${escapeHtml(s.section_key || '—')}</span>
            &nbsp;pages ${s.page_start || '?'}–${s.page_end || '?'}
            &nbsp;·&nbsp;
            <span class="ig-existing-cats">${escapeHtml(catText)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 1: Parse
// ───────────────────────────────────────────────────────────────────────────
async function runParse() {
  if (state.parseRunning) return;
  state.parseRunning = true;
  clearParseError();

  const btn = document.getElementById('igParseBtn');
  btn.disabled = true;
  btn.textContent = 'Parsing…';

  document.getElementById('igParseProgress').innerHTML = `
    <div class="ig-progress">
      <div class="ig-progress-label">
        <span class="ig-progress-spinner"></span>
        Claude is reading the Belgard install guide PDF. This typically takes 40-90 seconds.
      </div>
    </div>
  `;

  try {
    const res = await fetch('/api/parse-install-guide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const json = await res.json().catch(() => null);

    if (!res.ok || !json?.success) {
      const msg = json?.error || `HTTP ${res.status}`;
      const details = json?.details ? `\n\nDetails: ${JSON.stringify(json.details, null, 2).slice(0, 500)}` : '';
      showParseError(`Parse failed: ${msg}${details}`);
      state.parseRunning = false;
      btn.disabled = false;
      btn.textContent = 'Parse install guide →';
      document.getElementById('igParseProgress').innerHTML = '';
      return;
    }

    state.parsedSections = json.sections || [];
    document.getElementById('igParseProgress').innerHTML = `
      <div class="ig-progress">
        <div class="ig-progress-label">
          ✓ Parse complete — extracted ${state.parsedSections.length} section${state.parsedSections.length === 1 ? '' : 's'}.
          Review and adjust category mappings below.
        </div>
      </div>
    `;
  } catch (err) {
    showParseError(`Network error: ${err.message}`);
    document.getElementById('igParseProgress').innerHTML = '';
    state.parseRunning = false;
    btn.disabled = false;
    btn.textContent = 'Parse install guide →';
    return;
  }

  state.parseRunning = false;
  btn.disabled = false;
  btn.textContent = 'Re-parse install guide';

  if (state.parsedSections.length === 0) {
    showParseError('Parse returned zero sections. Check the raw_response field in the browser console (Network tab → parse-install-guide request).');
    return;
  }

  renderReview();
  document.getElementById('igReviewPanel').style.display = 'block';
  document.getElementById('igReviewPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showParseError(msg) {
  document.getElementById('igParseError').innerHTML = `<div class="ig-error">${escapeHtml(msg)}</div>`;
}
function clearParseError() {
  document.getElementById('igParseError').innerHTML = '';
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 2: Review with category mapping
// ───────────────────────────────────────────────────────────────────────────
function renderReview() {
  if (!state.parsedSections) return;

  // Pre-select categories per section using the matcher heuristic
  const initialSelections = new Map();
  state.parsedSections.forEach((section, idx) => {
    const matchers = CATEGORY_MATCHERS[section.section_key] || [];
    const matchedIds = new Set();
    for (const cat of state.categories) {
      const nameLC = (cat.name || '').toLowerCase();
      if (matchers.some(m => nameLC.includes(m))) {
        matchedIds.add(cat.id);
      }
    }
    initialSelections.set(idx, matchedIds);
  });
  state.sectionCategorySelections = initialSelections;

  const cardsHtml = state.parsedSections.map((section, idx) => {
    const pointsHtml = section.key_points.map(p => `<li>${escapeHtml(p)}</li>`).join('');

    const selected = state.sectionCategorySelections.get(idx) || new Set();
    const chipsHtml = state.categories.map(cat => {
      const isChecked = selected.has(cat.id);
      return `
        <label class="ig-category-chip ${isChecked ? 'is-checked' : ''}"
               data-section-idx="${idx}" data-cat-id="${escapeAttr(cat.id)}">
          <input type="checkbox" ${isChecked ? 'checked' : ''}>
          <span>${escapeHtml(cat.name)}</span>
        </label>
      `;
    }).join('');

    return `
      <div class="ig-section-card" data-section-idx="${idx}">
        <div class="ig-section-header">
          <div>
            <h3 class="ig-section-title">${escapeHtml(section.title)}</h3>
            <div class="ig-section-pages">
              pages ${section.page_start ?? '?'}–${section.page_end ?? '?'}
            </div>
          </div>
          <div class="ig-section-key-badge">${escapeHtml(section.section_key)}</div>
        </div>

        <div class="ig-section-summary">${escapeHtml(section.summary)}</div>

        <ul class="ig-section-points">${pointsHtml}</ul>

        <div class="ig-section-categories">
          <div class="ig-section-categories-label">Link to Belgard categories</div>
          <div class="ig-category-chips">${chipsHtml}</div>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('igSectionsWrap').innerHTML = cardsHtml;

  // Wire chip toggles
  document.getElementById('igSectionsWrap').addEventListener('change', onChipToggle);
  updateApplySummary();
}

function onChipToggle(e) {
  const cb = e.target;
  if (!cb || cb.tagName !== 'INPUT') return;
  const label = cb.closest('.ig-category-chip');
  if (!label) return;

  const idx = Number(label.dataset.sectionIdx);
  const catId = label.dataset.catId;
  const sel = state.sectionCategorySelections.get(idx);
  if (!sel) return;

  if (cb.checked) sel.add(catId);
  else sel.delete(catId);

  label.classList.toggle('is-checked', cb.checked);

  updateApplySummary();
}

function updateApplySummary() {
  if (!state.parsedSections) return;

  let writableSections = 0;
  let totalLinks = 0;
  for (let i = 0; i < state.parsedSections.length; i++) {
    const sel = state.sectionCategorySelections.get(i);
    if (sel && sel.size > 0) {
      writableSections++;
      totalLinks += sel.size;
    }
  }

  const skipped = state.parsedSections.length - writableSections;
  const summary = [
    `${writableSections} section${writableSections === 1 ? '' : 's'} ready to write`,
    `${totalLinks} category link${totalLinks === 1 ? '' : 's'} total`,
    skipped > 0 ? `${skipped} skipped (no categories checked)` : null
  ].filter(Boolean).join(' · ');

  document.getElementById('igApplySummary').textContent = summary;

  const btn = document.getElementById('igApplyBtn');
  btn.disabled = writableSections === 0;
  btn.textContent = writableSections === 0
    ? 'Nothing to write'
    : `Write ${writableSections} section${writableSections === 1 ? '' : 's'} →`;
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 3: Write
// ───────────────────────────────────────────────────────────────────────────
async function runWrite() {
  if (state.writeRunning) return;
  if (!state.parsedSections) return;

  if (!confirm('This will replace all existing install guide sections with the new parsed data. Continue?')) {
    return;
  }

  state.writeRunning = true;
  clearApplyError();

  const btn = document.getElementById('igApplyBtn');
  btn.disabled = true;
  btn.textContent = 'Writing…';

  const errors = [];

  // Step 1: Delete existing rows (cascades to join table)
  {
    const { error } = await supabase
      .from('installation_guide_sections')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // "delete all" idiom — empty WHERE is rejected by supabase-js

    if (error) {
      showApplyError(`Could not clear existing sections: ${error.message}`);
      state.writeRunning = false;
      btn.disabled = false;
      btn.textContent = 'Retry write →';
      return;
    }
  }

  // Step 2: Build sections to insert (only those with checked categories)
  const sectionsToInsert = [];
  const sectionIdxToCategoryIds = new Map();
  for (let i = 0; i < state.parsedSections.length; i++) {
    const section = state.parsedSections[i];
    const selectedCats = state.sectionCategorySelections.get(i);
    if (!selectedCats || selectedCats.size === 0) continue;

    sectionsToInsert.push({
      title:          section.title,
      section_key:    section.section_key,
      summary:        section.summary,
      key_points:     section.key_points,
      page_start:     section.page_start,
      page_end:       section.page_end,
      source_pdf_url: section.source_pdf_url
    });
    sectionIdxToCategoryIds.set(sectionsToInsert.length - 1, Array.from(selectedCats));
  }

  // Step 3: Insert sections, get back their IDs
  const { data: insertedSections, error: insertErr } = await supabase
    .from('installation_guide_sections')
    .insert(sectionsToInsert)
    .select('id, title');

  if (insertErr) {
    showApplyError(`Section insert failed: ${insertErr.message}`);
    state.writeRunning = false;
    btn.disabled = false;
    btn.textContent = 'Retry write →';
    return;
  }

  // Step 4: Insert join-table rows
  const links = [];
  insertedSections.forEach((ins, insertIdx) => {
    const catIds = sectionIdxToCategoryIds.get(insertIdx) || [];
    for (const cid of catIds) {
      links.push({ section_id: ins.id, category_id: cid });
    }
  });

  let linkRowsInserted = 0;
  if (links.length > 0) {
    const { data: linkRows, error: linkErr } = await supabase
      .from('installation_guide_section_categories')
      .insert(links)
      .select('section_id');
    if (linkErr) {
      errors.push(`Join table insert: ${linkErr.message}`);
    } else {
      linkRowsInserted = linkRows?.length || 0;
    }
  }

  state.writeResult = {
    sectionsInserted: insertedSections.length,
    linksInserted:    linkRowsInserted,
    errors
  };

  state.writeRunning = false;

  if (errors.length > 0) {
    showApplyError(`Write partially failed:\n• ${errors.join('\n• ')}`);
  }

  // Refresh all state and show done panel
  await loadState();
  showDonePanel();
}

function showApplyError(msg) {
  document.getElementById('igApplyError').innerHTML = `<div class="ig-error">${escapeHtml(msg)}</div>`;
}
function clearApplyError() {
  document.getElementById('igApplyError').innerHTML = '';
}

function showDonePanel() {
  const r = state.writeResult || { sectionsInserted: 0, linksInserted: 0, errors: [] };
  const panel = document.getElementById('igDonePanel');
  panel.style.display = 'block';

  document.getElementById('igDoneTitle').textContent =
    r.errors.length > 0
      ? `Completed with ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`
      : '✓ Install guide sections stored';

  document.getElementById('igDoneSummary').innerHTML = `
    Stored <strong>${r.sectionsInserted}</strong> section${r.sectionsInserted === 1 ? '' : 's'}
    with <strong>${r.linksInserted}</strong> category link${r.linksInserted === 1 ? '' : 's'}.
    These power the dynamic per-category preparation content on future published proposals.
  `;

  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
function escapeAttr(str) { return escapeHtml(str); }
