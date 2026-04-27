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
//   6. [Sprint 3 Part F] Property photos section split into TWO top-level
//      sections on the published page — "Current site conditions" (04)
//      and "Design renderings" (05). Sprint 3F partitioned on
//      extraction_source as a proxy, which assumed PDF-extracted images
//      were always renderings and manual uploads were always photos.
//
//   7. [Sprint 3 Part G] Photo classification is now user-controlled via
//      the new proposal_images.display_section column (migration 015).
//      Each image is tagged 'current_photo', 'design_rendering', or
//      'hidden' from a dropdown in Section 05 of the BPB editor. This
//      replaces the extraction_source proxy from Sprint 3F — because a
//      bid PDF can contain real current-condition photos, and a manual
//      upload can be a SketchUp screenshot, the old partition inverted
//      for proposals like Parag's 88 Prospect. Legacy rows with null
//      display_section fall back to the Sprint 3F logic so nothing
//      disappears silently during the migration rollout.
//
//      Mobile spacing on scope line items also improved in this sprint:
//      non-structured line items now stack vertically on narrow viewports
//      (<640px) so the TYPE chip and body text each get full width
//      instead of the body being compressed into a narrow right column
//      next to a wide empty left column.
//
//   8. [Sprint 3 Part J] Turf prep-card false-positive fix. Sprint 3C's
//      turf detection scanned scope line_items with a single regex that
//      included a bare \bturf\b alternate — which matches demolition
//      language like "Remove and dispose of existing turf/flagstone/tile
//      material" on proposals where no synthetic turf is actually being
//      installed (e.g. 1728 Whitham Ave). The regex is now split into
//      TURF_GENERIC_PATTERN (plain "turf", "artificial grass", "synthetic
//      grass") and TURF_SPECIFIC_PATTERN (brand/product names: evergrass,
//      summer gold, platinum spring, arizona platinum). Scope-text scanning
//      uses ONLY the specific pattern, so an off-hand "turf" mention in
//      demolition or "sod installation" no longer triggers the prep card.
//      The materials-list check still uses the combined pattern —
//      third_party_materials rows are explicitly categorized, so any turf
//      signal there is authoritative. resolveThirdPartyInstallUrl() also
//      still uses the combined pattern for material-row URL routing.
//      Tru-Scapes detection is unchanged — "Tru-Scapes"/"TruScape" is a
//      specific brand mark with no ambiguous contexts, so scope-text
//      scanning for it remains safe.
//
//   9. [Phase 1B] Polygon overlay on the construction drawing. When a
//      proposal has labeled regions (proposal_regions, drawn in the
//      site-map labeling tool admin UI) AND a backdrop image with stored
//      native dimensions (proposals.site_plan_backdrop_url + width +
//      height), the public construction-drawing section renders the
//      backdrop with an SVG overlay on top. Each polygon is a clickable
//      anchor scrolling to its corresponding scope section (#section-{id})
//      when proposal_section_id is set; unlinked regions render as visual
//      markers only. When no regions are present, the existing
//      construction_drawing_url + lightbox-to-zoom behavior is preserved
//      byte-identical so the 40 already-published proposals are unchanged.
//
//  10. [Phase 1B.2] Two-column layout for the construction-drawing
//      polygon view (Condo Market SF pattern). Drawing sticks to the
//      left while a scrollable list of region cards runs down the right.
//      Each card shows the region name + the materials assigned to its
//      scope section, with bidirectional hover sync — hover a card →
//      the matching polygon highlights; hover a polygon → its card
//      highlights. Polygons get a louder treatment (thicker stroke,
//      higher fill opacity, brighter active state). Mobile collapses to
//      a single column with cards stacked under the drawing. Inline
//      script at the end of the section wires up the sync. No schema
//      changes; cards are derived from existing proposal_materials rows
//      filtered by proposal_section_id. The legacy construction_drawing_url
//      branch (no regions) is unchanged from Phase 1B.
//
//  11. [Phase 1B.3] Per-region material assignments via a proper
//      many-to-many join (proposal_region_materials, schema migration
//      phase_1b3_proposal_region_materials_join). The right-rail card
//      now prefers explicit assignments from the join table when they
//      exist — rendering only those materials in their stored
//      display_order. When a region has no assignments (legacy
//      regions, or regions Tim hasn't labeled with materials yet) it
//      falls back to the Phase 1B.2 behavior of listing every material
//      whose proposal_section_id matches the region's section. The
//      labeling tool admin UI grew a togglable-pill picker per region
//      card so Tim can assign materials directly without needing
//      proposal_materials.proposal_section_id to be set first. The
//      legacy proposals.construction_drawing_url branch (no regions)
//      is still unchanged.
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
const TIM_PHONE = '415-691-9272';
const TIM_PHONE_HREF = '+14156919272';
const TIM_EMAIL = 'Tim@BaysidePavers.com';
const BUCKET = 'proposal-photos';

let proposalId = null;
let container = null;
let onSaveCb = null;
let currentData = null; // { proposal, sections, materials, photos, heroCandidates, drawingCandidates, history, installSections, categoryToSection, regions }

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
  //
  // regions query (Phase 1B): proposal_regions for this proposal, in
  // display_order. When the proposal has a labeled site-map backdrop, these
  // become the polygon overlay rendered on top of the construction drawing
  // on the published page.
  //
  // Phase 1B.3: the regions query now also embeds proposal_region_materials
  // via PostgREST so each region carries its explicit material assignments
  // (with display_order) inline. When that array is non-empty, the right-rail
  // card renders only those materials in order; when empty, the Phase 1B.2
  // section-filter fallback kicks in. The dev_all_proposal_region_materials
  // RLS policy mirrors proposal_regions so anon read works the same way.
  const [proposalQ, sectionsQ, materialsQ, photosQ, heroCandidatesQ, drawingCandidatesQ, historyQ, regionsQ] = await Promise.all([
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
    supabase.from('proposal_regions')
      .select('*, region_materials:proposal_region_materials(proposal_material_id, display_order)')
      .eq('proposal_id', proposalId)
      .order('display_order', { ascending: true }),
  ]);

  const err = proposalQ.error || sectionsQ.error || materialsQ.error
    || photosQ.error || heroCandidatesQ.error || drawingCandidatesQ.error
    || historyQ.error || regionsQ.error;
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
    regions: regionsQ.data || [],
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
function buildHtmlSnapshot({ proposal, sections, materials, photos, installSections, categoryToSection, regions }) {
  const address = proposal.project_address || '';
  const cityLine = [proposal.project_city, proposal.project_state,
    proposal.project_zip].filter(Boolean).join(', ');
  const clientName = proposal.client_name || '';
  const total = proposal.bid_total_amount != null
    ? formatMoney(proposal.bid_total_amount) : null;
  const dateStr = formatDate(new Date());
  const loomEmbed = buildLoomEmbed(proposal.loom_url);
  const heroBanner = buildHeroBanner(proposal.hero_image_url);
  const drawingSection = buildDrawingSection(proposal, regions, materials, categoryToSection);

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

  /* Phase 1B — polygon overlay on the construction drawing.
     The wrap is inline-block so it shrink-wraps to the rendered img size;
     the SVG is 100%/100% absolutely positioned so it always matches the img
     exactly, regardless of how the img scales (max-width 100% on small
     screens, max-height 720px on large ones). The viewBox uses the
     backdrop's native pixel dimensions, so polygon coords convert from
     0..1 fractions to user units via simple multiplication at render time.
     vector-effect: non-scaling-stroke keeps the outline a consistent
     device-pixel width regardless of how much the SVG is scaled down.

     Phase 1B.2 — louder treatment so polygons read clearly on top of
     colored SketchUp drawings: thicker stroke, higher fill opacity, and
     an .is-active state that bumps both. The active class is toggled by
     the inline hover-sync IIFE rendered below the section, so hovering
     the matching card on the right rail also lights the polygon. */
  .pub-drawing-overlay-wrap {
    position: relative;
    display: inline-block;
    vertical-align: top;
    max-width: 100%;
    line-height: 0;
  }
  .pub-drawing-overlay-img {
    display: block;
    max-width: 100%;
    max-height: 720px;
    height: auto;
    width: auto;
    border-radius: 4px;
  }
  .pub-drawing-overlay-svg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .pub-drawing-region {
    fill: rgba(93, 126, 105, 0.22);
    stroke: var(--green);
    stroke-width: 5;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
    cursor: pointer;
    transition: fill 0.15s ease, stroke-width 0.15s ease;
  }
  .pub-drawing-region--static {
    cursor: default;
  }
  .pub-drawing-region.is-active,
  .pub-drawing-region:hover {
    fill: rgba(93, 126, 105, 0.42);
    stroke-width: 7;
  }

  /* Phase 1B.2 — two-column layout: drawing sticky on the left,
     scrollable card list on the right. Mobile collapses to single column.
     The sticky column uses position: sticky with a top offset matching
     the header height so it doesn't run under any fixed nav. align-self:
     start prevents the grid from stretching the sticky col to match the
     cards col height (which would break sticky). */
  .pub-drawing-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: 32px;
    align-items: start;
    margin-top: 8px;
  }
  .pub-drawing-sticky-col {
    position: sticky;
    top: 24px;
    align-self: start;
  }
  .pub-drawing-cards-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .pub-region-card {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  }
  .pub-region-card.is-active {
    border-color: var(--green);
    box-shadow: 0 6px 22px rgba(93, 126, 105, 0.20);
    transform: translateY(-1px);
  }
  .pub-region-card-header {
    display: block;
    padding: 18px 20px;
    text-decoration: none;
    background: var(--cream);
    border-bottom: 1px solid var(--border);
    transition: background 0.15s ease;
  }
  .pub-region-card-header:hover {
    background: var(--green-soft);
  }
  .pub-region-card-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--navy);
    letter-spacing: -0.01em;
    margin-bottom: 4px;
    line-height: 1.3;
  }
  .pub-region-card-meta {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 600;
  }
  .pub-region-card-materials {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .pub-region-card-materials--empty {
    color: var(--muted);
    font-size: 13px;
    font-style: italic;
    line-height: 1.5;
  }
  .pub-region-card-material {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .pub-region-card-thumb {
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: 6px;
    display: block;
    background: var(--cream);
    flex-shrink: 0;
  }
  .pub-region-card-thumb--placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, var(--cream), var(--green-soft));
    color: var(--green);
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.08em;
  }
  .pub-region-card-material-info {
    flex: 1;
    min-width: 0;
  }
  .pub-region-card-material-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--navy);
    line-height: 1.35;
  }
  .pub-region-card-material-sub {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
    line-height: 1.4;
  }
  .pub-region-card-cutsheet {
    display: inline-block;
    margin-top: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--green-dark);
    text-decoration: none;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .pub-region-card-cutsheet:hover {
    text-decoration: underline;
    color: var(--green);
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
    scroll-margin-top: 32px;
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

    /* Sprint 3G — mobile scope line-item layout fix.
       Previously the non-structured line items used row flex with a
       nowrap type chip, which compressed the body text into a narrow
       right strip next to a wide empty column. Stack vertically on
       mobile so chip + body each get full width and remain readable. */
    .pub-line-item {
      padding: 14px 16px;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    .pub-line-item-body {
      width: 100%;
    }
    .pub-line-item--structured {
      padding: 14px 16px;
      gap: 10px;
    }
    .pub-line-item-head {
      gap: 8px;
    }
    .pub-line-item-name {
      font-size: 15px;
      line-height: 1.35;
    }
    .pub-line-item-attrs {
      flex-direction: column;
      gap: 4px;
    }
    .pub-line-item-attr {
      font-size: 13px;
    }

    .pub-footer-ctas { padding: 64px 20px; }
    .pub-materials-group-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
  }

  /* Phase 1B.2 — collapse two-column drawing layout below 900px so the
     drawing has full width and the cards stack underneath. The 900px
     breakpoint is wider than the 640px mobile breakpoint above because
     the two-column drawing layout starts to feel cramped well before
     phone-sized viewports — tablets and narrow laptop windows are
     better served by the stacked layout. */
  @media (max-width: 900px) {
    .pub-drawing-layout {
      grid-template-columns: 1fr;
      gap: 24px;
    }
    .pub-drawing-sticky-col {
      position: static;
    }
  }

  /* ═════════ Lightbox (Sprint 3H) ═════════
     Every non-hero image on the published page opens in a full-viewport
     modal when clicked. Images are grouped by a data-gallery attribute
     (drawing / materials / photos-04 / photos-05) so the prev/next arrows
     cycle through siblings within the same gallery. The trigger is a
     transparent button wrapper — it does NOT override the inner img
     sizing, so aspect-ratio and object-fit rules from .pub-material-card
     img, .pub-photos-grid img, etc. still apply. */
  .pub-lightbox-trigger {
    display: block;
    width: 100%;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    cursor: zoom-in;
    line-height: 0;
    font: inherit;
    color: inherit;
    text-align: inherit;
  }
  .pub-lightbox {
    position: fixed;
    inset: 0;
    background: rgba(12, 14, 18, 0.92);
    z-index: 9999;
    display: none;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.18s ease;
    touch-action: pan-y;
  }
  .pub-lightbox.is-open {
    display: flex;
    opacity: 1;
  }
  .pub-lightbox-stage {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 64px 80px;
    box-sizing: border-box;
  }
  .pub-lightbox-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
    cursor: zoom-out;
  }
  .pub-lightbox-close,
  .pub-lightbox-nav {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: #fff;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
    font-family: inherit;
    padding: 0;
  }
  .pub-lightbox-close:hover,
  .pub-lightbox-nav:hover {
    background: rgba(255, 255, 255, 0.18);
  }
  .pub-lightbox-close {
    top: 20px;
    right: 20px;
    font-size: 22px;
    line-height: 1;
  }
  .pub-lightbox-nav {
    top: 50%;
    transform: translateY(-50%);
    font-size: 28px;
    line-height: 1;
  }
  .pub-lightbox-nav--prev { left: 20px; }
  .pub-lightbox-nav--next { right: 20px; }
  .pub-lightbox-nav[hidden] { display: none; }
  .pub-lightbox-counter {
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    color: rgba(255, 255, 255, 0.7);
    font-size: 13px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  @media (max-width: 640px) {
    .pub-lightbox-stage { padding: 60px 12px; }
    .pub-lightbox-close,
    .pub-lightbox-nav {
      width: 40px;
      height: 40px;
    }
    .pub-lightbox-close { top: 12px; right: 12px; font-size: 18px; }
    .pub-lightbox-nav { font-size: 22px; }
    .pub-lightbox-nav--prev { left: 8px; }
    .pub-lightbox-nav--next { right: 8px; }
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
    <p>Questions about the scope, materials, or next steps? Call or email Tim directly.</p>
    <div class="pub-cta-row">
      <a href="tel:${TIM_PHONE_HREF}" class="pub-btn pub-btn-call">
        Call Tim · ${TIM_PHONE}
      </a>
      <a href="mailto:${escapeAttr(TIM_EMAIL)}" class="pub-btn pub-btn-call">
        Email Tim · ${escapeHtml(TIM_EMAIL)}
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

  <!-- Lightbox modal (Sprint 3H) -->
  <div class="pub-lightbox" id="pubLightbox" role="dialog" aria-modal="true" aria-hidden="true">
    <div class="pub-lightbox-stage">
      <button type="button" class="pub-lightbox-nav pub-lightbox-nav--prev" id="pubLbPrev"
              aria-label="Previous image">‹</button>
      <img class="pub-lightbox-img" id="pubLbImg" src="" alt="">
      <button type="button" class="pub-lightbox-nav pub-lightbox-nav--next" id="pubLbNext"
              aria-label="Next image">›</button>
      <button type="button" class="pub-lightbox-close" id="pubLbClose"
              aria-label="Close">✕</button>
      <div class="pub-lightbox-counter" id="pubLbCounter"></div>
    </div>
  </div>

  <script>
    (function () {
      var modal    = document.getElementById('pubLightbox');
      var imgEl    = document.getElementById('pubLbImg');
      var closeEl  = document.getElementById('pubLbClose');
      var prevEl   = document.getElementById('pubLbPrev');
      var nextEl   = document.getElementById('pubLbNext');
      var counter  = document.getElementById('pubLbCounter');
      if (!modal || !imgEl) return;

      var currentList  = [];  // array of { src, alt }
      var currentIndex = 0;

      // Collect every trigger on the page and bucket by gallery so prev/next
      // cycles through images in the same section (renderings, current photos,
      // materials, drawing). Triggers with no data-gallery form a singleton.
      var triggers = Array.prototype.slice.call(
        document.querySelectorAll('.pub-lightbox-trigger')
      );
      var galleries = {};
      triggers.forEach(function (el) {
        var key = el.getAttribute('data-gallery') || ('lb-' + Math.random());
        if (!galleries[key]) galleries[key] = [];
        galleries[key].push({
          src: el.getAttribute('data-lightbox-src') || '',
          alt: el.getAttribute('data-lightbox-alt') || '',
          el:  el
        });
      });

      function openAt(list, idx) {
        currentList  = list;
        currentIndex = idx;
        update();
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
      }

      function close() {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        // Clear src after transition so we don't flash the previous image
        // if the modal reopens quickly.
        setTimeout(function () { imgEl.src = ''; }, 200);
      }

      function update() {
        var item = currentList[currentIndex];
        if (!item) return;
        imgEl.src = item.src;
        imgEl.alt = item.alt;
        var hasSiblings = currentList.length > 1;
        prevEl.hidden = !hasSiblings;
        nextEl.hidden = !hasSiblings;
        counter.textContent = hasSiblings
          ? (currentIndex + 1) + ' / ' + currentList.length
          : '';
      }

      function step(delta) {
        if (currentList.length <= 1) return;
        currentIndex = (currentIndex + delta + currentList.length) % currentList.length;
        update();
      }

      // Wire each trigger — identify which gallery it belongs to, find its
      // index, and open the lightbox positioned there.
      Object.keys(galleries).forEach(function (key) {
        var list = galleries[key];
        list.forEach(function (item, idx) {
          item.el.addEventListener('click', function (e) {
            e.preventDefault();
            openAt(list, idx);
          });
        });
      });

      // Click the backdrop (not the image itself) to close. Click the image
      // to close too — it already has cursor: zoom-out.
      modal.addEventListener('click', function (e) {
        if (e.target === modal || e.target === imgEl ||
            e.target.classList.contains('pub-lightbox-stage')) {
          close();
        }
      });
      closeEl.addEventListener('click', close);
      prevEl.addEventListener('click',  function (e) { e.stopPropagation(); step(-1); });
      nextEl.addEventListener('click',  function (e) { e.stopPropagation(); step(+1); });

      // Keyboard: Esc closes, arrows navigate.
      document.addEventListener('keydown', function (e) {
        if (!modal.classList.contains('is-open')) return;
        if (e.key === 'Escape')     close();
        else if (e.key === 'ArrowLeft')  step(-1);
        else if (e.key === 'ArrowRight') step(+1);
      });
    })();
  </script>
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

// Construction drawing featured section. Renders as its own framed block
// between the hero/Loom and the Scope of Work. Returns an empty string
// when nothing is available, so unselected proposals render unchanged.
//
// Two render paths:
//
//   • Phase 1B polygon-overlay path: when the proposal has labeled regions
//     (proposal_regions, drawn in the site-map labeling tool admin UI) AND
//     a backdrop image with stored native dimensions, render the backdrop
//     with an SVG overlay of clickable polygons. Each polygon scrolls to
//     its corresponding scope section anchor (#section-{uuid}) when
//     proposal_section_id is set; unlinked regions render as visual
//     markers only. No lightbox in this mode — the polygons are the
//     primary interaction.
//
//   • Sprint 3 Part D legacy path: when no regions exist, fall back to the
//     existing construction_drawing_url with lightbox-to-zoom. Preserved
//     byte-identical so the 40 already-published proposals continue to
//     behave exactly as before.
function buildDrawingSection(proposal, regions, materials, categoryToSection) {
  const hasRegions = Array.isArray(regions) && regions.length > 0;
  const hasBackdrop = proposal.site_plan_backdrop_url
    && proposal.site_plan_backdrop_width
    && proposal.site_plan_backdrop_height;

  if (hasRegions && hasBackdrop) {
    return renderBackdropWithRegions(proposal, regions, materials, categoryToSection);
  }

  if (!proposal.construction_drawing_url) return '';
  return `
    <section class="pub-drawing">
      <div class="pub-drawing-inner">
        <div class="pub-section-eyebrow">Construction drawing</div>
        <h2>Your project plan</h2>
        <p class="pub-section-lede">The working plan-view for your project — dimensions, material zones, and elevations captured in a single reference.</p>
        <div class="pub-drawing-frame">
          <button type="button" class="pub-lightbox-trigger pub-drawing-link"
                  data-lightbox-src="${escapeAttr(proposal.construction_drawing_url)}"
                  data-lightbox-alt="Construction drawing"
                  data-gallery="drawing"
                  aria-label="Open construction drawing full size">
            <img src="${escapeAttr(proposal.construction_drawing_url)}" alt="Construction drawing" class="pub-drawing-img">
          </button>
        </div>
        <p class="pub-drawing-caption">Click to view full size.</p>
      </div>
    </section>
  `;
}

// Phase 1B — polygon overlay renderer (Phase 1B.2 — two-column layout).
//
// Reads the backdrop's native pixel dimensions from the proposals row
// (set when the labeling tool uploads the backdrop) and uses them as
// the SVG viewBox. Polygon vertices are stored as {x, y} fractions in
// [0..1] of those native dimensions, so converting to user-space coords
// is a single multiplication per vertex.
//
// Layout (Phase 1B.2): two-column grid on desktop. Left column holds
// the drawing inside a sticky wrapper so it stays in view as the right
// column scrolls. Right column is a vertical list of region cards —
// one card per labeled region, showing the region name + the materials
// assigned to its scope section (filtered from proposal_materials by
// proposal_section_id). Hover sync between cards and polygons is wired
// up by an inline IIFE rendered at the end of the section: hover a card
// → its polygon gains the .is-active class; hover a polygon → its card
// gains .is-active too. Mobile (<= 900px) collapses to a single column
// with cards stacked below the drawing.
//
// Each polygon either wraps in <a href="#section-{uuid}"> for click-to-
// scroll (when proposal_section_id is set) or renders as a static visual
// marker (when not). Smooth scroll is enabled globally via
// `html { scroll-behavior: smooth }` in the snapshot CSS, and the
// `scroll-margin-top: 32px` rule on .pub-scope-item ensures the section
// header isn't crammed against the top of the viewport on landing.
function renderBackdropWithRegions(proposal, regions, materials, categoryToSection) {
  const W = proposal.site_plan_backdrop_width;
  const H = proposal.site_plan_backdrop_height;
  const url = proposal.site_plan_backdrop_url;

  const polygons = regions.map(r => {
    const verts = Array.isArray(r.polygon) ? r.polygon : [];
    if (verts.length < 3) return ''; // degenerate, skip

    // Convert fractional coords (0..1) to viewBox user units. One decimal
    // place is plenty of precision for an SVG up to a few thousand units
    // wide and keeps the snapshot HTML compact.
    const points = verts
      .map(v => `${(Number(v.x) * W).toFixed(1)},${(Number(v.y) * H).toFixed(1)}`)
      .join(' ');

    const labelAttr = r.name ? ` aria-label="${escapeAttr(r.name)}"` : '';
    const dataAttr = ` data-region-id="${escapeAttr(r.id)}"`;

    if (r.proposal_section_id) {
      return `<a href="#section-${escapeAttr(r.proposal_section_id)}"${labelAttr}>` +
             `<polygon class="pub-drawing-region" points="${points}"${dataAttr} />` +
             `</a>`;
    }
    return `<polygon class="pub-drawing-region pub-drawing-region--static" points="${points}"${dataAttr}${labelAttr} />`;
  }).filter(Boolean).join('');

  const anyLinked = regions.some(r => r.proposal_section_id);
  const caption = anyLinked
    ? 'Tap any highlighted area — or any card on the right — to jump to that part of the scope.'
    : 'Highlighted areas show the scope of work for this project.';

  const lede = anyLinked
    ? 'The working plan-view for your project — each highlighted area on the drawing is one part of the scope. The cards on the right show the materials assigned to each. Click any area or card to jump to its details below.'
    : 'The working plan-view for your project — highlighted areas show the scope of work for each part of the project.';

  // Cards on the right rail — one per region, in display order. Regions
  // without a linked scope section (proposal_section_id null) render no
  // card, since there's nothing to show under them; the polygon itself
  // still renders as a visual marker on the drawing.
  const cardsHtml = regions
    .map(r => renderRegionCard(r, materials, categoryToSection))
    .filter(Boolean)
    .join('');

  return `
    <section class="pub-drawing">
      <div class="pub-drawing-inner">
        <div class="pub-section-eyebrow">Construction drawing</div>
        <h2>Your project plan</h2>
        <p class="pub-section-lede">${escapeHtml(lede)}</p>
        <div class="pub-drawing-layout">
          <div class="pub-drawing-sticky-col">
            <div class="pub-drawing-frame">
              <div class="pub-drawing-overlay-wrap">
                <img src="${escapeAttr(url)}" alt="Construction drawing" class="pub-drawing-overlay-img">
                <svg class="pub-drawing-overlay-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${polygons}</svg>
              </div>
            </div>
            <p class="pub-drawing-caption">${escapeHtml(caption)}</p>
          </div>
          <div class="pub-drawing-cards-col">
            ${cardsHtml}
          </div>
        </div>
      </div>
    </section>
    <script>
      (function () {
        var cards = Array.prototype.slice.call(
          document.querySelectorAll('.pub-region-card[data-region-id]')
        );
        var polys = Array.prototype.slice.call(
          document.querySelectorAll('polygon[data-region-id]')
        );
        if (!cards.length || !polys.length) return;

        function setActive(regionId, active) {
          cards.forEach(function (c) {
            if (c.getAttribute('data-region-id') === regionId) {
              c.classList.toggle('is-active', active);
            }
          });
          polys.forEach(function (p) {
            if (p.getAttribute('data-region-id') === regionId) {
              if (active) p.classList.add('is-active');
              else p.classList.remove('is-active');
            }
          });
        }

        cards.forEach(function (card) {
          var rid = card.getAttribute('data-region-id');
          card.addEventListener('mouseenter', function () { setActive(rid, true); });
          card.addEventListener('mouseleave', function () { setActive(rid, false); });
        });

        polys.forEach(function (poly) {
          var rid = poly.getAttribute('data-region-id');
          if (!rid) return;
          poly.addEventListener('mouseenter', function () { setActive(rid, true); });
          poly.addEventListener('mouseleave', function () { setActive(rid, false); });
        });
      })();
    </script>
  `;
}

// Phase 1B.2 — render one region card on the right rail.
//
// Region without a linked scope section returns empty string (no card).
// The polygon still renders on the drawing as a visual marker, but the
// right rail only lists regions that point at scope content.
//
// Materials selection (Phase 1B.3 strategy):
//   1. PRIMARY — read from region.region_materials (the proposal_region_materials
//      join table embed). When non-empty, render those materials in their
//      stored display_order. This is what Tim curates in the labeling tool.
//   2. FALLBACK — when the join is empty (no assignments yet), fall back to
//      the Phase 1B.2 behavior: every material whose proposal_section_id
//      matches the region's section. This keeps un-labeled regions showing
//      something useful instead of "No materials assigned" noise, and
//      preserves backwards compatibility for existing proposals.
//
// extractMaterialInfo is reused so the swatch URL preference order
// (per-color swatch → primary → image_url) and the install-guide routing
// match the existing material cards in section 02.
function renderRegionCard(region, materials, categoryToSection) {
  if (!region.proposal_section_id) return '';

  // Phase 1B.3 — explicit join-table assignments take priority. Map the
  // assignments back to full proposal_materials rows so we have the
  // catalog data needed for thumbnails / names / cut-sheets.
  let cardMaterials = [];
  const assignments = Array.isArray(region.region_materials) ? region.region_materials : [];
  if (assignments.length > 0) {
    const sorted = [...assignments].sort(
      (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)
    );
    const matMap = new Map((materials || []).map(m => [m.id, m]));
    cardMaterials = sorted
      .map(a => matMap.get(a.proposal_material_id))
      .filter(Boolean);
  } else {
    // Legacy fallback — section filter. Preserved verbatim from Phase 1B.2.
    cardMaterials = (materials || [])
      .filter(m => m.proposal_section_id === region.proposal_section_id);
  }

  const sqftBadge = region.area_sqft != null && Number(region.area_sqft) > 0
    ? `${Number(region.area_sqft).toLocaleString('en-US')} sqft`
    : '';
  const lnftBadge = region.area_lnft != null && Number(region.area_lnft) > 0
    ? `${Number(region.area_lnft).toLocaleString('en-US')} lnft`
    : '';
  const meta = [sqftBadge, lnftBadge].filter(Boolean).join(' · ');

  const materialRows = cardMaterials.map(m => {
    const info = extractMaterialInfo(m, categoryToSection);

    // Pull color/pattern from the underlying catalog row when present —
    // these are the most useful disambiguators for paver products
    // (Catalina Grana Scandina Grey vs Catalina Grana Sepia).
    const subtitleParts = [];
    if (m.belgard_material) {
      if (m.belgard_material.color) subtitleParts.push(m.belgard_material.color);
      if (m.belgard_material.pattern) subtitleParts.push(m.belgard_material.pattern);
    } else if (m.third_party_material) {
      if (m.third_party_material.color) subtitleParts.push(m.third_party_material.color);
    }
    const subtitle = subtitleParts.join(' · ');

    const thumbHtml = info.imageUrl
      ? `<img src="${escapeAttr(info.imageUrl)}" alt="${escapeAttr(info.name)}" class="pub-region-card-thumb" loading="lazy">`
      : `<div class="pub-region-card-thumb pub-region-card-thumb--placeholder">${escapeHtml((info.name || 'M').slice(0, 2).toUpperCase())}</div>`;

    const cutSheetLink = info.cutSheetUrl
      ? `<a href="${escapeAttr(info.cutSheetUrl)}" target="_blank" rel="noopener" class="pub-region-card-cutsheet">Cut sheet ↗</a>`
      : '';

    return `
        <div class="pub-region-card-material">
          ${thumbHtml}
          <div class="pub-region-card-material-info">
            <div class="pub-region-card-material-name">${escapeHtml(info.name)}</div>
            ${subtitle ? `<div class="pub-region-card-material-sub">${escapeHtml(subtitle)}</div>` : ''}
            ${cutSheetLink}
          </div>
        </div>`;
  }).join('');

  const materialsBlock = materialRows
    ? `<div class="pub-region-card-materials">${materialRows}</div>`
    : `<div class="pub-region-card-materials pub-region-card-materials--empty">No materials assigned to this region yet.</div>`;

  return `
      <div class="pub-region-card" data-region-id="${escapeAttr(region.id)}">
        <a href="#section-${escapeAttr(region.proposal_section_id)}" class="pub-region-card-header">
          <div class="pub-region-card-title">${escapeHtml(region.name || 'Region')}</div>
          ${meta ? `<div class="pub-region-card-meta">${escapeHtml(meta)}</div>` : ''}
        </a>
        ${materialsBlock}
      </div>`;
}

function renderScopeSection(sections, totalAmount) {
  if (!sections.length) return '';

  const items = sections.map(s => {
    const lineItemsHtml = formatLineItemsHtml(s.line_items);
    const amount = s.total_amount != null ? formatMoney(s.total_amount) : '';
    return `
      <li class="pub-scope-item" id="section-${escapeAttr(s.id)}">
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
    ? `<button type="button" class="pub-lightbox-trigger"
              data-lightbox-src="${escapeAttr(info.imageUrl)}"
              data-lightbox-alt="${escapeAttr(info.name)}"
              data-gallery="materials"
              aria-label="Open ${escapeAttr(info.name)} full size">
         <img src="${escapeAttr(info.imageUrl)}" alt="${escapeAttr(info.name)}">
       </button>`
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

    // Sprint 3I — for Tru-Scapes, the single client-facing PDF IS the cut
    // sheet (no separate install guide document). Route it to the cut sheet
    // slot so the card renders "View cut sheet" instead of "See installation".
    // Detection reuses TRU_SCAPES_PATTERN from the install-guide router so
    // both places stay in sync.
    const resolvedUrl = resolveThirdPartyInstallUrl(tp);
    const haystack = `${tp.manufacturer || ''} ${tp.product_name || ''} ${tp.category || ''}`;
    const isTruScapes = TRU_SCAPES_PATTERN.test(haystack);

    return {
      name: tp.product_name || 'Third-party product',
      imageUrl: tp.primary_image_url
        || tp.image_url
        || '',
      cutSheetUrl: tp.cut_sheet_url || (isTruScapes ? resolvedUrl : ''),
      installGuideUrl: isTruScapes ? '' : resolvedUrl,
    };
  }
  return { name: 'Material', imageUrl: '', cutSheetUrl: '', installGuideUrl: '' };
}

// ───────────────────────────────────────────────────────────────────────────
// Third-party install guide router (Sprint 3 Part E)
//
// Maps a third_party_materials row to the most appropriate client-facing
// install/product guide PDF. Routing is pattern-based against manufacturer
// + product_name + category:
//
//   • Tru-Scapes lighting products → TRU_SCAPES_PRODUCT_GUIDE_URL
//   • Turf products (explicit turf/grass terms OR known MSI turf product
//     names — Summer Gold, Platinum Spring, Arizona Platinum)
//     → EVERGRASS_INSTALL_GUIDE_URL
//   • Anything else with installation_guide_id set → generic Bayside guide
//   • Otherwise no link (card renders without the "See installation" button,
//     same as pre-Sprint-3E behavior for unknown products)
//
// Patterns are conservative — "MSI" alone isn't enough to trigger the turf
// route since MSI also makes tile, countertops, and flooring; we require a
// known turf product line in the name. When Tim adds new MSI turf variants
// with different SKU names, add them to the TURF_SPECIFIC_PATTERN regex.
//
// Sprint 3J note — the turf patterns were split into GENERIC (plain "turf",
// "artificial grass", "synthetic grass") and SPECIFIC (brand/product names)
// so the prep-card detection logic can scan scope text safely with only the
// specific pattern. This router still uses the COMBINED TURF_PRODUCT_PATTERNS
// because a third_party_materials row is authoritative — if it's categorized
// as turf at all, route it to the Evergrass PDF.
// ───────────────────────────────────────────────────────────────────────────
const TRU_SCAPES_PATTERN = /tru-?\s*scapes?/i;

// Split from the original single TURF_PRODUCT_PATTERNS in Sprint 3J so that
// prep-card scope scanning doesn't false-positive on demolition language.
//
// GENERIC — the word "turf" and its synonyms. These show up in too many
// non-install contexts to scan scope text with: demolition ("remove existing
// turf"), sod installation ("sod/lawn"), site descriptions, etc. These only
// trigger the turf prep card when they appear on a third_party_materials row.
const TURF_GENERIC_PATTERN = /\b(turf|artificial\s+grass|synthetic\s+grass)\b/i;

// SPECIFIC — product/brand names that only appear in proposals where that
// product is actually being installed. Safe to match in scope line items
// even when the product hasn't been catalogued as a material yet.
const TURF_SPECIFIC_PATTERN = /\b(evergrass|summer\s+gold|platinum\s+spring|arizona\s+platinum)\b/i;

// Combined pattern — used by resolveThirdPartyInstallUrl and the
// materials-list branch of proposalHasTurf, where any turf signal on an
// explicit third_party_materials row is authoritative.
const TURF_PRODUCT_PATTERNS = new RegExp(
  TURF_GENERIC_PATTERN.source + '|' + TURF_SPECIFIC_PATTERN.source,
  'i'
);

function resolveThirdPartyInstallUrl(tp) {
  const haystack = `${tp.manufacturer || ''} ${tp.product_name || ''} ${tp.category || ''}`;

  if (TRU_SCAPES_PATTERN.test(haystack)) {
    return TRU_SCAPES_PRODUCT_GUIDE_URL;
  }
  if (TURF_PRODUCT_PATTERNS.test(haystack)) {
    return EVERGRASS_INSTALL_GUIDE_URL;
  }
  if (tp.installation_guide_id) {
    return INSTALL_GUIDE_URL;
  }
  return '';
}

// ───────────────────────────────────────────────────────────────────────────
// "Why our preparation matters" section
//
// Sprint 2 Part B.2: dynamic rendering from installation_guide_sections for
// Belgard-category materials.
// Sprint 3 Part C: extended to also render non-Belgard cards (turf,
// Tru-Scapes lighting) via pattern match against scope text + third-party
// materials. See renderThirdPartyPrepCards.
// Sprint 3 Part J: tightened turf scope-text detection to specific product
// names only, so "remove existing turf" demolition lines and sod/lawn
// references no longer trigger the turf card. Tru-Scapes detection is
// unchanged because "Tru-Scapes"/"TruScape" is unambiguous.
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
//   • proposal_sections.line_items — where scope-line notes live for products
//     that haven't been catalogued as materials yet. Sprint 3J narrowed the
//     turf scan here to TURF_SPECIFIC_PATTERN only, avoiding false positives
//     from demolition language. Tru-Scapes scan remains unchanged — the
//     brand name is specific enough to never false-match.
//   • proposal_materials (third-party rows) — for structured product picks.
//     Uses the combined TURF_PRODUCT_PATTERNS here since a third_party_materials
//     row that mentions turf at all is authoritatively a turf product.
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

// Sprint 3J — turf detection refactored to prevent false positives from
// demolition language ("remove existing turf") and sod/lawn references.
//
// Scope scan uses TURF_SPECIFIC_PATTERN only (brand/product names). The
// generic word "turf" is no longer enough to trigger the prep card from
// scope text. Materials-list scan still uses the combined pattern — a
// third_party_materials row with turf signal is explicit product data,
// not prose, so any match is authoritative.
function proposalHasTurf(sections, materials) {
  // Scope-text scan: ONLY match on specific product names. Demolition lines
  // like "Remove and dispose of existing turf/flagstone/tile material" and
  // grass/sod scope items must not trigger the prep card.
  if (scopeContains(sections, TURF_SPECIFIC_PATTERN)) return true;

  // Materials-list scan: combined pattern. If Tim added a turf product as
  // a third_party material, whether by specific name or generic category,
  // render the turf prep card.
  for (const m of materials || []) {
    if (m.material_source !== 'third_party') continue;
    const tp = m.third_party_material;
    if (!tp) continue;
    const hay = `${tp.manufacturer || ''} ${tp.product_name || ''} ${tp.category || ''}`;
    if (TURF_PRODUCT_PATTERNS.test(hay)) return true;
  }
  return false;
}

function proposalHasTruScapesLighting(sections, materials) {
  if (scopeContains(sections, TRU_SCAPES_PATTERN)) return true;
  for (const m of materials || []) {
    if (m.material_source !== 'third_party') continue;
    const tp = m.third_party_material;
    if (!tp) continue;
    const hay = `${tp.manufacturer || ''} ${tp.product_name || ''}`;
    if (TRU_SCAPES_PATTERN.test(hay)) return true;
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

  // Sprint 3G — partition on display_section (user-controlled classifier).
  //
  // display_section is set per-image in Section 05 of the BPB editor and
  // is migrated from extraction_source by 015_display_section.sql. For
  // rows that somehow still have null display_section (pre-migration,
  // constraint edge case, or RLS block on UPDATE during backfill), fall
  // back to the old extraction_source heuristic so nothing ever goes
  // missing silently.
  const classify = (p) => {
    if (p.display_section === 'hidden') return 'hidden';
    if (p.display_section === 'current_photo') return 'current';
    if (p.display_section === 'design_rendering') return 'rendering';
    // Fallback for unmigrated rows — mirrors Sprint 3F behavior.
    if (p.extraction_source === 'manual_upload') return 'current';
    if (p.extraction_source === 'bid_pdf_extract') return 'rendering';
    return 'hidden';
  };

  const currentPhotos = photos.filter(p => classify(p) === 'current');
  const renderings    = photos.filter(p => classify(p) === 'rendering');

  const currentHtml = renderPhotosBlock(
    currentPhotos,
    '04',
    'Current site conditions',
    'Photos of the property as it exists today.'
  );
  const renderingsHtml = renderPhotosBlock(
    renderings,
    '05',
    'Design renderings',
    'How your completed project will look — 3D renderings generated from the design plan.'
  );

  return currentHtml + renderingsHtml;
}

function renderPhotosBlock(photos, number, heading, lede) {
  if (!photos.length) return '';

  // Sprint 3H — lightbox galleries. Use the section number as the gallery
  // key so prev/next arrows cycle through images in the same section
  // (04 = current photos, 05 = design renderings) and don't mix the two.
  const gallery = 'photos-' + number;

  const groups = groupPhotosByLocation(photos);
  const groupsHtml = Object.entries(groups).map(([label, items]) => {
    const imgs = items.map(p => {
      const url = storagePublicUrl(p.storage_path);
      if (!url) return '';
      const altText = p.original_filename || heading;
      return `<button type="button" class="pub-lightbox-trigger"
                data-lightbox-src="${escapeAttr(url)}"
                data-lightbox-alt="${escapeAttr(altText)}"
                data-gallery="${escapeAttr(gallery)}"
                aria-label="Open ${escapeAttr(altText)} full size">
                <img src="${escapeAttr(url)}" alt="${escapeAttr(altText)}" loading="lazy">
              </button>`;
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
      <div class="pub-section-eyebrow">${escapeHtml(number)}</div>
      <h2>${escapeHtml(heading)}</h2>
      <p class="pub-section-lede">${escapeHtml(lede)}</p>
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
