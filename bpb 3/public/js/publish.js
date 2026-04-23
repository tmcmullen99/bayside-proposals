// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.5 Sprint 2 Part B.2 — Preview & Publish
//
// Changes from Sprint 1:
//
//   1. "Why preparation matters" section is now DYNAMIC.
//      • Queries installation_guide_sections joined via
//        installation_guide_section_categories for the Belgard categories
//        actually present in this proposal's materials.
//      • Renders one card per unique section with real ICPI-standard
//        summary + 3-5 key technical points extracted by Claude from the
//        Belgard Product Installation Guide PDF.
//      • Each card has a "View the full installation standards →" link
//        pointing at the master PDF with a #page={N} anchor.
//      • Falls back to the hardcoded 4-card version when no install_guide
//        data is linked (so the page never renders empty).
//
//   2. Per-material "View installation guide" button is now page-anchored.
//      • When a Belgard material's category has a mapped install guide
//        section, the button links to the master PDF at the relevant page
//        ({BELGARD_MASTER_PDF}#page=N).
//      • Falls back to the generic Bayside install guide if the material's
//        category isn't mapped (preserves prior behavior — no regressions
//        for materials without section linkage).
//
//   3. [Sprint 3 Part C] "Why preparation matters" now also renders
//      non-Belgard standards cards when the proposal contains turf or
//      Tru-Scapes lighting, detected via pattern match on
//      proposal_sections.line_items and the third-party materials tray.
//      Content is hardcoded in renderThirdPartyPrepCards; when the
//      installation_guide_sections schema is extended to cover non-Belgard
//      categories, this will migrate to a data-driven query.
//
//   4. [Sprint 3 Part D] Construction drawing picker + featured page
//      section. Admin selects one image from proposal_images as the
//      "construction drawing" (stored as proposals.construction_drawing_url,
//      added in migration 014); it renders as its own framed full-width
//      section on the published page between the Loom embed and Scope.
//
//   5. [Sprint 3 Part D] Scope line items now render as STRUCTURED blocks
//      instead of one middle-dot-joined paragraph. Each entry in the
//      line_items array becomes its own card with:
//        • a small TYPE chip (extracted from ALL-CAPS "PAVER:" / "TURF:" /
//          etc. prefixes — 2+ chars, colon-terminated)
//        • a material-name heading (first pipe-delimited segment)
//        • a row of Pattern / Color / Part Number attributes (remaining
//          pipe-delimited "KEY: VALUE" pairs)
//      Lines without that structure (construction notes, lowercase-prefixed
//      narrative) fall through to plain body text — no type chip, no attrs.
//      See parseLineItem + formatLineItemsHtml.
//
// Preserved from Sprint 1 / Sprint 1.5:
//   • Hero picker grid (bid-PDF-extracted + manually uploaded images)
//   • Hero banner at top of published page
//   • Materials grouped by application_area with 4:3 aspect cards
//   • Cut sheet + install guide action buttons on each card
//   • Publish / slug / history infrastructure
//   • Section order: header → hero → loom → 01 drawing → 02 scope
//     → 03 materials → 04 why prep → 05 photos → footer CTAs
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

// Bayside-branded installation guide PDF — remains the bottom footer CTA.
// This is the client-facing "Here's how we install" document.
const INSTALL_GUIDE_URL = 'https://cdn.prod.website-files.com/67c10dbe66a9f7b9cf3c6e47/68d2db027d1d1b4ad1543f05_Bayside%20Pavers%20Presentation%20(1)_compressed%20(1).pdf';

// Belgard master Product Installation Guide — the 110+ page PDF we parsed
// in Sprint 2 Part B.1. Used for page-anchored deep links per section since
// its pagination is what installation_guide_sections.page_start references.
const BELGARD_MASTER_INSTALL_GUIDE_URL = 'https://www.belgard.com/wp-content/uploads/2025/05/Product-Installation-Guide_WEB_BEL24-D-298050.pdf';

// Third-party install / product guide URLs — referenced from the dynamic
// "Why preparation matters" cards when the proposal uses turf or Tru-Scapes
// lighting. Keep these here rather than in-line so Tim can swap the hosting
// location (Webflow CDN, Supabase Storage, manufacturer URL) in one place.
const EVERGRASS_INSTALL_GUIDE_URL = 'https://cdn.msisurfaces.com/files/flyers/evergrass-artificial-turf-pavers.pdf';
const TRU_SCAPES_PRODUCT_GUIDE_URL = 'https://cdn.prod.website-files.com/65a1ca4354f63bd7376b5027/69e99762031d43f432f14cde_Tru%20Scapes-compressed.pdf';

const BAYSIDE_LOGO_URL = 'https://cdn.prod.website-files.com/65a1ca4354f63bd7376b5027/69a04f4369bc9cc20b8d2155_BaysidePavers_original%20(2)%20(1).png';
const TIM_PHONE = '408-313-1301';
const TIM_PHONE_HREF = '+14083131301';
const BUCKET = 'proposal-photos';

let proposalId = null;
let container = null;
let onSaveCb = null;
let currentData = null; // { proposal, sections, materials, photos, heroCandidates, drawingCandidates, history, installSections, categoryToSection }

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────
export async function initPublish(opts) {
  proposalId = opts.proposalId;
  container = opts.container;
  onSaveCb = opts.onSave || (() => {});

  renderShell();
  await reload();
}

// ───────────────────────────────────────────────────────────────────────────
// Data loading — manual joins to avoid PostgREST FK ambiguity
// ───────────────────────────────────────────────────────────────────────────
async function reload() {
  setStatus('Loading…');

  // heroCandidates query: all property_condition images (extracted + manual),
  // since those are the viable hero sources. Small bid_pdf_asset images are
  // excluded to keep the picker grid readable.
  //
  // drawingCandidates query: ALL proposal_images for this proposal, regardless
  // of category. The construction drawing can come from a PDF extraction
  // (bid_pdf_asset) OR a manual upload in any category, so we don't filter —
  // we just present everything sorted with extracted-images first, then uploads.
  const [proposalQ, sectionsQ, materialsQ, photosQ, heroCandidatesQ, drawingCandidatesQ, historyQ] = await Promise.all([
    supabase.from('proposals').select('*').eq('id', proposalId).single(),
    supabase.from('proposal_sections').select('*').eq('proposal_id', proposalId)
      .order('display_order', { ascending: true }),
    supabase.from('proposal_materials').select('*')
      .eq('proposal_id', proposalId).order('display_order', { ascending: true }),
    supabase.from('proposal_images').select('*').eq('proposal_id', proposalId)
      .eq('category', 'property_condition')
      .order('display_order', { ascending: true }),
    supabase.from('proposal_images').select('*').eq('proposal_id', proposalId)
      .eq('category', 'property_condition')
      .order('width', { ascending: false, nullsFirst: false }),
    supabase.from('proposal_images').select('*').eq('proposal_id', proposalId)
      .order('extraction_source', { ascending: true })
      .order('source_page', { ascending: true, nullsFirst: false }),
    supabase.from('published_proposals').select('id, slug, title, published_at')
      .eq('proposal_id', proposalId).order('published_at', { ascending: false }),
  ]);

  const err = proposalQ.error || sectionsQ.error || materialsQ.error
    || photosQ.error || heroCandidatesQ.error || drawingCandidatesQ.error || historyQ.error;
  if (err) {
    setStatus('');
    showError('Could not load data: ' + err.message);
    return;
  }

  // Manual join — fetch catalog rows separately, stitch in JS
  const rawMaterials = materialsQ.data || [];
  const belgardIds = [...new Set(rawMaterials
    .filter(m => m.belgard_material_id).map(m => m.belgard_material_id))];
  const thirdPartyIds = [...new Set(rawMaterials
    .filter(m => m.third_party_material_id).map(m => m.third_party_material_id))];

  const [belgardQ, thirdPartyQ] = await Promise.all([
    belgardIds.length
      ? supabase.from('belgard_materials').select('*').in('id', belgardIds)
      : Promise.resolve({ data: [], error: null }),
    thirdPartyIds.length
      ? supabase.from('third_party_materials').select('*').in('id', thirdPartyIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (belgardQ.error || thirdPartyQ.error) {
    setStatus('');
    showError('Could not load materials catalog: '
      + (belgardQ.error?.message || thirdPartyQ.error?.message));
    return;
  }

  const belgardMap = new Map((belgardQ.data || []).map(m => [m.id, m]));
  const thirdPartyMap = new Map((thirdPartyQ.data || []).map(m => [m.id, m]));
  const materials = rawMaterials.map(m => ({
    ...m,
    belgard_material: m.belgard_material_id
      ? belgardMap.get(m.belgard_material_id) : null,
    third_party_material: m.third_party_material_id
      ? thirdPartyMap.get(m.third_party_material_id) : null,
  }));

  // ───────────────────────────────────────────────────────────────────────
  // Sprint 2 Part B.2: load install guide sections for the Belgard categories
  // present in this proposal's materials. Powers the dynamic "Why preparation
  // matters" section and per-material page-anchored install guide CTAs.
  //
  // Third-party materials are NOT included here — the install guide was
  // parsed from Belgard's master PDF and its page numbers only apply to
  // Belgard products. Third-party materials retain prior behavior.
  // ───────────────────────────────────────────────────────────────────────
  const { installSections, categoryToSection } = await loadInstallGuideData(belgardQ.data || []);

  currentData = {
    proposal: proposalQ.data,
    sections: sectionsQ.data || [],
    materials,
    photos: photosQ.data || [],
    heroCandidates: heroCandidatesQ.data || [],
    drawingCandidates: drawingCandidatesQ.data || [],
    history: historyQ.data || [],
    installSections,
    categoryToSection,
  };

  renderBody();
  setStatus('');
}

async function loadInstallGuideData(belgardRows) {
  const usedCategoryIds = [...new Set(
    belgardRows.map(b => b.category_id).filter(Boolean)
  )];

  if (usedCategoryIds.length === 0) {
    return { installSections: [], categoryToSection: new Map() };
  }

  // Fetch the join-table rows that link a category to a section
  const { data: linksData, error: linksErr } = await supabase
    .from('installation_guide_section_categories')
    .select('section_id, category_id')
    .in('category_id', usedCategoryIds);

  if (linksErr) {
    // Non-fatal — the Why Prep section falls back to hardcoded content
    // and material cards fall back to the generic install guide URL.
    console.error('Could not load install guide category links:', linksErr);
    return { installSections: [], categoryToSection: new Map() };
  }

  const linkRows = linksData || [];
  const sectionIds = [...new Set(linkRows.map(l => l.section_id))];

  if (sectionIds.length === 0) {
    return { installSections: [], categoryToSection: new Map() };
  }

  const { data: sectionsData, error: sectionsErr } = await supabase
    .from('installation_guide_sections')
    .select('*')
    .in('id', sectionIds);

  if (sectionsErr) {
    console.error('Could not load install guide sections:', sectionsErr);
    return { installSections: [], categoryToSection: new Map() };
  }

  const installSections = sectionsData || [];
  const sectionById = new Map(installSections.map(s => [s.id, s]));

  const categoryToSection = new Map();
  for (const link of linkRows) {
    const section = sectionById.get(link.section_id);
    if (section) categoryToSection.set(link.category_id, section);
  }

  return { installSections, categoryToSection };
}

// ───────────────────────────────────────────────────────────────────────────
// UI shell (static)
// ───────────────────────────────────────────────────────────────────────────
function renderShell() {
  container.innerHTML = `
    <style>
      /* Hero picker */
      .bp-hero-picker-section {
        margin-bottom: 32px;
        padding: 20px 22px;
        background: #fff;
        border: 1px solid #e5e5e5;
        border-radius: 10px;
      }
      .bp-hero-picker-header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 4px;
        gap: 12px;
      }
      .bp-hero-picker-label {
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #353535;
        font-weight: 700;
      }
      .bp-hero-picker-count {
        font-size: 12px;
        color: #999;
      }
      .bp-hero-picker-hint {
        font-size: 13px;
        color: #666;
        margin-bottom: 14px;
        line-height: 1.5;
      }
      .bp-hero-picker-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 10px;
      }
      .bp-hero-picker-item {
        position: relative;
        aspect-ratio: 4 / 3;
        border-radius: 6px;
        overflow: hidden;
        cursor: pointer;
        background: #faf8f3;
        border: 2px solid transparent;
        transition: border-color 0.15s, transform 0.15s;
      }
      .bp-hero-picker-item:hover {
        border-color: #c9d3cb;
        transform: translateY(-1px);
      }
      .bp-hero-picker-item.is-selected {
        border-color: #5d7e69;
        box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.15);
      }
      .bp-hero-picker-item img {
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
      }
      .bp-hero-picker-badge {
        position: absolute;
        top: 8px; left: 8px;
        padding: 3px 7px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        border-radius: 3px;
        background: #5d7e69;
        color: #fff;
      }
      .bp-hero-picker-source {
        position: absolute;
        bottom: 6px; right: 6px;
        padding: 2px 6px;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        border-radius: 3px;
        background: rgba(0,0,0,0.55);
        color: #fff;
      }
      .bp-hero-picker-empty {
        padding: 28px 20px;
        text-align: center;
        background: #faf8f3;
        border: 1px dashed #d5d5d5;
        border-radius: 8px;
        color: #666;
        font-size: 14px;
        line-height: 1.5;
      }
      .bp-hero-picker-clear {
        display: inline-block;
        margin-top: 10px;
        font-size: 12px;
        color: #b04040;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        text-decoration: underline;
      }
      .bp-hero-picker-clear:hover { color: #8a2020; }
    </style>

    <div class="section-header">
      <span class="eyebrow">Section 06</span>
      <h2>Preview &amp; publish</h2>
    </div>

    <div class="bp-publish">
      <div class="bp-hero-picker-section" id="bpHeroPickerSection">
        <div class="bp-hero-picker-header">
          <span class="bp-hero-picker-label">Hero image</span>
          <span class="bp-hero-picker-count" id="bpHeroCount"></span>
        </div>
        <p class="bp-hero-picker-hint">
          Click any image to set it as the full-width banner at the top of the published proposal.
          Images come from the bid PDF (auto-extracted) or from Section 05 (manual uploads).
        </p>
        <div id="bpHeroPickerGrid"></div>
      </div>

      <div class="bp-hero-picker-section" id="bpDrawingPickerSection">
        <div class="bp-hero-picker-header">
          <span class="bp-hero-picker-label">Construction drawing</span>
          <span class="bp-hero-picker-count" id="bpDrawingCount"></span>
        </div>
        <p class="bp-hero-picker-hint">
          Click any image to feature it as the project's construction drawing — it renders
          in its own framed section between the hero and the scope of work on the published page.
          Pulls from every image attached to this proposal (extracted + uploaded).
        </p>
        <div id="bpDrawingPickerGrid"></div>
      </div>

      <div class="bp-publish-loom-row">
        <label class="bp-publish-loom-label">
          Loom walkthrough URL
          <input type="url" id="bpPublishLoom" class="bp-publish-loom-input"
            placeholder="https://www.loom.com/share/...">
        </label>
        <p class="bp-publish-loom-hint">
          Paste a Loom share link. Optional — if set, the video appears in the
          hero of the published page.
        </p>
      </div>

      <div class="bp-publish-actions">
        <div>
          <div class="bp-publish-next-slug-label">Next publish URL</div>
          <code id="bpPublishNextSlug" class="bp-publish-next-slug">…</code>
        </div>
        <div class="bp-publish-action-btns">
          <button id="bpPublishRefresh" class="bp-publish-refresh-btn">
            Refresh preview
          </button>
          <button id="bpPublishBtn" class="bp-publish-btn">
            Publish new version
          </button>
        </div>
      </div>

      <div id="bpPublishStatus" class="bp-publish-status"></div>

      <div class="bp-publish-preview-wrap">
        <div class="bp-publish-preview-header">
          <span class="eyebrow">Preview</span>
          <span class="bp-publish-preview-note">
            This is what will be published.
          </span>
        </div>
        <iframe id="bpPublishPreview" class="bp-publish-preview-iframe"
          sandbox="allow-same-origin"></iframe>
      </div>

      <div class="bp-publish-history-wrap">
        <div class="section-header">
          <span class="eyebrow">Version history</span>
          <h3>Published versions</h3>
        </div>
        <div id="bpPublishHistory" class="bp-publish-history"></div>
      </div>
    </div>
  `;

  document.getElementById('bpPublishBtn')
    .addEventListener('click', handlePublish);
  document.getElementById('bpPublishRefresh')
    .addEventListener('click', () => reload());
  document.getElementById('bpPublishLoom')
    .addEventListener('input', handleLoomInput);
}

// ───────────────────────────────────────────────────────────────────────────
// UI body (dynamic — runs after data load)
// ───────────────────────────────────────────────────────────────────────────
function renderBody() {
  const { proposal, history } = currentData;

  document.getElementById('bpPublishLoom').value = proposal.loom_url || '';

  const nextSlug = slugifyBase(proposal.project_address, new Date());
  const origin = window.location.origin;
  document.getElementById('bpPublishNextSlug').textContent =
    `${origin}/p/${nextSlug}`;

  renderHeroPicker();
  renderDrawingPicker();
  renderHistory(history, origin);
  renderPreview();
}

function renderHeroPicker() {
  const { heroCandidates, proposal } = currentData;
  const grid = document.getElementById('bpHeroPickerGrid');
  const count = document.getElementById('bpHeroCount');

  const heroUrl = proposal.hero_image_url || null;

  count.textContent = heroCandidates.length > 0
    ? `${heroCandidates.length} image${heroCandidates.length === 1 ? '' : 's'} available`
    : '';

  if (heroCandidates.length === 0) {
    grid.innerHTML = `
      <div class="bp-hero-picker-empty">
        <strong>No images yet.</strong><br>
        Commit a bid PDF in Section 02 to auto-extract images, or upload photos in Section 05.
      </div>
    `;
    return;
  }

  const items = heroCandidates.map(img => {
    const thumb = img.thumbnail_path ? publicUrl(img.thumbnail_path) : publicUrl(img.storage_path);
    const full = publicUrl(img.storage_path);
    const isSelected = heroUrl && full === heroUrl;
    const sourceBadge = img.extraction_source === 'bid_pdf_extract'
      ? `<div class="bp-hero-picker-source">PDF${img.source_page ? ' p.' + img.source_page : ''}</div>`
      : `<div class="bp-hero-picker-source">Uploaded</div>`;

    return `
      <div class="bp-hero-picker-item ${isSelected ? 'is-selected' : ''}"
           data-url="${escapeAttr(full)}">
        <img src="${escapeAttr(thumb)}" alt="" loading="lazy">
        ${isSelected ? `<div class="bp-hero-picker-badge">Hero</div>` : ''}
        ${sourceBadge}
      </div>
    `;
  }).join('');

  const clearBtn = heroUrl
    ? `<button type="button" class="bp-hero-picker-clear" id="bpHeroClear">Clear hero selection</button>`
    : '';

  grid.innerHTML = `<div class="bp-hero-picker-grid">${items}</div>${clearBtn}`;

  // Wire up click-to-select
  grid.querySelectorAll('.bp-hero-picker-item').forEach(el => {
    el.addEventListener('click', () => setHero(el.dataset.url));
  });

  const clearEl = grid.querySelector('#bpHeroClear');
  if (clearEl) clearEl.addEventListener('click', () => setHero(null));
}

async function setHero(url) {
  // Save immediately — no debounce needed, clicks are discrete events.
  const { error } = await supabase
    .from('proposals')
    .update({ hero_image_url: url || null })
    .eq('id', proposalId);

  if (error) {
    showError(`Could not set hero: ${error.message}`);
    return;
  }

  if (currentData) currentData.proposal.hero_image_url = url || null;
  renderHeroPicker();
  renderPreview();
  onSaveCb();
}

// ───────────────────────────────────────────────────────────────────────────
// Construction drawing picker (Sprint 3 Part D)
//
// Identical pattern to the hero picker, but backed by a separate DB column
// (proposals.construction_drawing_url, added in migration 014). Pulls from
// ALL proposal_images — the drawing can be extracted from the bid PDF or
// uploaded manually in any category, so we don't filter at the query level.
// ───────────────────────────────────────────────────────────────────────────
function renderDrawingPicker() {
  const { drawingCandidates, proposal } = currentData;
  const grid = document.getElementById('bpDrawingPickerGrid');
  const count = document.getElementById('bpDrawingCount');

  const drawingUrl = proposal.construction_drawing_url || null;

  count.textContent = drawingCandidates.length > 0
    ? `${drawingCandidates.length} image${drawingCandidates.length === 1 ? '' : 's'} available`
    : '';

  if (drawingCandidates.length === 0) {
    grid.innerHTML = `
      <div class="bp-hero-picker-empty">
        <strong>No images yet.</strong><br>
        Commit a bid PDF in Section 02 to auto-extract images, or upload photos in Section 05.
      </div>
    `;
    return;
  }

  const items = drawingCandidates.map(img => {
    const thumb = img.thumbnail_path ? publicUrl(img.thumbnail_path) : publicUrl(img.storage_path);
    const full = publicUrl(img.storage_path);
    const isSelected = drawingUrl && full === drawingUrl;
    const sourceBadge = img.extraction_source === 'bid_pdf_extract'
      ? `<div class="bp-hero-picker-source">PDF${img.source_page ? ' p.' + img.source_page : ''}</div>`
      : `<div class="bp-hero-picker-source">Uploaded</div>`;

    return `
      <div class="bp-hero-picker-item ${isSelected ? 'is-selected' : ''}"
           data-url="${escapeAttr(full)}">
        <img src="${escapeAttr(thumb)}" alt="" loading="lazy">
        ${isSelected ? `<div class="bp-hero-picker-badge">Drawing</div>` : ''}
        ${sourceBadge}
      </div>
    `;
  }).join('');

  const clearBtn = drawingUrl
    ? `<button type="button" class="bp-hero-picker-clear" id="bpDrawingClear">Clear drawing selection</button>`
    : '';

  grid.innerHTML = `<div class="bp-hero-picker-grid">${items}</div>${clearBtn}`;

  grid.querySelectorAll('.bp-hero-picker-item').forEach(el => {
    el.addEventListener('click', () => setDrawing(el.dataset.url));
  });

  const clearEl = grid.querySelector('#bpDrawingClear');
  if (clearEl) clearEl.addEventListener('click', () => setDrawing(null));
}

async function setDrawing(url) {
  const { error } = await supabase
    .from('proposals')
    .update({ construction_drawing_url: url || null })
    .eq('id', proposalId);

  if (error) {
    showError(`Could not set construction drawing: ${error.message}`);
    return;
  }

  if (currentData) currentData.proposal.construction_drawing_url = url || null;
  renderDrawingPicker();
  renderPreview();
  onSaveCb();
}

function renderHistory(history, origin) {
  const el = document.getElementById('bpPublishHistory');
  if (!history.length) {
    el.innerHTML = `
      <p class="bp-publish-history-empty">
        No versions published yet. Click <strong>Publish new version</strong>
        above to create the first one.
      </p>
    `;
    return;
  }

  el.innerHTML = history.map(h => {
    const url = `${origin}/p/${h.slug}`;
    const when = formatDateTime(h.published_at);
    return `
      <div class="bp-publish-history-item">
        <div class="bp-publish-history-item-info">
          <div class="bp-publish-history-item-slug">/p/${escapeHtml(h.slug)}</div>
          <div class="bp-publish-history-item-date">${escapeHtml(when)}</div>
        </div>
        <div class="bp-publish-history-item-actions">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener"
            class="bp-publish-history-btn bp-publish-history-btn-open">Open ↗</a>
          <button class="bp-publish-history-btn bp-publish-history-btn-copy"
            data-url="${escapeHtml(url)}">Copy URL</button>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.bp-publish-history-btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.url);
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  });
}

function renderPreview() {
  const html = buildHtmlSnapshot(currentData);
  const iframe = document.getElementById('bpPublishPreview');
  iframe.srcdoc = html;
}

// ───────────────────────────────────────────────────────────────────────────
// Auto-save handler for Loom URL (debounced)
// ───────────────────────────────────────────────────────────────────────────
let loomSaveTimer = null;
function handleLoomInput(e) {
  const val = e.target.value.trim();
  clearTimeout(loomSaveTimer);
  loomSaveTimer = setTimeout(async () => {
    const { error } = await supabase
      .from('proposals')
      .update({ loom_url: val || null })
      .eq('id', proposalId);
    if (error) {
      showError(`Could not save loom_url: ${error.message}`);
      return;
    }
    if (currentData) currentData.proposal.loom_url = val || null;
    renderPreview();
    onSaveCb();
  }, 600);
}

// ───────────────────────────────────────────────────────────────────────────
// Publish action
// ───────────────────────────────────────────────────────────────────────────
async function handlePublish() {
  if (!currentData) return;

  const btn = document.getElementById('bpPublishBtn');
  btn.disabled = true;
  btn.textContent = 'Publishing…';
  setStatus('Generating snapshot…');

  try {
    const slug = await allocateSlug(currentData.proposal);
    const html = buildHtmlSnapshot(currentData);
    const title = currentData.proposal.project_address
      || currentData.proposal.client_name
      || 'Bayside Pavers proposal';
    const totalAmount = currentData.proposal.bid_total_amount || null;

    const { error } = await supabase.from('published_proposals').insert({
      proposal_id: proposalId,
      slug,
      html_snapshot: html,
      title,
      project_address: currentData.proposal.project_address || null,
      total_amount: totalAmount,
    });

    if (error) throw error;

    setStatus(`Published! Live at ${window.location.origin}/p/${slug}`, 'ok');
    await reload();
    onSaveCb();
  } catch (err) {
    showError('Publish failed: ' + (err.message || String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish new version';
  }
}

async function allocateSlug(proposal) {
  const base = slugifyBase(proposal.project_address, new Date());

  const { data: existing, error } = await supabase
    .from('published_proposals')
    .select('slug')
    .like('slug', `${base}%`);

  if (error) throw error;
  const taken = new Set((existing || []).map(r => r.slug));
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function slugifyBase(address, date) {
  const addr = (address || 'proposal')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'proposal';

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${addr}-${yyyy}-${mm}-${dd}`;
}

// ───────────────────────────────────────────────────────────────────────────
// HTML snapshot builder — full standalone document
// ───────────────────────────────────────────────────────────────────────────
function buildHtmlSnapshot({ proposal, sections, materials, photos, installSections, categoryToSection }) {
  const address = proposal.project_address || '';
  const cityLine = [proposal.project_city, proposal.project_state,
    proposal.project_zip].filter(Boolean).join(', ');
  const clientName = proposal.client_name || '';
  const total = proposal.bid_total_amount != null
    ? formatMoney(proposal.bid_total_amount) : null;
  const dateStr = formatDate(new Date());
  const loomEmbed = buildLoomEmbed(proposal.loom_url);
  const heroBanner = buildHeroBanner(proposal.hero_image_url);
  const drawingSection = buildDrawingSection(proposal.construction_drawing_url);

  const scopeHtml = renderScopeSection(sections, proposal.bid_total_amount);
  const materialsHtml = renderMaterialsSection(materials, categoryToSection);
  const whyPrepHtml = renderWhyPrepSection(installSections, sections, materials);
  const photosHtml = renderPhotosSection(photos);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(address || 'Bayside Pavers Proposal')} · Bayside Pavers</title>
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --green: #5d7e69;
    --green-dark: #4a6654;
    --green-soft: #e8eee9;
    --charcoal: #353535;
    --tan: #dad7c5;
    --cream: #faf8f3;
    --navy: #1a1f2e;
    --border: #e5e5e5;
    --muted: #666;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    color: var(--charcoal);
    background: #fff;
    line-height: 1.6;
    font-size: 16px;
  }
  .num { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
  a { color: inherit; }

  /* ═════════ Header ═════════ */
  .pub-header {
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .pub-header-logo { height: 40px; width: auto; display: block; }
  .pub-header-date { color: var(--muted); font-size: 14px; }

  /* ═════════ Hero ═════════ */
  .pub-hero {
    background: var(--cream);
    border-bottom: 1px solid var(--border);
  }
  .pub-hero-banner-wrap {
    width: 100%;
    max-height: 520px;
    overflow: hidden;
  }
  .pub-hero-banner {
    width: 100%;
    height: 100%;
    min-height: 360px;
    max-height: 520px;
    object-fit: cover;
    display: block;
  }
  .pub-hero-body {
    padding: 72px 32px 80px;
    text-align: center;
  }
  .pub-hero-banner-wrap + .pub-hero-body {
    padding-top: 56px;
  }
  .pub-hero-eyebrow {
    font-size: 13px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--green);
    margin-bottom: 20px;
    font-weight: 600;
  }
  .pub-hero-address {
    font-size: clamp(32px, 5vw, 52px);
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 12px;
    line-height: 1.15;
  }
  .pub-hero-city {
    font-size: 18px;
    color: var(--muted);
    margin-bottom: 32px;
  }
  .pub-hero-client {
    font-size: 15px;
    color: var(--muted);
    margin-bottom: 24px;
  }
  .pub-hero-total-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--muted);
    margin-bottom: 8px;
    font-weight: 600;
  }
  .pub-hero-total {
    font-size: clamp(40px, 7vw, 72px);
    font-weight: 700;
    color: var(--green);
    letter-spacing: -0.02em;
  }

  /* ═════════ Loom embed ═════════ */
  .pub-loom {
    max-width: 1000px;
    margin: 64px auto 0;
    padding: 0 32px;
  }
  .pub-loom-embed {
    position: relative;
    padding-bottom: 56.25%;
    height: 0;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    background: #000;
  }
  .pub-loom-embed iframe {
    position: absolute; top: 0; left: 0;
    width: 100%; height: 100%; border: 0;
  }

  /* ═════════ Section shell ═════════ */
  .pub-section {
    max-width: 1040px;
    margin: 0 auto;
    padding: 88px 32px;
  }
  .pub-section-eyebrow {
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--green);
    font-weight: 600;
    margin-bottom: 12px;
  }
  .pub-section h2 {
    font-size: clamp(28px, 4vw, 36px);
    font-weight: 600;
    letter-spacing: -0.01em;
    margin-bottom: 12px;
  }
  .pub-section-lede {
    color: var(--muted);
    margin-bottom: 48px;
    font-size: 17px;
    max-width: 640px;
  }

  /* ═════════ Construction drawing ═════════ */
  .pub-drawing {
    background: #fff;
    border-bottom: 1px solid var(--border);
  }
  .pub-drawing-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 88px 32px 64px;
  }
  .pub-drawing-frame {
    background: var(--cream);
    border-radius: 12px;
    padding: 32px;
    display: flex;
    justify-content: center;
    align-items: center;
    box-shadow: 0 4px 24px rgba(0,0,0,0.04);
    margin-top: 8px;
  }
  .pub-drawing-link {
    display: block;
    width: 100%;
    text-align: center;
    line-height: 0;
  }
  .pub-drawing-img {
    max-width: 100%;
    max-height: 720px;
    height: auto;
    display: block;
    margin: 0 auto;
    border-radius: 4px;
    cursor: zoom-in;
    transition: transform 0.2s ease;
  }
  .pub-drawing-img:hover { transform: scale(1.01); }
  .pub-drawing-caption {
    text-align: center;
    margin-top: 16px;
    font-size: 13px;
    color: var(--muted);
    font-style: italic;
  }

  /* ═════════ Scope of Work ═════════ */
  .pub-scope-list { list-style: none; }
  .pub-scope-item {
    padding: 28px 0;
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 32px;
    align-items: start;
  }
  .pub-scope-item-body { min-width: 0; }
  .pub-scope-item-name {
    font-size: 19px;
    font-weight: 600;
    margin-bottom: 14px;
    color: var(--navy);
  }
  .pub-scope-item-amount {
    font-weight: 600;
    font-size: 20px;
    white-space: nowrap;
    color: var(--charcoal);
  }
  .pub-scope-total {
    margin-top: 8px;
    padding: 28px 0 12px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 32px;
    font-size: 24px;
    font-weight: 700;
    color: var(--navy);
    border-top: 2px solid var(--charcoal);
  }

  /* Structured per-material line items inside each scope section (Sprint 3D).
     Replaces the prior middle-dot-joined paragraph. Each entry in
     proposal_sections.line_items renders as its own small card — either a
     structured block with a TYPE chip + name + attribute row, or a plain
     body line for construction notes without structure. */
  .pub-line-items {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pub-line-item {
    padding: 12px 16px;
    background: var(--cream);
    border-radius: 6px;
    border-left: 3px solid var(--green-soft);
    font-size: 14px;
    line-height: 1.55;
    color: var(--muted);
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .pub-line-item--structured {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    border-left-color: var(--green);
    padding: 14px 16px;
  }
  .pub-line-item-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .pub-line-item-type {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: var(--green-dark);
    background: #fff;
    border: 1px solid var(--green-soft);
    padding: 3px 8px;
    border-radius: 3px;
    text-transform: uppercase;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .pub-line-item-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--navy);
    line-height: 1.4;
  }
  .pub-line-item-body {
    color: var(--charcoal);
    flex: 1;
    min-width: 0;
  }
  .pub-line-item-attrs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 22px;
    font-size: 13px;
    padding-left: 0;
  }
  .pub-line-item-attr {
    color: var(--muted);
  }
  .pub-line-item-attr em {
    font-style: normal;
    font-weight: 600;
    color: var(--charcoal);
    letter-spacing: 0.02em;
    margin-right: 4px;
  }

  /* ═════════ Materials ═════════ */
  .pub-materials-group {
    margin-bottom: 64px;
  }
  .pub-materials-group:last-child { margin-bottom: 0; }
  .pub-materials-group-header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 2px solid var(--green);
  }
  .pub-materials-group-name {
    font-size: 22px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.01em;
  }
  .pub-materials-group-count {
    font-size: 13px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 600;
  }
  .pub-materials-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 24px;
  }
  .pub-material-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: #fff;
    display: flex;
    flex-direction: column;
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  .pub-material-card:hover {
    border-color: var(--green);
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.06);
  }
  .pub-material-card img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    display: block;
    background: var(--cream);
  }
  .pub-material-card-placeholder {
    width: 100%;
    aspect-ratio: 4 / 3;
    background: linear-gradient(135deg, var(--cream), var(--green-soft));
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--green);
    font-weight: 600;
    font-size: 14px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .pub-material-card-body {
    padding: 20px 22px;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .pub-material-card-name {
    font-size: 17px;
    font-weight: 600;
    color: var(--navy);
    line-height: 1.35;
    flex: 1;
  }
  .pub-material-card-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }
  .pub-material-card-btn {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border-radius: 6px;
    transition: background 0.15s;
  }
  .pub-material-card-btn-primary {
    background: var(--green-soft);
    color: var(--green-dark);
  }
  .pub-material-card-btn-primary:hover {
    background: var(--green);
    color: #fff;
  }
  .pub-material-card-btn-secondary {
    background: #fff;
    color: var(--charcoal);
    border: 1px solid var(--border);
  }
  .pub-material-card-btn-secondary:hover {
    border-color: var(--green);
    color: var(--green-dark);
  }

  /* ═════════ Why preparation matters ═════════ */
  .pub-prep {
    background: var(--cream);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .pub-prep-inner {
    max-width: 1040px;
    margin: 0 auto;
    padding: 96px 32px;
  }
  .pub-prep-intro {
    max-width: 760px;
    margin-bottom: 56px;
  }
  .pub-prep-intro p {
    font-size: 18px;
    line-height: 1.65;
    color: var(--charcoal);
  }
  .pub-prep-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 20px;
  }
  .pub-prep-card {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .pub-prep-card-number {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    color: var(--green);
    font-weight: 600;
    letter-spacing: 0.05em;
  }
  .pub-prep-card-title {
    font-size: 19px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.01em;
  }
  .pub-prep-card-body {
    color: var(--muted);
    font-size: 15px;
    line-height: 1.65;
  }

  /* Dynamic-section-only additions (Sprint 2 Part B.2) */
  .pub-prep-card-summary {
    color: var(--charcoal);
    font-size: 15px;
    line-height: 1.65;
  }
  .pub-prep-card-points {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .pub-prep-card-points li {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.55;
    padding-left: 18px;
    position: relative;
  }
  .pub-prep-card-points li::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
  }
  .pub-prep-card-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
    color: var(--green-dark);
    text-decoration: none;
  }
  .pub-prep-card-link:hover {
    color: var(--green);
    text-decoration: underline;
  }

  .pub-prep-footer {
    margin-top: 48px;
    padding-top: 32px;
    border-top: 1px solid var(--border);
    font-size: 15px;
    color: var(--muted);
    max-width: 760px;
    line-height: 1.65;
  }

  /* ═════════ Photos ═════════ */
  .pub-photos-group { margin-bottom: 56px; }
  .pub-photos-group:last-child { margin-bottom: 0; }
  .pub-photos-group-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--green);
    font-weight: 600;
    margin-bottom: 16px;
  }
  .pub-photos-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
  }
  .pub-photos-grid img {
    width: 100%;
    aspect-ratio: 4/3;
    object-fit: cover;
    border-radius: 8px;
    display: block;
    background: var(--cream);
  }

  /* ═════════ Footer CTAs ═════════ */
  .pub-footer-ctas {
    background: var(--cream);
    padding: 96px 32px;
    text-align: center;
    border-top: 1px solid var(--border);
  }
  .pub-footer-ctas h2 {
    font-size: clamp(28px, 4vw, 36px);
    font-weight: 600;
    margin-bottom: 12px;
  }
  .pub-footer-ctas p {
    color: var(--muted);
    margin-bottom: 40px;
    font-size: 17px;
  }
  .pub-cta-row {
    display: flex;
    gap: 14px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .pub-btn {
    display: inline-block;
    padding: 17px 34px;
    border-radius: 6px;
    font-weight: 600;
    text-decoration: none;
    font-size: 15px;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    border: 1px solid transparent;
  }
  .pub-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0,0,0,0.1); }
  .pub-btn-call {
    background: #fff;
    color: var(--navy);
    border-color: var(--navy);
  }
  .pub-btn-guide {
    background: var(--green);
    color: var(--tan);
  }

  /* ═════════ Bottom strip ═════════ */
  .pub-bottom {
    padding: 40px 32px;
    text-align: center;
    color: #999;
    font-size: 13px;
    border-top: 1px solid var(--border);
  }

  /* ═════════ Mobile ═════════ */
  @media (max-width: 640px) {
    .pub-header { padding: 20px; }
    .pub-hero-body { padding: 48px 20px 56px; }
    .pub-hero-banner-wrap + .pub-hero-body { padding-top: 40px; }
    .pub-hero-banner { min-height: 240px; max-height: 340px; }
    .pub-section { padding: 56px 20px; }
    .pub-prep-inner { padding: 72px 20px; }
    .pub-drawing-inner { padding: 56px 20px 40px; }
    .pub-drawing-frame { padding: 14px; }
    .pub-loom { padding: 0 20px; margin-top: 48px; }
    .pub-scope-item { grid-template-columns: 1fr; gap: 12px; }
    .pub-scope-item-amount { font-size: 18px; }
    .pub-line-item { padding: 10px 12px; }
    .pub-line-item--structured { padding: 12px 14px; }
    .pub-line-item-attrs { gap: 4px 14px; }
    .pub-footer-ctas { padding: 64px 20px; }
    .pub-materials-group-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
  }
</style>
</head>
<body>
  <header class="pub-header">
    <img src="${escapeAttr(BAYSIDE_LOGO_URL)}" alt="Bayside Pavers" class="pub-header-logo">
    <span class="pub-header-date">${escapeHtml(dateStr)}</span>
  </header>

  <section class="pub-hero">
    ${heroBanner}
    <div class="pub-hero-body">
      <div class="pub-hero-eyebrow">Design Proposal</div>
      <h1 class="pub-hero-address">${escapeHtml(address || 'Bayside Pavers')}</h1>
      ${cityLine ? `<div class="pub-hero-city">${escapeHtml(cityLine)}</div>` : ''}
      ${clientName ? `<div class="pub-hero-client">Prepared for ${escapeHtml(clientName)}</div>` : ''}
      ${total ? `
        <div class="pub-hero-total-label">Project total</div>
        <div class="pub-hero-total num">${escapeHtml(total)}</div>
      ` : ''}
    </div>
  </section>

  ${loomEmbed}

  ${drawingSection}

  ${scopeHtml}

  ${materialsHtml}

  ${whyPrepHtml}

  ${photosHtml}

  <section class="pub-footer-ctas">
    <h2>Ready to move forward?</h2>
    <p>Questions about the scope, materials, or next steps? Call Tim directly.</p>
    <div class="pub-cta-row">
      <a href="tel:${TIM_PHONE_HREF}" class="pub-btn pub-btn-call">
        Call Tim · ${TIM_PHONE}
      </a>
      <a href="${escapeAttr(INSTALL_GUIDE_URL)}" class="pub-btn pub-btn-guide"
        target="_blank" rel="noopener">
        View Installation Guide
      </a>
    </div>
  </section>

  <div class="pub-bottom">
    Proposal prepared by Tim McMullen · Bayside Pavers
  </div>
</body>
</html>`;
}

// ───────────────────────────────────────────────────────────────────────────
// Template partials
// ───────────────────────────────────────────────────────────────────────────
function buildHeroBanner(url) {
  if (!url) return '';
  return `
    <div class="pub-hero-banner-wrap">
      <img src="${escapeAttr(url)}" alt="Project rendering" class="pub-hero-banner">
    </div>
  `;
}

// Sprint 3 Part D: construction drawing featured section. Renders as its
// own framed block between the hero/Loom and the Scope of Work. Returns an
// empty string when no drawing has been selected, so unselected proposals
// render unchanged.
function buildDrawingSection(url) {
  if (!url) return '';
  return `
    <section class="pub-drawing">
      <div class="pub-drawing-inner">
        <div class="pub-section-eyebrow">Construction drawing</div>
        <h2>Your project plan</h2>
        <p class="pub-section-lede">The working plan-view for your project — dimensions, material zones, and elevations captured in a single reference.</p>
        <div class="pub-drawing-frame">
          <a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="pub-drawing-link">
            <img src="${escapeAttr(url)}" alt="Construction drawing" class="pub-drawing-img">
          </a>
        </div>
        <p class="pub-drawing-caption">Click to view full size.</p>
      </div>
    </section>
  `;
}

function renderScopeSection(sections, totalAmount) {
  if (!sections.length) return '';

  const items = sections.map(s => {
    const lineItemsHtml = formatLineItemsHtml(s.line_items);
    const amount = s.total_amount != null ? formatMoney(s.total_amount) : '';
    return `
      <li class="pub-scope-item">
        <div class="pub-scope-item-body">
          <div class="pub-scope-item-name">${escapeHtml(s.name || 'Untitled section')}</div>
          ${lineItemsHtml}
        </div>
        ${amount ? `<div class="pub-scope-item-amount num">${escapeHtml(amount)}</div>` : ''}
      </li>
    `;
  }).join('');

  const totalRow = totalAmount != null ? `
    <div class="pub-scope-total">
      <span>Total</span>
      <span class="num">${escapeHtml(formatMoney(totalAmount))}</span>
    </div>
  ` : '';

  return `
    <section class="pub-section">
      <div class="pub-section-eyebrow">01</div>
      <h2>Scope of work</h2>
      <p class="pub-section-lede">The complete breakdown of everything included in your project, with materials, colors, and construction details broken out per line.</p>
      <ul class="pub-scope-list">${items}</ul>
      ${totalRow}
    </section>
  `;
}

function renderMaterialsSection(materials, categoryToSection) {
  if (!materials.length) return '';

  const groups = groupMaterialsByArea(materials);
  const groupsHtml = Object.entries(groups).map(([area, items]) => `
    <div class="pub-materials-group">
      <div class="pub-materials-group-header">
        <div class="pub-materials-group-name">${escapeHtml(area)}</div>
        <div class="pub-materials-group-count">${items.length} ${items.length === 1 ? 'product' : 'products'}</div>
      </div>
      <div class="pub-materials-grid">
        ${items.map(m => renderMaterialCard(m, categoryToSection)).join('')}
      </div>
    </div>
  `).join('');

  return `
    <section class="pub-section">
      <div class="pub-section-eyebrow">02</div>
      <h2>Selected materials</h2>
      <p class="pub-section-lede">Products chosen for your project, grouped by application area. Click any material for its cut sheet or installation walkthrough.</p>
      ${groupsHtml}
    </section>
  `;
}

function renderMaterialCard(m, categoryToSection) {
  const info = extractMaterialInfo(m, categoryToSection);
  const imgHtml = info.imageUrl
    ? `<img src="${escapeAttr(info.imageUrl)}" alt="${escapeAttr(info.name)}">`
    : `<div class="pub-material-card-placeholder">${escapeHtml((info.name || 'Material').slice(0, 3).toUpperCase())}</div>`;

  const cutSheetBtn = info.cutSheetUrl ? `
    <a href="${escapeAttr(info.cutSheetUrl)}" target="_blank" rel="noopener"
      class="pub-material-card-btn pub-material-card-btn-primary">
      <span>View cut sheet</span>
      <span>↗</span>
    </a>
  ` : '';

  const installBtn = info.installGuideUrl ? `
    <a href="${escapeAttr(info.installGuideUrl)}" target="_blank" rel="noopener"
      class="pub-material-card-btn pub-material-card-btn-secondary">
      <span>See installation</span>
      <span>↗</span>
    </a>
  ` : '';

  const actions = (cutSheetBtn || installBtn)
    ? `<div class="pub-material-card-actions">${cutSheetBtn}${installBtn}</div>`
    : '';

  return `
    <div class="pub-material-card">
      ${imgHtml}
      <div class="pub-material-card-body">
        <div class="pub-material-card-name">${escapeHtml(info.name)}</div>
        ${actions}
      </div>
    </div>
  `;
}

function groupMaterialsByArea(materials) {
  const groups = {};
  for (const m of materials) {
    const area = m.application_area || 'Other materials';
    if (!groups[area]) groups[area] = [];
    groups[area].push(m);
  }
  return groups;
}

function extractMaterialInfo(m, categoryToSection) {
  // Look up a page-anchored deep link to the master Belgard install guide
  // PDF based on the material's category. If no section is mapped, fall
  // back to the generic Bayside install guide URL when installation_guide_id
  // is set (preserves Sprint 1 behavior for unmapped materials).
  const lookupInstallGuide = (catalogRow) => {
    if (categoryToSection && catalogRow.category_id) {
      const section = categoryToSection.get(catalogRow.category_id);
      if (section && Number.isFinite(section.page_start)) {
        return `${BELGARD_MASTER_INSTALL_GUIDE_URL}#page=${section.page_start}`;
      }
    }
    return catalogRow.installation_guide_id ? INSTALL_GUIDE_URL : '';
  };

  if (m.material_source === 'belgard' && m.belgard_material) {
    const bm = m.belgard_material;
    return {
      name: bm.product_name || 'Belgard product',
      // Preference order (Sprint 3 Part A): per-color swatch beats the
      // generic product hero. Once a variant has its Scandina Gray / Sepia /
      // etc. swatch uploaded, it displays instead of the shared Catalina
      // Grana beauty shot. Falls back to primary_image_url (category-level
      // hero from Sprint 2A) and then to legacy image_url.
      imageUrl: bm.swatch_url
        || bm.primary_image_url
        || bm.image_url
        || '',
      cutSheetUrl: bm.cut_sheet_url || '',
      installGuideUrl: lookupInstallGuide(bm),
    };
  }
  if (m.material_source === 'third_party' && m.third_party_material) {
    const tp = m.third_party_material;
    return {
      name: tp.product_name || 'Third-party product',
      imageUrl: tp.primary_image_url
        || tp.image_url
        || '',
      cutSheetUrl: tp.cut_sheet_url || '',
      // Third-party materials use the generic Bayside guide — the master
      // Belgard PDF's page anchors only apply to Belgard products.
      installGuideUrl: tp.installation_guide_id ? INSTALL_GUIDE_URL : '',
    };
  }
  return { name: 'Material', imageUrl: '', cutSheetUrl: '', installGuideUrl: '' };
}

// ───────────────────────────────────────────────────────────────────────────
// "Why our preparation matters" section
//
// Sprint 2 Part B.2: dynamic rendering from installation_guide_sections for
// Belgard-category materials.
// Sprint 3 Part C: extended to also render non-Belgard cards (turf,
// Tru-Scapes lighting) via pattern match against scope text + third-party
// materials. See renderThirdPartyPrepCards.
//
// Falls back to the hardcoded 4-card version only when neither Belgard
// sections nor third-party patterns match — keeps proposals with
// uncategorized materials from rendering an empty section.
// ───────────────────────────────────────────────────────────────────────────
function renderWhyPrepSection(installSections, sections, materials) {
  const belgardCardsHtml = (Array.isArray(installSections) && installSections.length > 0)
    ? renderDynamicPrepCards(installSections)
    : '';

  const belgardCount = Array.isArray(installSections) ? installSections.length : 0;
  const thirdPartyCardsHtml = renderThirdPartyPrepCards(sections, materials, belgardCount);

  const combinedHtml = belgardCardsHtml + thirdPartyCardsHtml;
  const cardsHtml = combinedHtml || renderHardcodedPrepCards();

  return `
    <section class="pub-prep">
      <div class="pub-prep-inner">
        <div class="pub-section-eyebrow">03 · Quality standards</div>
        <h2>Why our preparation matters</h2>
        <div class="pub-prep-intro">
          <p>The biggest cost difference between paver installers isn't the pavers themselves — it's what happens <em>before</em> the first stone is placed. Base preparation, compaction, drainage, and edge restraint are the work that determines whether your installation lasts 5 years or 30. Here's what we do that cheaper bids skip.</p>
        </div>
        <div class="pub-prep-grid">
          ${cardsHtml}
        </div>
        <div class="pub-prep-footer">
          Want to see what this looks like in practice? Ask Tim for a site visit to an active installation — it's the fastest way to understand what you're paying for.
        </div>
      </div>
    </section>
  `;
}

function renderDynamicPrepCards(installSections) {
  // Order sections by their page_start in the source PDF — this matches the
  // natural flow of the Belgard guide (pavers → porcelain → walls → accessories
  // → fire features) and avoids alphabetical-by-section_key awkwardness.
  const ordered = [...installSections].sort((a, b) =>
    (a.page_start || 9999) - (b.page_start || 9999)
  );

  return ordered.map((section, idx) => {
    const number = String(idx + 1).padStart(2, '0');
    const summary = section.summary || '';
    const keyPoints = Array.isArray(section.key_points) ? section.key_points : [];
    const pointsHtml = keyPoints
      .map(p => `<li>${escapeHtml(p)}</li>`)
      .join('');
    const pdfAnchor = Number.isFinite(section.page_start)
      ? `${BELGARD_MASTER_INSTALL_GUIDE_URL}#page=${section.page_start}`
      : BELGARD_MASTER_INSTALL_GUIDE_URL;

    return `
      <div class="pub-prep-card">
        <div class="pub-prep-card-number">${number}</div>
        <div class="pub-prep-card-title">${escapeHtml(section.title || 'Installation standard')}</div>
        ${summary ? `<div class="pub-prep-card-summary">${escapeHtml(summary)}</div>` : ''}
        ${pointsHtml ? `<ul class="pub-prep-card-points">${pointsHtml}</ul>` : ''}
        <a href="${escapeAttr(pdfAnchor)}" target="_blank" rel="noopener"
          class="pub-prep-card-link">
          View the full installation standards →
        </a>
      </div>
    `;
  }).join('');
}

// ───────────────────────────────────────────────────────────────────────────
// Third-party quality-standards cards (Sprint 3 Part C)
//
// Renders additional "Why preparation matters" cards for non-Belgard
// categories that need client-facing standards education — currently
// artificial turf (Evergrass / MSI) and Tru-Scapes® low-voltage lighting.
//
// Detection is pattern-based against BOTH:
//   • proposal_sections.line_items — where scope-line notes live for turf
//     and Tru-Scapes products (e.g. "TURF: ARIZONA PLATINUM SPRING…",
//     "TruScape Path Light Bronze")
//   • proposal_materials (third-party rows) — for structured product picks
//
// When the installation_guide_sections schema is extended to cover
// non-Belgard categories, this function migrates to a data-driven query.
// ───────────────────────────────────────────────────────────────────────────
function renderThirdPartyPrepCards(sections, materials, startIndex = 0) {
  const cards = [];

  if (proposalHasTurf(sections, materials)) {
    cards.push({
      title: 'Artificial Turf Installation',
      summary: "Long-lasting synthetic turf installations depend on base preparation that matches paver-grade standards: 4–6 inches of excavation, compaction of subgrade soil, and a 3–4 inch crushed gravel base compacted in lifts. The difference between a turf installation that stays level and plush for 15 years and one that ripples, pools water, or mats down in two is whether the installer treats the base with the same rigor as a paver base. We do. We also direction-match turf pieces, use S-cut seams for invisible transitions, and finish with silica sand infill to keep blades upright and UV-protected.",
      keyPoints: [
        'Minimum 4–6 inches of excavation below finished grade, with existing sprinkler heads capped at pipe level (not the riser) to prevent leakage, and irrigation/electrical lines mapped before any digging',
        'Subgrade compacted with a minimum 5,000 lb plate compactor — the same machine used for paver bases — followed by a weed barrier on compacted subgrade; plastic sheeting is explicitly prohibited as it traps water and causes turf to heave',
        'Base layer of 3/4-inch to dust crushed gravel installed in 3–4 inch lifts, compacted with water-assist; minimum 2% slope away from structures to drainage points, identical to our paver drainage spec',
        'All turf pieces laid with blade direction matched (pile nap running the same way); seams joined via S-cut method with seam tape and synthetic turf adhesive, then secured with U-nails spaced every 6 inches along the full seam length',
        'Edges tucked with wonder bar into hardscape perimeters; silica sand infill applied via drop spreader and power-brushed into the base of the blades, then watered to settle — the infill is what keeps blades upright and the surface walkable for 15+ years',
      ],
      pdfUrl: EVERGRASS_INSTALL_GUIDE_URL,
      linkLabel: 'View the Evergrass installation guide',
    });
  }

  if (proposalHasTruScapesLighting(sections, materials)) {
    cards.push({
      title: 'Landscape & Hardscape Lighting',
      summary: "Your proposal includes Tru-Scapes® low-voltage landscape lighting — a complete outdoor system covering path lights, accent spots, in-ground well lights, paver-integrated fixtures, and Color Control app-based tuning (RGBCW, dimming, zones). The fixture count and budget are set in your bid, but fixture placement is intentionally flexible: we finalize exact positioning during the Pre-Walk with you on-site, so the lighting accents what actually matters — tree canopies, walkway curves, step transitions, architectural features — rather than being locked to a blueprint before we've seen it in context.",
      keyPoints: [
        'Low-voltage 12V/15V system with Tru-Scapes® transformers sized to load (100W, 200W, or 400W WiFi-enabled) and tin-plated copper heat-shrink wire connectors for waterproof, lifetime-duty splices',
        'Color Control available on most fixtures: full-color RGBCW spectrum, warm-to-cool white tuning (2700K–6500K), dimming, and multi-zone scene control via the Tru-Scapes® Bluetooth app',
        'Fixture library covers every outdoor placement — path, accent, wall-wash, in-ground well, paver-integrated, step riser, post cap, sconce, pendant, bistro, and concrete-embed — so the same system scales from subtle to dramatic without mixing manufacturers',
        'Final placement decided at Pre-Walk: before wiring is pulled, we walk the site with you and mark each fixture location together — path lights spaced to the actual walkway curve, accent lights aimed at the real tree or feature, step lights positioned for the true stride of each tread',
        '5-year warranty on fixtures, bulbs, and transformers; all fixtures IP-rated for direct-burial and year-round outdoor use in California climate',
      ],
      pdfUrl: TRU_SCAPES_PRODUCT_GUIDE_URL,
      linkLabel: 'View the Tru-Scapes product guide',
    });
  }

  return cards.map((c, i) => {
    const number = String(startIndex + i + 1).padStart(2, '0');
    const pointsHtml = c.keyPoints
      .map(p => `<li>${escapeHtml(p)}</li>`)
      .join('');
    return `
      <div class="pub-prep-card">
        <div class="pub-prep-card-number">${number}</div>
        <div class="pub-prep-card-title">${escapeHtml(c.title)}</div>
        <div class="pub-prep-card-summary">${escapeHtml(c.summary)}</div>
        <ul class="pub-prep-card-points">${pointsHtml}</ul>
        <a href="${escapeAttr(c.pdfUrl)}" target="_blank" rel="noopener"
          class="pub-prep-card-link">
          ${escapeHtml(c.linkLabel)} →
        </a>
      </div>
    `;
  }).join('');
}

function proposalHasTurf(sections, materials) {
  const turfRe = /\b(turf|artificial\s+grass|synthetic\s+grass|evergrass)\b/i;
  if (scopeContains(sections, turfRe)) return true;
  for (const m of materials || []) {
    if (m.material_source !== 'third_party') continue;
    const tp = m.third_party_material;
    if (!tp) continue;
    const hay = `${tp.manufacturer || ''} ${tp.product_name || ''} ${tp.category || ''}`;
    if (turfRe.test(hay)) return true;
  }
  return false;
}

function proposalHasTruScapesLighting(sections, materials) {
  const re = /tru-?\s*scapes?/i;
  if (scopeContains(sections, re)) return true;
  for (const m of materials || []) {
    if (m.material_source !== 'third_party') continue;
    const tp = m.third_party_material;
    if (!tp) continue;
    const hay = `${tp.manufacturer || ''} ${tp.product_name || ''}`;
    if (re.test(hay)) return true;
  }
  return false;
}

function scopeContains(sections, regex) {
  for (const s of sections || []) {
    if (regex.test(s.name || '')) return true;
    const items = Array.isArray(s.line_items) ? s.line_items : [];
    for (const li of items) {
      const text = typeof li === 'string' ? li : (li?.description || li?.text || '');
      if (regex.test(text)) return true;
    }
  }
  return false;
}

function renderHardcodedPrepCards() {
  // Fallback used when no install_guide_sections match the proposal's
  // material categories. Matches the Sprint 1 content verbatim so the page
  // never renders empty even for proposals with uncategorized materials.
  return `
    <div class="pub-prep-card">
      <div class="pub-prep-card-number">01</div>
      <div class="pub-prep-card-title">Proper base preparation</div>
      <div class="pub-prep-card-body">We excavate to the depth required for long-term stability and install a thick aggregate base below every paver. Skimping here is the most common shortcut — and the most common reason pavers settle, dip, or heave within a few years.</div>
    </div>
    <div class="pub-prep-card">
      <div class="pub-prep-card-number">02</div>
      <div class="pub-prep-card-title">ICPI-standard compaction</div>
      <div class="pub-prep-card-body">The Interlocking Concrete Pavement Institute sets compaction standards for every paver installation. We compact the base in multiple lifts with commercial-grade equipment to reach the required density at every layer — not just the top.</div>
    </div>
    <div class="pub-prep-card">
      <div class="pub-prep-card-number">03</div>
      <div class="pub-prep-card-title">Edge restraints and drainage</div>
      <div class="pub-prep-card-body">Pavers don't move when they're properly restrained and when water can't pool underneath. We install permanent edge restraints and grade every site for positive drainage away from your home.</div>
    </div>
    <div class="pub-prep-card">
      <div class="pub-prep-card-number">04</div>
      <div class="pub-prep-card-title">Lifetime workmanship warranty</div>
      <div class="pub-prep-card-body">Because we follow ICPI standards and document our process, we back every installation with a lifetime warranty on workmanship. Ask any installer for their warranty in writing — what you find will tell you a lot.</div>
    </div>
  `;
}

function renderPhotosSection(photos) {
  if (!photos.length) return '';

  const groups = groupPhotosByLocation(photos);
  const groupsHtml = Object.entries(groups).map(([label, items]) => {
    const imgs = items.map(p => {
      const url = storagePublicUrl(p.storage_path);
      if (!url) return '';
      return `<img src="${escapeAttr(url)}" alt="${escapeAttr(p.original_filename || 'Property photo')}" loading="lazy">`;
    }).join('');
    return `
      <div class="pub-photos-group">
        <div class="pub-photos-group-label">${escapeHtml(label)}</div>
        <div class="pub-photos-grid">${imgs}</div>
      </div>
    `;
  }).join('');

  return `
    <section class="pub-section">
      <div class="pub-section-eyebrow">04</div>
      <h2>Property photos</h2>
      <p class="pub-section-lede">Current site conditions.</p>
      ${groupsHtml}
    </section>
  `;
}

function groupPhotosByLocation(photos) {
  const order = ['Front yard', 'Backyard', 'Side yard', 'Full property', 'Other'];
  const groups = {};
  for (const p of photos) {
    const label = p.location_tag || 'Other';
    if (!groups[label]) groups[label] = [];
    groups[label].push(p);
  }
  const ordered = {};
  for (const key of order) if (groups[key]) ordered[key] = groups[key];
  for (const key of Object.keys(groups)) if (!ordered[key]) ordered[key] = groups[key];
  return ordered;
}

function storagePublicUrl(path) {
  if (!path) return '';
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data?.publicUrl || '';
}

function publicUrl(path) {
  return storagePublicUrl(path);
}

function buildLoomEmbed(loomUrl) {
  const embed = loomUrlToEmbed(loomUrl);
  if (!embed) return '';
  return `
    <div class="pub-loom">
      <div class="pub-loom-embed">
        <iframe src="${escapeAttr(embed)}" frameborder="0"
          allowfullscreen webkitallowfullscreen mozallowfullscreen></iframe>
      </div>
    </div>
  `;
}

function loomUrlToEmbed(url) {
  if (!url) return '';
  const m = url.match(/loom\.com\/(?:share|embed)\/([a-f0-9]+)/i);
  if (!m) return '';
  return `https://www.loom.com/embed/${m[1]}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Scope line item rendering (Sprint 3 Part D)
//
// Each entry in proposal_sections.line_items comes in as either a string or
// an object with { description } / { text }. The strings follow a loose
// contractor convention that we parse into three visible pieces:
//
//   1. TYPE prefix — an ALL-CAPS phrase (2+ chars, may contain spaces,
//      slashes, en-dashes) terminated by a colon. Examples: "PAVER:",
//      "TURF:", "STEP:", "STRUCTURAL RETAINING WALL:", "PLANT INSTALLATION
//      – LABOR ONLY:". We require ALL-CAPS so we don't false-match things
//      like "Gravel:" or "Install 3/4\" pipe:" which are narrative, not type
//      tags.
//
//   2. Primary name/description — everything up to the first pipe `|`.
//      For a structured material line ("PAVER: BELGARD DIMENSIONS 12 |
//      PATTERN: RANDOM | COLOR: DURAFUSION") this is the material name.
//      For a narrative line ("STEP: Provide and install bullnose step...")
//      this is the body sentence.
//
//   3. Attribute pairs — remaining pipe-delimited segments, each expected
//      in "KEY: VALUE" shape. Gets rendered as a row of little
//      "Pattern: Random · Color: Durafusion" chips.
//
// Lines that don't match the TYPE pattern still render — they just skip the
// type chip and fall through to a plain body-text treatment. Same for lines
// with no pipes (no attributes row).
// ───────────────────────────────────────────────────────────────────────────
function formatLineItemsHtml(lineItems) {
  if (!lineItems) return '';

  const rawItems = Array.isArray(lineItems) ? lineItems : [lineItems];
  const parsed = rawItems
    .map(parseLineItem)
    .filter(Boolean);

  if (parsed.length === 0) return '';

  return `<ul class="pub-line-items">${parsed.map(renderLineItem).join('')}</ul>`;
}

function parseLineItem(raw) {
  const text = (typeof raw === 'string'
    ? raw
    : (raw?.description || raw?.text || '')).trim();
  if (!text) return null;

  let type = '';
  let rest = text;

  // ALL-CAPS prefix ending in colon. Requires the type to be at least 2
  // characters long so single-letter prefixes don't false-match. Allows
  // spaces, slashes, en-dashes, ampersands inside the type phrase.
  const typeMatch = text.match(/^([A-Z][A-Z\s\/\u2013&-]*?):\s*(.+)$/s);
  if (typeMatch && typeMatch[1].trim().length >= 2) {
    type = typeMatch[1].trim();
    rest = typeMatch[2].trim();
  }

  const parts = rest.split('|').map(p => p.trim()).filter(Boolean);
  const primary = parts[0] || '';
  const attrs = parts.slice(1).map(part => {
    const kv = part.match(/^([^:]+):\s*(.+)$/);
    if (kv) return { label: titleCaseLabel(kv[1].trim()), value: kv[2].trim() };
    return { label: '', value: part };
  });

  return { type, primary, attrs };
}

function renderLineItem({ type, primary, attrs }) {
  const typeTag = type
    ? `<span class="pub-line-item-type">${escapeHtml(type)}</span>`
    : '';

  const hasAttrs = attrs && attrs.length > 0;

  if (hasAttrs) {
    const attrsHtml = attrs.map(a => {
      if (a.label) {
        return `<span class="pub-line-item-attr"><em>${escapeHtml(a.label)}:</em>${escapeHtml(a.value)}</span>`;
      }
      return `<span class="pub-line-item-attr">${escapeHtml(a.value)}</span>`;
    }).join('');

    return `
      <li class="pub-line-item pub-line-item--structured">
        <div class="pub-line-item-head">
          ${typeTag}
          <span class="pub-line-item-name">${escapeHtml(primary)}</span>
        </div>
        <div class="pub-line-item-attrs">${attrsHtml}</div>
      </li>
    `;
  }

  return `
    <li class="pub-line-item">
      ${typeTag}
      <span class="pub-line-item-body">${escapeHtml(primary)}</span>
    </li>
  `;
}

// Title-case attribute labels so "PATTERN" renders as "Pattern", "PART
// NUMBER" as "Part Number", etc. Values are left unchanged — they contain
// proper nouns, SKU codes, and mixed-case color names that we don't want
// to re-case.
function titleCaseLabel(s) {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Legacy string-concatenation formatter. No longer called by renderScopeSection
// (which now uses formatLineItemsHtml), but kept exported-in-spirit for
// safety in case other callers reference it.
function formatLineItems(lineItems) {
  if (!lineItems) return '';
  if (typeof lineItems === 'string') return lineItems;
  if (!Array.isArray(lineItems)) return '';
  return lineItems
    .map(li => (typeof li === 'string' ? li : (li.description || li.text || '')))
    .filter(Boolean)
    .join(' · ');
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function setStatus(msg, kind) {
  const el = document.getElementById('bpPublishStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'bp-publish-status' + (kind ? ` bp-publish-status-${kind}` : '');
}

function showError(msg) {
  setStatus(msg, 'error');
}

function formatMoney(n) {
  const num = Number(n) || 0;
  return '$' + num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatDate(d) {
  return d.toLocaleDateString('en-US',
    { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US',
    { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US',
    { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
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
