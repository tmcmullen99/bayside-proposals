// ═══════════════════════════════════════════════════════════════════════════
// /p-customize.js — Phase 4.1 Sprint B1.5
//
// Universal site-plan layout transformer. Runs on every /p/{slug} page
// regardless of auth state — this is a pure UX improvement, not a
// customization feature.
//
// Restructures the existing single-column "site map → legend → materials
// grid" into a Condo-Market-style two-column layout:
//
//   ┌──────────────────────────┬────────────────────┐
//   │                          │  YOUR PROJECT      │
//   │   [interactive site      │  3 sections, 4     │
//   │    plan SVG with         │  materials         │
//   │    polygons]             │                    │
//   │                          │  • Pavers …      → │
//   │                          │  • Front Path …  → │
//   │                          │  • Pergola …     → │
//   └──────────────────────────┴────────────────────┘
//   [legend strip stays below as compact reference]
//   [original materials grid: hidden, data extracted to right card]
//
// Click a polygon (or a row in the right card):
//   1. Right card swaps to that region's detail (materials in that section)
//   2. Page scrolls to the matching bid section (existing anchor behavior;
//      Tim explicitly wanted to keep that pairing)
//
// "← Overview" link on region detail returns to the project summary.
//
// Replaces the Sprint B1 banner+side-panel approach which was the wrong
// shape. Sprint B2 will layer swap UI onto the right card for signed-in
// homeowners.
//
// CSS prefix: .bpc-  (Bayside Pavers Customize)
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── Helpers ─────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─── Data extraction from existing snapshot DOM ──────────────────────
  // We don't fetch from API — everything we need is already in the
  // pub-region-legend rows (region info) and pub-material-card elements
  // (material→region mapping via data-region-ids). Pure DOM read, no network.
  function extractRegions() {
    const regions = [];
    document.querySelectorAll('.pub-region-legend-row').forEach((row) => {
      const id = row.getAttribute('data-region-id');
      if (!id) return;
      const dot = row.querySelector('.pub-region-legend-dot');
      const color = (dot && dot.style && dot.style.background) || '#5d7e69';
      const nameEl = row.querySelector('.pub-region-legend-name');
      const metaEl = row.querySelector('.pub-region-legend-meta');
      regions.push({
        id,
        name: (nameEl ? nameEl.textContent : '').trim(),
        meta: (metaEl ? metaEl.textContent : '').trim(),
        color,
        sectionHref: row.getAttribute('href') || '',
      });
    });
    return regions;
  }

  function extractRegionMaterials(materialsGrid) {
    const map = new Map();  // region_uuid → [material, ...]
    materialsGrid.querySelectorAll('.pub-material-card').forEach((card) => {
      const regionIdsAttr = card.getAttribute('data-region-ids') || '';
      const regionIds = regionIdsAttr.split(',').map(s => s.trim()).filter(Boolean);
      if (regionIds.length === 0) return;

      const img = card.querySelector('img');
      const typeEl = card.querySelector('.pub-material-card-type');
      const nameEl = card.querySelector('.pub-material-card-name');
      const colorEl = card.querySelector('.pub-material-card-color');

      const material = {
        type:  ((typeEl  ? typeEl.textContent  : '') || '').trim(),
        name:  ((nameEl  ? nameEl.textContent  : '') || '').trim(),
        color: ((colorEl ? colorEl.textContent : '') || '').trim(),
        imgSrc: img ? img.getAttribute('src') : '',
      };
      regionIds.forEach((rid) => {
        if (!map.has(rid)) map.set(rid, []);
        map.get(rid).push(material);
      });
    });
    return map;
  }

  // ─── Styles ──────────────────────────────────────────────────────────
  const STYLES = `
    .bpc-twocol {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(300px, 380px);
      gap: 28px;
      align-items: start;
      margin: 12px 0 24px;
    }
    @media (max-width: 900px) {
      .bpc-twocol { grid-template-columns: 1fr; gap: 20px; }
      .bpc-detail-card { position: static !important; }
    }
    .bpc-twocol-left, .bpc-twocol-right { min-width: 0; }

    .bpc-detail-card {
      position: sticky;
      top: 16px;
      background: #ffffff;
      border: 1px solid #e7e3d6;
      border-radius: 10px;
      padding: 22px 22px 16px;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 1px 3px rgba(53, 53, 53, 0.04);
      max-height: calc(100vh - 32px);
      overflow-y: auto;
    }

    .bpc-card-eyebrow {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.14em;
      color: #5d7e69;
      text-transform: uppercase;
      margin: 0 0 6px;
    }
    .bpc-card-title {
      font-size: 21px;
      font-weight: 700;
      color: #353535;
      line-height: 1.2;
      margin: 0 0 4px;
    }
    .bpc-card-meta {
      font-size: 13px;
      color: #777;
      margin: 0 0 16px;
    }
    .bpc-card-prompt {
      font-size: 13px;
      color: #58595b;
      line-height: 1.5;
      margin: 8px 0 14px;
    }

    .bpc-card-back {
      background: transparent;
      border: none;
      color: #5d7e69;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      cursor: pointer;
      padding: 0;
      margin: 0 0 12px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .bpc-card-back:hover { color: #4a6554; }

    .bpc-overview-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .bpc-overview-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      text-decoration: none;
      color: inherit;
      cursor: pointer;
      border: 1px solid #efece4;
      transition: background 0.15s, border-color 0.15s;
    }
    .bpc-overview-row:hover {
      background: #faf8f3;
      border-color: #d8d2bf;
    }
    .bpc-overview-dot {
      width: 12px; height: 12px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .bpc-overview-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .bpc-overview-name {
      font-weight: 600;
      font-size: 14px;
      color: #353535;
      line-height: 1.2;
    }
    .bpc-overview-meta {
      font-size: 12px;
      color: #888;
      margin-top: 2px;
    }
    .bpc-overview-arrow {
      color: #aaa;
      font-size: 14px;
      flex-shrink: 0;
    }

    .bpc-detail-mats {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 14px 0;
    }
    .bpc-detail-mat {
      display: flex;
      gap: 12px;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid #efece4;
      background: #fdfcf8;
    }
    .bpc-detail-mat-thumb {
      width: 56px; height: 56px;
      object-fit: cover;
      border-radius: 6px;
      flex-shrink: 0;
      background: #f4f1e8;
      border: 1px solid #eae6d6;
    }
    .bpc-detail-mat-body { flex: 1; min-width: 0; }
    .bpc-detail-mat-type {
      font-size: 10px;
      letter-spacing: 0.1em;
      font-weight: 700;
      color: #999;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .bpc-detail-mat-name {
      font-weight: 600;
      font-size: 14px;
      color: #353535;
      line-height: 1.2;
    }
    .bpc-detail-mat-color {
      font-size: 12px;
      color: #777;
      margin-top: 2px;
    }
    .bpc-detail-empty {
      padding: 16px 0;
      font-size: 13px;
      color: #999;
      text-align: center;
    }

    .bpc-card-section-link {
      display: block;
      text-align: center;
      padding: 12px 0 4px;
      margin-top: 8px;
      font-size: 13px;
      font-weight: 600;
      color: #5d7e69;
      text-decoration: none;
      border-top: 1px solid #efece4;
      letter-spacing: 0.02em;
    }
    .bpc-card-section-link:hover { color: #4a6554; }

    /* Hide the original materials grid section — its data is now in the
       sticky card. Keep the markup in DOM (display:none) so any other code
       reading it still works. */
    .pub-site-plan-materials.bpc-hidden { display: none !important; }

    /* Tighten the legend strip's top spacing now that the materials section
       below it is hidden. */
    .pub-region-legend.bpc-tight {
      margin-top: 4px !important;
      padding-top: 16px !important;
    }
  `;

  function injectStyles() {
    if (document.getElementById('bpc-twocol-styles')) return;
    const el = document.createElement('style');
    el.id = 'bpc-twocol-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  // ─── Render ──────────────────────────────────────────────────────────
  function renderOverview(card, regions, regionMap) {
    const matNames = new Set();
    regions.forEach(r => (regionMap.get(r.id) || []).forEach(m => matNames.add(m.name)));

    card.innerHTML = `
      <div class="bpc-card-eyebrow">Your project</div>
      <div class="bpc-card-title">${regions.length} section${regions.length === 1 ? '' : 's'}, ${matNames.size} material${matNames.size === 1 ? '' : 's'}</div>
      <p class="bpc-card-prompt">Tap any highlighted area on the plan to see what's planned for that section, or pick from the list below.</p>
      <div class="bpc-overview-list">
        ${regions.map(r => `
          <a class="bpc-overview-row" data-region-id="${escapeHtml(r.id)}" href="${escapeHtml(r.sectionHref)}">
            <span class="bpc-overview-dot" style="background:${escapeHtml(r.color)};"></span>
            <span class="bpc-overview-text">
              <span class="bpc-overview-name">${escapeHtml(r.name)}</span>
              ${r.meta ? `<span class="bpc-overview-meta">${escapeHtml(r.meta)}</span>` : ''}
            </span>
            <span class="bpc-overview-arrow">→</span>
          </a>
        `).join('')}
      </div>
    `;
    card.querySelectorAll('.bpc-overview-row').forEach((row) => {
      row.addEventListener('click', () => {
        // Don't preventDefault — let the anchor scroll to the bid section.
        // Just update the card to show that region's detail.
        const rid = row.getAttribute('data-region-id');
        renderRegionDetail(card, rid, regions, regionMap);
      });
    });
  }

  function renderRegionDetail(card, regionId, regions, regionMap) {
    const region = regions.find(r => r.id === regionId);
    if (!region) return;
    const mats = regionMap.get(regionId) || [];

    card.innerHTML = `
      <button type="button" class="bpc-card-back">← Overview</button>
      <div class="bpc-card-eyebrow" style="color:${escapeHtml(region.color)};">Section</div>
      <div class="bpc-card-title">${escapeHtml(region.name)}</div>
      ${region.meta ? `<div class="bpc-card-meta">${escapeHtml(region.meta)}</div>` : ''}
      <div class="bpc-detail-mats">
        ${mats.length === 0
          ? `<div class="bpc-detail-empty">No customizable materials assigned to this section yet.</div>`
          : mats.map(m => `
              <div class="bpc-detail-mat">
                ${m.imgSrc
                  ? `<img class="bpc-detail-mat-thumb" src="${escapeHtml(m.imgSrc)}" alt="">`
                  : `<div class="bpc-detail-mat-thumb"></div>`}
                <div class="bpc-detail-mat-body">
                  ${m.type  ? `<div class="bpc-detail-mat-type">${escapeHtml(m.type)}</div>`   : ''}
                  <div class="bpc-detail-mat-name">${escapeHtml(m.name)}</div>
                  ${m.color ? `<div class="bpc-detail-mat-color">${escapeHtml(m.color)}</div>` : ''}
                </div>
              </div>
            `).join('')}
      </div>
      <a class="bpc-card-section-link" href="${escapeHtml(region.sectionHref)}">View scope details →</a>
    `;
    card.querySelector('.bpc-card-back').addEventListener('click', () => {
      renderOverview(card, regions, regionMap);
    });
  }

  // ─── Layout transform ────────────────────────────────────────────────
  function transformLayout(inner, siteMapEl, legendEl, regions, regionMap) {
    const twocol = document.createElement('div');
    twocol.className = 'bpc-twocol';

    const left  = document.createElement('div'); left.className  = 'bpc-twocol-left';
    const right = document.createElement('div'); right.className = 'bpc-twocol-right';
    twocol.appendChild(left);
    twocol.appendChild(right);

    // Move the site map element into the left column (preserves all its
    // event listeners and inner structure).
    left.appendChild(siteMapEl);

    // Right column gets the sticky detail card
    const card = document.createElement('div');
    card.className = 'bpc-detail-card';
    right.appendChild(card);

    // Insert the two-column container where the site map used to be.
    // Legend strip and (hidden) materials section stay below.
    if (legendEl && legendEl.parentNode === inner) {
      inner.insertBefore(twocol, legendEl);
      legendEl.classList.add('bpc-tight');
    } else {
      inner.appendChild(twocol);
    }

    // Hide the now-redundant full materials grid (its data is in the card).
    const materialsSection = inner.querySelector('.pub-site-plan-materials');
    if (materialsSection) materialsSection.classList.add('bpc-hidden');

    // Default state
    renderOverview(card, regions, regionMap);

    // Polygon click: update card to that region's detail. Don't
    // preventDefault — the existing <a href="#section-..."> wrapping each
    // polygon should still scroll the page to the bid section. Tim
    // explicitly wanted to preserve that pairing.
    document.querySelectorAll('polygon.pub-drawing-region:not(.pub-drawing-region--static)').forEach((poly) => {
      const regionId = poly.getAttribute('data-region-id');
      const anchor = poly.closest('a');
      if (!anchor || !regionId) return;
      anchor.addEventListener('click', () => {
        renderRegionDetail(card, regionId, regions, regionMap);
      });
    });

    // Legend row click: same behavior (these are also <a> with section href).
    document.querySelectorAll('.pub-region-legend-row').forEach((row) => {
      const regionId = row.getAttribute('data-region-id');
      if (!regionId) return;
      row.addEventListener('click', () => {
        renderRegionDetail(card, regionId, regions, regionMap);
      });
    });
  }

  // ─── Boot ────────────────────────────────────────────────────────────
  function init() {
    const inner = document.querySelector('.pub-drawing-inner');
    if (!inner) return;
    const siteMapEl = inner.querySelector('.pub-site-plan-map');
    if (!siteMapEl) return;
    const materialsGrid = inner.querySelector('.pub-materials-grid');
    if (!materialsGrid) return;
    const legendEl = inner.querySelector('.pub-region-legend');

    const regions = extractRegions();
    if (regions.length === 0) return;
    const regionMap = extractRegionMaterials(materialsGrid);

    injectStyles();
    transformLayout(inner, siteMapEl, legendEl, regions, regionMap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
