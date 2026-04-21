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
// Preserved from Sprint 1 / Sprint 1.5:
//   • Hero picker grid (bid-PDF-extracted + manually uploaded images)
//   • Hero banner at top of published page
//   • Materials grouped by application_area with 4:3 aspect cards
//   • Cut sheet + install guide action buttons on each card
//   • Publish / slug / history infrastructure
//   • Section order: header → hero → loom → 01 scope → 02 materials
//     → 03 why prep → 04 photos → footer CTAs
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

// Bayside-branded installation guide PDF — remains the bottom footer CTA.
// This is the client-facing "Here's how we install" document.
const INSTALL_GUIDE_URL = 'https://cdn.prod.website-files.com/67c10dbe66a9f7b9cf3c6e47/68d2db027d1d1b4ad1543f05_Bayside%20Pavers%20Presentation%20(1)_compressed%20(1).pdf';

// Belgard master Product Installation Guide — the 110+ page PDF we parsed
// in Sprint 2 Part B.1. Used for page-anchored deep links per section since
// its pagination is what installation_guide_sections.page_start references.
const BELGARD_MASTER_INSTALL_GUIDE_URL = 'https://www.belgard.com/wp-content/uploads/2025/05/Product-Installation-Guide_WEB_BEL24-D-298050.pdf';

const BAYSIDE_LOGO_URL = 'https://cdn.prod.website-files.com/65a1ca4354f63bd7376b5027/69a04f4369bc9cc20b8d2155_BaysidePavers_original%20(2)%20(1).png';
const TIM_PHONE = '408-313-1301';
const TIM_PHONE_HREF = '+14083131301';
const BUCKET = 'proposal-photos';

let proposalId = null;
let container = null;
let onSaveCb = null;
let currentData = null; // { proposal, sections, materials, photos, heroCandidates, history, installSections, categoryToSection }

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
  const [proposalQ, sectionsQ, materialsQ, photosQ, heroCandidatesQ, historyQ] = await Promise.all([
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
    supabase.from('published_proposals').select('id, slug, title, published_at')
      .eq('proposal_id', proposalId).order('published_at', { ascending: false }),
  ]);

  const err = proposalQ.error || sectionsQ.error || materialsQ.error
    || photosQ.error || heroCandidatesQ.error || historyQ.error;
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

  const scopeHtml = renderScopeSection(sections, proposal.bid_total_amount);
  const materialsHtml = renderMaterialsSection(materials, categoryToSection);
  const whyPrepHtml = renderWhyPrepSection(installSections);
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
  .pub-scope-item-name {
    font-size: 19px;
    font-weight: 600;
    margin-bottom: 10px;
    color: var(--navy);
  }
  .pub-scope-item-detail {
    color: var(--muted);
    font-size: 15px;
    line-height: 1.7;
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
    .pub-loom { padding: 0 20px; margin-top: 48px; }
    .pub-scope-item { grid-template-columns: 1fr; gap: 12px; }
    .pub-scope-item-amount { font-size: 18px; }
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

function renderScopeSection(sections, totalAmount) {
  if (!sections.length) return '';

  const items = sections.map(s => {
    const lineItemsText = formatLineItems(s.line_items);
    const amount = s.total_amount != null ? formatMoney(s.total_amount) : '';
    return `
      <li class="pub-scope-item">
        <div>
          <div class="pub-scope-item-name">${escapeHtml(s.name || 'Untitled section')}</div>
          ${lineItemsText ? `<div class="pub-scope-item-detail">${escapeHtml(lineItemsText)}</div>` : ''}
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
      <p class="pub-section-lede">The complete breakdown of everything included in your project.</p>
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
// Sprint 2 Part B.2: dynamic rendering from installation_guide_sections.
// Falls back to the hardcoded 4-card version when no sections apply (keeps
// proposals with uncategorized materials from rendering an empty section).
// ───────────────────────────────────────────────────────────────────────────
function renderWhyPrepSection(installSections) {
  const hasSections = Array.isArray(installSections) && installSections.length > 0;
  const cardsHtml = hasSections
    ? renderDynamicPrepCards(installSections)
    : renderHardcodedPrepCards();

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
