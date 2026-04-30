// ═══════════════════════════════════════════════════════════════════════════
// /p-customize.js — Phase 4.1 Sprint B2 (revision 4)
//
// B2-r4: Two-pane bid section reader (Tim's design choice C).
// Transforms .pub-scope-list into a two-pane reader. Section IDs preserved
// so polygon anchors still work. PDF extraction unaffected.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const API_DATA = '/api/proposal-customize-data';
  const API_SUBMIT = '/api/submit-substitutions';

  const customize = {
    enabled: false,
    data: null,
    pending: new Map(),
    submitted: false,
  };

  // Module-level handle to the bid reader so polygon and section-bid
  // button handlers can call .select(id).
  let _bidReader = null;

  function getAuthToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
          const v = localStorage.getItem(k);
          if (!v) continue;
          const parsed = JSON.parse(v);
          if (parsed && parsed.access_token) return parsed.access_token;
        }
      }
    } catch (e) {}
    return null;
  }

  function getSlugFromPath() {
    const m = window.location.pathname.match(/^\/p\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function scrollToHref(href) {
    if (!href || href.charAt(0) !== '#') return false;
    const target = document.querySelector(href);
    if (!target) return false;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  // Try to select a section in the two-pane reader; fall back to scrolling.
  function navigateToSection(href) {
    if (!href || href.charAt(0) !== '#') return;
    const id = href.slice(1);
    if (_bidReader && _bidReader.select(id)) {
      const readerEl = _bidReader.root;
      const rect = readerEl.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.5 || rect.bottom < 0) {
        readerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    scrollToHref(href);
  }

  function normalizeMatch(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\u2014\u2013\u2018\u2019]/g, '').trim();
  }
  function findApiMaterial(regionId, domMaterial) {
    if (!customize.enabled || !customize.data) return null;
    const candidates = customize.data.region_materials.filter((rm) => rm.region_id === regionId);
    const targetName = normalizeMatch(domMaterial.name);
    const targetColor = normalizeMatch(domMaterial.color);
    return candidates.find((rm) => {
      const apiName = normalizeMatch(rm.current.product_name);
      const apiColor = normalizeMatch(rm.current.color);
      return apiName === targetName && (targetColor ? apiColor === targetColor : true);
    }) || null;
  }

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
    const map = new Map();
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
      display: flex;
      flex-direction: column;
    }
    .bpc-detail-card-body { flex: 1; }

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
      cursor: pointer;
      border: 1px solid #efece4;
      background: #fff;
      font-family: inherit;
      font-size: inherit;
      color: inherit;
      width: 100%;
      text-align: left;
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
    .bpc-overview-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
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
    .bpc-overview-arrow { color: #aaa; font-size: 14px; flex-shrink: 0; }

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
      align-items: center;
    }
    .bpc-detail-mat--pending {
      border-color: #5d7e69;
      background: #f0f4f1;
      border-width: 2px;
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
    .bpc-detail-mat-pending-arrow {
      color: #5d7e69;
      font-size: 12px;
      font-weight: 700;
      margin-top: 4px;
    }
    .bpc-detail-mat-pending-name {
      font-weight: 700;
      font-size: 13px;
      color: #5d7e69;
      line-height: 1.2;
    }
    .bpc-detail-mat-actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex-shrink: 0;
    }
    .bpc-swap-btn {
      background: #5d7e69;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .bpc-swap-btn:hover { background: #4a6554; }
    .bpc-swap-btn--undo {
      background: transparent;
      color: #5d7e69;
      border: 1px solid #5d7e69;
      font-size: 11px;
      padding: 4px 10px;
    }
    .bpc-swap-btn--undo:hover { background: #f0f4f1; }

    .bpc-detail-empty {
      padding: 16px 0;
      font-size: 13px;
      color: #999;
      text-align: center;
    }

    .bpc-card-section-link {
      display: block;
      text-align: center;
      width: 100%;
      padding: 12px 16px;
      margin-top: 14px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      color: #5d7e69;
      background: #fff;
      border: 1.5px solid #5d7e69;
      border-radius: 6px;
      cursor: pointer;
      letter-spacing: 0.02em;
      transition: background 0.15s, color 0.15s;
    }
    .bpc-card-section-link:hover { background: #5d7e69; color: #fff; }

    .bpc-tray {
      flex-shrink: 0;
      margin: 16px -22px -16px;
      padding: 14px 22px;
      background: #f4f4ef;
      border-top: 1px solid #e7e3d6;
      border-radius: 0 0 10px 10px;
    }
    .bpc-tray-count {
      font-size: 12px;
      font-weight: 600;
      color: #5d7e69;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    .bpc-tray-cta {
      width: 100%;
      background: #5d7e69;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 12px 16px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .bpc-tray-cta:hover { background: #4a6554; }
    .bpc-tray-cta:disabled { background: #a8b5ac; cursor: not-allowed; }

    .bpc-modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(53, 53, 53, 0.4);
      display: flex; align-items: center; justify-content: center;
      z-index: 2000;
      animation: bpcFadeIn 0.18s ease;
    }
    @keyframes bpcFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .bpc-modal {
      background: #fff;
      border-radius: 12px;
      width: 540px; max-width: 92vw;
      max-height: 88vh;
      display: flex; flex-direction: column;
      overflow: hidden;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      animation: bpcModalIn 0.22s ease;
    }
    @keyframes bpcModalIn { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .bpc-modal-header {
      padding: 20px 24px;
      border-bottom: 1px solid #efece4;
      display: flex; align-items: center; justify-content: space-between;
    }
    .bpc-modal-title { margin: 0; font-size: 18px; font-weight: 700; color: #353535; }
    .bpc-modal-close {
      background: transparent; border: none; cursor: pointer;
      width: 28px; height: 28px;
      font-size: 20px; color: #888;
      border-radius: 4px;
    }
    .bpc-modal-close:hover { background: #f4f4ef; color: #353535; }
    .bpc-modal-body { padding: 20px 24px; overflow-y: auto; flex: 1; }
    .bpc-modal-footer {
      padding: 14px 24px;
      border-top: 1px solid #efece4;
      background: #faf8f3;
      display: flex; justify-content: flex-end; gap: 10px;
    }

    .bpc-cand-current {
      background: #fdfcf8;
      border: 1px solid #efece4;
      border-radius: 8px;
      padding: 12px;
      display: flex; gap: 12px; align-items: center;
      margin-bottom: 18px;
    }
    .bpc-cand-current-thumb {
      width: 50px; height: 50px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
      background: #f4f1e8; border: 1px solid #eae6d6;
    }
    .bpc-cand-current-text { flex: 1; min-width: 0; }
    .bpc-cand-current-label {
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      color: #999; font-weight: 700; margin-bottom: 2px;
    }
    .bpc-cand-current-name { font-size: 14px; font-weight: 600; color: #353535; }
    .bpc-cand-current-color { font-size: 12px; color: #777; }

    .bpc-cand-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 10px;
    }
    .bpc-cand {
      border: 1.5px solid #efece4;
      border-radius: 8px;
      padding: 8px;
      cursor: pointer;
      background: #fff;
      text-align: left;
      font-family: inherit;
      transition: border-color 0.15s, transform 0.05s;
    }
    .bpc-cand:hover { border-color: #5d7e69; transform: translateY(-1px); }
    .bpc-cand--selected { border-color: #5d7e69; background: #f0f4f1; }
    .bpc-cand--current { opacity: 0.4; pointer-events: none; }
    .bpc-cand-thumb {
      width: 100%; aspect-ratio: 1;
      object-fit: cover;
      border-radius: 4px;
      background: #f4f1e8;
      margin-bottom: 6px;
    }
    .bpc-cand-thumb-empty {
      width: 100%; aspect-ratio: 1;
      background: linear-gradient(135deg, #f4f1e8, #eae6d6);
      border-radius: 4px;
      margin-bottom: 6px;
    }
    .bpc-cand-name {
      font-size: 12px; font-weight: 600; color: #353535;
      line-height: 1.2;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .bpc-cand-color { font-size: 11px; color: #888; margin-top: 2px; }
    .bpc-cand-current-pill {
      display: inline-block;
      background: #5d7e69; color: #fff;
      font-size: 9px; font-weight: 700;
      padding: 2px 6px; border-radius: 8px;
      letter-spacing: 0.05em;
      margin-top: 4px;
    }

    .bpc-modal-textarea {
      width: 100%;
      padding: 12px;
      border: 1px solid #d4d0c2;
      border-radius: 6px;
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
      min-height: 80px;
      box-sizing: border-box;
    }
    .bpc-modal-textarea:focus {
      outline: none;
      border-color: #5d7e69;
      box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.16);
    }

    .bpc-btn {
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 20px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      transition: background 0.15s;
    }
    .bpc-btn--primary { background: #5d7e69; color: #fff; }
    .bpc-btn--primary:hover { background: #4a6554; }
    .bpc-btn--primary:disabled { background: #a8b5ac; cursor: not-allowed; }
    .bpc-btn--ghost { background: transparent; color: #353535; border: 1px solid #d4d0c2; }
    .bpc-btn--ghost:hover { background: #f4f4ef; }

    .bpc-summary-list {
      list-style: none;
      padding: 0;
      margin: 0 0 16px;
    }
    .bpc-summary-item {
      padding: 10px 0;
      border-bottom: 1px solid #efece4;
      font-size: 13px;
      color: #353535;
      line-height: 1.5;
    }
    .bpc-summary-item:last-child { border-bottom: none; }
    .bpc-summary-region {
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      color: #5d7e69; font-weight: 700; margin-bottom: 2px;
    }
    .bpc-summary-from { color: #999; text-decoration: line-through; }
    .bpc-summary-arrow { color: #5d7e69; margin: 0 6px; }

    .bpc-success {
      text-align: center;
      padding: 24px 12px;
    }
    .bpc-success-icon {
      width: 48px; height: 48px;
      border-radius: 50%;
      background: #5d7e69;
      color: #fff;
      font-size: 24px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 12px;
    }
    .bpc-success h3 { margin: 0 0 6px; font-size: 18px; color: #353535; }
    .bpc-success p { margin: 0 0 18px; color: #58595b; font-size: 13px; line-height: 1.5; }

    .pub-site-plan-materials.bpc-hidden { display: none !important; }
    .pub-region-legend.bpc-tight {
      margin-top: 4px !important;
      padding-top: 16px !important;
    }

    /* Bid section polish (kept from B2-r3) */
    body .pub-scope-item {
      padding: 36px 0;
    }
    body .pub-scope-item:first-child {
      padding-top: 4px;
    }
    body .pub-scope-item-header {
      margin-bottom: 16px;
    }
    body .pub-scope-item-name {
      font-size: 22px;
      letter-spacing: -0.012em;
    }
    body .pub-scope-item-amount {
      font-size: 19px;
    }
    body .pub-line-item {
      padding: 12px 0;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 10px;
    }
    body .pub-line-item:first-child {
      padding-top: 2px;
    }
    body .pub-line-item-type {
      display: inline-block;
      flex-shrink: 0;
      margin-bottom: 0;
      padding: 2px 8px;
      background: #e8eee9;
      color: #4a6554;
      font-size: 9.5px;
      letter-spacing: 0.16em;
      border-radius: 3px;
      font-weight: 700;
      line-height: 1.5;
      align-self: center;
    }
    body .pub-line-item-body {
      flex: 1;
      min-width: 200px;
      font-size: 14.5px;
      line-height: 1.5;
      max-width: 78ch;
    }
    body .pub-scope-total {
      margin-top: 8px;
      padding: 28px 0 12px;
    }
    body .pub-scope-total-amount {
      font-size: 28px;
    }

    /* Two-pane bid reader (B2-r4) */
    .bpc-bid-reader {
      display: grid;
      grid-template-columns: minmax(0, 280px) minmax(0, 1fr);
      gap: 0;
      border: 1px solid #e7e3d6;
      border-radius: 12px;
      background: #fff;
      margin: 24px 0;
      overflow: hidden;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    @media (max-width: 760px) {
      .bpc-bid-reader { grid-template-columns: 1fr; }
      .bpc-bid-reader-list { border-right: none !important; border-bottom: 1px solid #e7e3d6; max-height: 360px; }
    }
    .bpc-bid-reader-list {
      border-right: 1px solid #e7e3d6;
      background: #faf8f3;
      max-height: 720px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .bpc-bid-reader-total-card {
      padding: 18px 20px 16px;
      border-bottom: 1px solid #e7e3d6;
      background: #fff;
    }
    .bpc-bid-total-eyebrow {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.16em;
      color: #5d7e69;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .bpc-bid-total-amount {
      font-size: 26px;
      font-weight: 700;
      color: #353535;
      letter-spacing: -0.02em;
      line-height: 1.05;
    }
    .bpc-bid-total-meta {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }
    .bpc-bid-total-breakdown {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed #e7e3d6;
      font-size: 12px;
      color: #58595b;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .bpc-bid-total-breakdown-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .bpc-bid-total-breakdown-row span:last-child {
      color: #353535;
      font-weight: 500;
    }
    .bpc-bid-total-breakdown-row--credit span:last-child {
      color: #5d7e69;
    }

    .bpc-bid-reader-rows {
      flex: 1;
      padding: 6px 0;
      overflow-y: auto;
    }
    .bpc-bid-reader-row {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      border-left: 3px solid transparent;
      padding: 11px 16px 11px 13px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.12s, border-color 0.12s;
    }
    .bpc-bid-reader-row:hover {
      background: #f4f1e8;
    }
    .bpc-bid-reader-row.bpc-active {
      background: #fff;
      border-left-color: #5d7e69;
    }
    .bpc-bid-reader-row-eyebrow {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.1em;
      color: #999;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .bpc-bid-reader-row.bpc-active .bpc-bid-reader-row-eyebrow {
      color: #5d7e69;
    }
    .bpc-bid-reader-row-name {
      font-size: 13.5px;
      font-weight: 500;
      color: #353535;
      line-height: 1.3;
      margin-bottom: 2px;
    }
    .bpc-bid-reader-row-amount {
      font-size: 12px;
      font-weight: 500;
      color: #58595b;
      font-variant-numeric: tabular-nums;
    }

    .bpc-bid-reader-pane {
      padding: 28px 32px;
      overflow-y: auto;
      max-height: 720px;
    }
    @media (max-width: 760px) {
      .bpc-bid-reader-pane { padding: 22px 18px; max-height: none; }
    }
    .bpc-bid-reader-pane > .pub-scope-item {
      padding: 0 !important;
      border-top: none !important;
    }
    .bpc-bid-reader-pane > .pub-scope-item.bpc-hidden-section {
      display: none !important;
    }
    .bpc-bid-reader-empty {
      padding: 24px 0;
      text-align: center;
      color: #999;
      font-size: 13px;
    }
  `;

  function injectStyles() {
    if (document.getElementById('bpc-twocol-styles')) return;
    const el = document.createElement('style');
    el.id = 'bpc-twocol-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  function renderOverview(card, regions, regionMap) {
    const matNames = new Set();
    regions.forEach(r => (regionMap.get(r.id) || []).forEach(m => matNames.add(m.name)));

    const customizableNote = customize.enabled
      ? '<p class="bpc-card-prompt" style="background:#f0f4f1;border-left:3px solid #5d7e69;padding:10px 12px;border-radius:4px;"><strong style="color:#5d7e69;">You can customize this proposal.</strong> Tap any section below or any colored area on the plan to swap materials. We\'ll let your designer know.</p>'
      : '<p class="bpc-card-prompt">Tap any highlighted area on the plan to see what\'s planned for that section, or pick from the list below.</p>';

    card.innerHTML = `
      <div class="bpc-detail-card-body">
        <div class="bpc-card-eyebrow">Your project</div>
        <div class="bpc-card-title">${regions.length} section${regions.length === 1 ? '' : 's'}, ${matNames.size} material${matNames.size === 1 ? '' : 's'}</div>
        ${customizableNote}
        <div class="bpc-overview-list">
          ${regions.map(r => `
            <button type="button" class="bpc-overview-row" data-region-id="${escapeHtml(r.id)}">
              <span class="bpc-overview-dot" style="background:${escapeHtml(r.color)};"></span>
              <span class="bpc-overview-text">
                <span class="bpc-overview-name">${escapeHtml(r.name)}</span>
                ${r.meta ? `<span class="bpc-overview-meta">${escapeHtml(r.meta)}</span>` : ''}
              </span>
              <span class="bpc-overview-arrow">→</span>
            </button>
          `).join('')}
        </div>
      </div>
      ${renderTrayHtml()}
    `;
    card.querySelectorAll('.bpc-overview-row').forEach((row) => {
      row.addEventListener('click', () => {
        const rid = row.getAttribute('data-region-id');
        renderRegionDetail(card, rid, regions, regionMap);
      });
    });
    wireTrayClicks(card);
  }

  function renderRegionDetail(card, regionId, regions, regionMap) {
    const region = regions.find(r => r.id === regionId);
    if (!region) return;
    const mats = regionMap.get(regionId) || [];

    const matsHtml = mats.length === 0
      ? `<div class="bpc-detail-empty">No customizable materials assigned to this section yet.</div>`
      : mats.map((m, idx) => renderMaterialRowHtml(regionId, m, idx)).join('');

    card.innerHTML = `
      <div class="bpc-detail-card-body">
        <button type="button" class="bpc-card-back">← Overview</button>
        <div class="bpc-card-eyebrow" style="color:${escapeHtml(region.color)};">Section</div>
        <div class="bpc-card-title">${escapeHtml(region.name)}</div>
        ${region.meta ? `<div class="bpc-card-meta">${escapeHtml(region.meta)}</div>` : ''}
        <div class="bpc-detail-mats">${matsHtml}</div>
        ${region.sectionHref ? `<button type="button" class="bpc-card-section-link" data-href="${escapeHtml(region.sectionHref)}">See detailed section bid →</button>` : ''}
      </div>
      ${renderTrayHtml()}
    `;
    card.querySelector('.bpc-card-back').addEventListener('click', () => {
      renderOverview(card, regions, regionMap);
    });
    const sectionBtn = card.querySelector('.bpc-card-section-link');
    if (sectionBtn) {
      sectionBtn.addEventListener('click', () => navigateToSection(sectionBtn.getAttribute('data-href')));
    }
    wireMaterialRowClicks(card, regionId, regions, regionMap);
    wireTrayClicks(card);
  }

  function renderMaterialRowHtml(regionId, m, idx) {
    const apiMat = customize.enabled ? findApiMaterial(regionId, m) : null;
    const pending = apiMat ? customize.pending.get(apiMat.id) : null;

    const thumbHtml = m.imgSrc
      ? `<img class="bpc-detail-mat-thumb" src="${escapeHtml(m.imgSrc)}" alt="">`
      : `<div class="bpc-detail-mat-thumb"></div>`;

    let rightHtml = '';
    if (customize.enabled && apiMat) {
      if (pending) {
        rightHtml = `
          <div class="bpc-detail-mat-actions">
            <button type="button" class="bpc-swap-btn bpc-swap-btn--undo" data-undo-region-material-id="${escapeHtml(apiMat.id)}">Undo</button>
            <button type="button" class="bpc-swap-btn" data-region-material-id="${escapeHtml(apiMat.id)}" data-region-id="${escapeHtml(regionId)}" data-mat-idx="${idx}">Change</button>
          </div>
        `;
      } else {
        rightHtml = `
          <div class="bpc-detail-mat-actions">
            <button type="button" class="bpc-swap-btn" data-region-material-id="${escapeHtml(apiMat.id)}" data-region-id="${escapeHtml(regionId)}" data-mat-idx="${idx}">Swap →</button>
          </div>
        `;
      }
    }

    let bodyHtml = `
      ${m.type  ? `<div class="bpc-detail-mat-type">${escapeHtml(m.type)}</div>`   : ''}
      <div class="bpc-detail-mat-name">${escapeHtml(m.name)}</div>
      ${m.color ? `<div class="bpc-detail-mat-color">${escapeHtml(m.color)}</div>` : ''}
    `;
    if (pending) {
      const replacementName = pending.replacement_material.product_name +
        (pending.replacement_material.color ? ' / ' + pending.replacement_material.color : '');
      bodyHtml += `
        <div class="bpc-detail-mat-pending-arrow">↓ swapping to</div>
        <div class="bpc-detail-mat-pending-name">${escapeHtml(replacementName)}</div>
      `;
    }

    return `
      <div class="bpc-detail-mat${pending ? ' bpc-detail-mat--pending' : ''}">
        ${thumbHtml}
        <div class="bpc-detail-mat-body">${bodyHtml}</div>
        ${rightHtml}
      </div>
    `;
  }

  function wireMaterialRowClicks(card, regionId, regions, regionMap) {
    card.querySelectorAll('button.bpc-swap-btn[data-region-material-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rmId = btn.getAttribute('data-region-material-id');
        openSwapModal(rmId, () => renderRegionDetail(card, regionId, regions, regionMap));
      });
    });
    card.querySelectorAll('button.bpc-swap-btn--undo').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rmId = btn.getAttribute('data-undo-region-material-id');
        customize.pending.delete(rmId);
        renderRegionDetail(card, regionId, regions, regionMap);
      });
    });
  }

  function renderTrayHtml() {
    if (!customize.enabled) return '';
    const count = customize.pending.size;
    if (count === 0) return '';
    return `
      <div class="bpc-tray">
        <div class="bpc-tray-count">${count} pending change${count === 1 ? '' : 's'}</div>
        <button type="button" class="bpc-tray-cta">Save & notify designer</button>
      </div>
    `;
  }
  function wireTrayClicks(card) {
    const cta = card.querySelector('.bpc-tray-cta');
    if (cta) cta.addEventListener('click', () => openSubmitModal(card));
  }

  function openSwapModal(rmId, onAfter) {
    const rm = customize.data.region_materials.find((r) => r.id === rmId);
    if (!rm) return;
    const category = rm.current.category;
    const candidates = (customize.data.swap_candidates_by_category[category] || []);

    const currentMatId = rm.current.material_id;
    const candHtml = candidates.length === 0
      ? `<div class="bpc-detail-empty">No alternatives available in the catalog yet for this category.</div>`
      : `<div class="bpc-cand-grid">` + candidates.map((c) => {
          const isCurrent = c.id === currentMatId;
          const thumb = c.swatch_url
            ? `<img class="bpc-cand-thumb" src="${escapeHtml(c.swatch_url)}" alt="">`
            : `<div class="bpc-cand-thumb-empty"></div>`;
          return `
            <button type="button" class="bpc-cand${isCurrent ? ' bpc-cand--current' : ''}" data-mat-id="${escapeHtml(c.id)}">
              ${thumb}
              <div class="bpc-cand-name">${escapeHtml(c.product_name || 'Material')}</div>
              ${c.color ? `<div class="bpc-cand-color">${escapeHtml(c.color)}</div>` : ''}
              ${isCurrent ? `<div class="bpc-cand-current-pill">Current</div>` : ''}
            </button>
          `;
        }).join('') + `</div>`;

    const currentName = (rm.current.product_name || 'Material') + (rm.current.color ? ' / ' + rm.current.color : '');
    const currentThumb = rm.current.swatch_url
      ? `<img class="bpc-cand-current-thumb" src="${escapeHtml(rm.current.swatch_url)}" alt="">`
      : `<div class="bpc-cand-current-thumb"></div>`;

    const modal = buildModal({
      title: 'Swap material in ' + (rm.region_name || 'this section'),
      bodyHtml: `
        <div class="bpc-cand-current">
          ${currentThumb}
          <div class="bpc-cand-current-text">
            <div class="bpc-cand-current-label">Currently</div>
            <div class="bpc-cand-current-name">${escapeHtml(currentName)}</div>
            ${rm.current.manufacturer ? `<div class="bpc-cand-current-color">${escapeHtml(rm.current.manufacturer)}</div>` : ''}
          </div>
        </div>
        <div style="font-size:13px;color:#58595b;margin-bottom:10px;">Choose an alternative:</div>
        ${candHtml}
      `,
      footerHtml: `
        <button type="button" class="bpc-btn bpc-btn--ghost" data-action="cancel">Cancel</button>
        <button type="button" class="bpc-btn bpc-btn--primary" data-action="confirm" disabled>Confirm swap</button>
      `,
    });

    let selectedId = null;
    modal.querySelectorAll('.bpc-cand:not(.bpc-cand--current)').forEach((b) => {
      b.addEventListener('click', () => {
        modal.querySelectorAll('.bpc-cand').forEach((c) => c.classList.remove('bpc-cand--selected'));
        b.classList.add('bpc-cand--selected');
        selectedId = b.getAttribute('data-mat-id');
        modal.querySelector('[data-action="confirm"]').disabled = false;
      });
    });
    modal.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
    modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      if (!selectedId) return;
      const replacementMat = candidates.find((c) => c.id === selectedId);
      customize.pending.set(rmId, {
        replacement_material_id: selectedId,
        replacement_material: replacementMat,
        original: rm.current,
      });
      closeModal();
      onAfter && onAfter();
    });
  }

  function openSubmitModal(card) {
    const items = Array.from(customize.pending.entries()).map(([rmId, p]) => {
      const rm = customize.data.region_materials.find((r) => r.id === rmId);
      return { rm, p };
    });

    const summaryHtml = items.map(({ rm, p }) => {
      const fromLabel = (rm.current.product_name || 'Material') + (rm.current.color ? ' / ' + rm.current.color : '');
      const toLabel = (p.replacement_material.product_name || 'Material') + (p.replacement_material.color ? ' / ' + p.replacement_material.color : '');
      return `
        <li class="bpc-summary-item">
          <div class="bpc-summary-region">${escapeHtml(rm.region_name)}</div>
          <span class="bpc-summary-from">${escapeHtml(fromLabel)}</span>
          <span class="bpc-summary-arrow">→</span>
          <strong>${escapeHtml(toLabel)}</strong>
        </li>
      `;
    }).join('');

    const modal = buildModal({
      title: 'Send these changes to your designer?',
      bodyHtml: `
        <ul class="bpc-summary-list">${summaryHtml}</ul>
        <label style="display:block;font-size:12px;font-weight:600;color:#5d7e69;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px;">Add a note (optional)</label>
        <textarea class="bpc-modal-textarea" placeholder="Anything you want your designer to know about these choices?"></textarea>
        <p style="font-size:12px;color:#999;line-height:1.5;margin-top:12px;">Your designer will review these choices, update pricing if needed, and get back to you.</p>
      `,
      footerHtml: `
        <button type="button" class="bpc-btn bpc-btn--ghost" data-action="cancel">Keep editing</button>
        <button type="button" class="bpc-btn bpc-btn--primary" data-action="submit">Send to designer</button>
      `,
    });

    modal.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
    modal.querySelector('[data-action="submit"]').addEventListener('click', async () => {
      const note = modal.querySelector('.bpc-modal-textarea').value.trim();
      const submitBtn = modal.querySelector('[data-action="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      const slug = getSlugFromPath();
      const token = getAuthToken();
      try {
        const r = await fetch(API_SUBMIT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({
            slug,
            homeowner_note: note || null,
            items: items.map(({ rm, p }) => ({
              proposal_region_material_id: rm.id,
              replacement_material_id: p.replacement_material_id,
            })),
          }),
        });
        const result = await r.json().catch(() => ({}));
        if (!r.ok) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send to designer';
          alert('Could not send: ' + (result.error || ('HTTP ' + r.status)));
          return;
        }
        customize.submitted = true;
        showSuccessState(modal, items.length, result.email_sent);
        customize.pending.clear();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send to designer';
        alert('Network error: ' + (err && err.message));
      }
    });
  }

  function showSuccessState(modal, itemCount, emailSent) {
    const body = modal.querySelector('.bpc-modal-body');
    const footer = modal.querySelector('.bpc-modal-footer');
    body.innerHTML = `
      <div class="bpc-success">
        <div class="bpc-success-icon">✓</div>
        <h3>Sent to your designer</h3>
        <p>
          ${itemCount} change${itemCount === 1 ? '' : 's'} submitted${emailSent ? ' and your designer has been emailed.' : '.'}
          They\'ll review and reach out with any pricing updates.
        </p>
      </div>
    `;
    footer.innerHTML = `<button type="button" class="bpc-btn bpc-btn--primary" data-action="done">Done</button>`;
    footer.querySelector('[data-action="done"]').addEventListener('click', () => {
      closeModal();
      const card = document.querySelector('.bpc-detail-card');
      if (card && customize._lastRender) customize._lastRender();
    });
  }

  let activeModal = null;
  function buildModal({ title, bodyHtml, footerHtml }) {
    closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'bpc-modal-backdrop';
    backdrop.innerHTML = `
      <div class="bpc-modal" role="dialog" aria-modal="true">
        <div class="bpc-modal-header">
          <h2 class="bpc-modal-title">${escapeHtml(title)}</h2>
          <button type="button" class="bpc-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="bpc-modal-body">${bodyHtml}</div>
        <div class="bpc-modal-footer">${footerHtml}</div>
      </div>
    `;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    backdrop.querySelector('.bpc-modal-close').addEventListener('click', closeModal);
    document.body.appendChild(backdrop);
    activeModal = backdrop;
    document.addEventListener('keydown', escCloseModal);
    return backdrop.querySelector('.bpc-modal');
  }
  function closeModal() {
    if (activeModal) { activeModal.remove(); activeModal = null; }
    document.removeEventListener('keydown', escCloseModal);
  }
  function escCloseModal(e) { if (e.key === 'Escape') closeModal(); }

  function transformLayout(inner, siteMapEl, legendEl, regions, regionMap) {
    const twocol = document.createElement('div');
    twocol.className = 'bpc-twocol';

    const left  = document.createElement('div'); left.className  = 'bpc-twocol-left';
    const right = document.createElement('div'); right.className = 'bpc-twocol-right';
    twocol.appendChild(left);
    twocol.appendChild(right);
    left.appendChild(siteMapEl);

    const card = document.createElement('div');
    card.className = 'bpc-detail-card';
    right.appendChild(card);

    if (legendEl && legendEl.parentNode === inner) {
      inner.insertBefore(twocol, legendEl);
      legendEl.classList.add('bpc-tight');
    } else {
      inner.appendChild(twocol);
    }

    const materialsSection = inner.querySelector('.pub-site-plan-materials');
    if (materialsSection) materialsSection.classList.add('bpc-hidden');

    customize._lastRender = () => renderOverview(card, regions, regionMap);
    customize._lastRender();

    document.querySelectorAll('polygon.pub-drawing-region:not(.pub-drawing-region--static)').forEach((poly) => {
      const regionId = poly.getAttribute('data-region-id');
      const anchor = poly.closest('a');
      if (!anchor || !regionId) return;
      anchor.addEventListener('click', (e) => {
        e.preventDefault();
        renderRegionDetail(card, regionId, regions, regionMap);
        customize._lastRender = () => renderRegionDetail(card, regionId, regions, regionMap);
        const href = anchor.getAttribute('href');
        if (href) navigateToSection(href);
      });
    });

    document.querySelectorAll('.pub-region-legend-row').forEach((row) => {
      const regionId = row.getAttribute('data-region-id');
      if (!regionId) return;
      row.addEventListener('click', (e) => {
        e.preventDefault();
        renderRegionDetail(card, regionId, regions, regionMap);
        customize._lastRender = () => renderRegionDetail(card, regionId, regions, regionMap);
      });
    });
  }

  // Two-pane bid reader. Transforms .pub-scope-list ul into a two-pane
  // reader with project-total card on the left rail and one section
  // shown at a time on the right.
  function transformBidSection() {
    const scopeList = document.querySelector('.pub-scope-list');
    if (!scopeList) return null;

    const items = Array.from(scopeList.querySelectorAll(':scope > .pub-scope-item'));
    if (items.length === 0) return null;

    const scopeTotal = scopeList.parentElement
      ? scopeList.parentElement.querySelector('.pub-scope-total')
      : null;

    let finalTotalAmount = '';
    let subtotalAmount = '';
    let creditAmount = '';

    if (scopeTotal) {
      const amountEls = scopeTotal.querySelectorAll('.pub-scope-total-amount');
      if (amountEls.length > 0) {
        finalTotalAmount = (amountEls[amountEls.length - 1].textContent || '').trim();
      }
      const allText = (scopeTotal.parentElement
        ? scopeTotal.parentElement.textContent
        : scopeTotal.textContent) || '';
      const subMatch = allText.match(/Estimate subtotal[\s\S]{0,30}?(\$[\d,]+(?:\.\d+)?)/i);
      const credMatch = allText.match(/Credit[\s\S]{0,30}?(\(?\$[\d,]+(?:\.\d+)?\)?)/i);
      if (subMatch) subtotalAmount = subMatch[1];
      if (credMatch) creditAmount = credMatch[1];
    }

    if (!finalTotalAmount) {
      let sum = 0;
      let valid = true;
      items.forEach((item) => {
        const amtEl = item.querySelector('.pub-scope-item-amount');
        if (!amtEl) { valid = false; return; }
        const num = parseFloat((amtEl.textContent || '').replace(/[^0-9.\-]/g, ''));
        if (isNaN(num)) { valid = false; return; }
        sum += num;
      });
      if (valid) {
        finalTotalAmount = '$' + sum.toLocaleString('en-US', { maximumFractionDigits: 0 });
      }
    }

    const reader = document.createElement('div');
    reader.className = 'bpc-bid-reader';

    const listEl = document.createElement('div');
    listEl.className = 'bpc-bid-reader-list';

    const totalCard = document.createElement('div');
    totalCard.className = 'bpc-bid-reader-total-card';
    let breakdownHtml = '';
    if (subtotalAmount || creditAmount) {
      breakdownHtml = '<div class="bpc-bid-total-breakdown">';
      if (subtotalAmount) {
        breakdownHtml += `<div class="bpc-bid-total-breakdown-row"><span>Subtotal</span><span>${escapeHtml(subtotalAmount)}</span></div>`;
      }
      if (creditAmount) {
        breakdownHtml += `<div class="bpc-bid-total-breakdown-row bpc-bid-total-breakdown-row--credit"><span>Credit</span><span>${escapeHtml(creditAmount)}</span></div>`;
      }
      breakdownHtml += '</div>';
    }
    totalCard.innerHTML = `
      <div class="bpc-bid-total-eyebrow">Project total</div>
      <div class="bpc-bid-total-amount">${escapeHtml(finalTotalAmount || '')}</div>
      <div class="bpc-bid-total-meta">${items.length} section${items.length === 1 ? '' : 's'}</div>
      ${breakdownHtml}
    `;
    listEl.appendChild(totalCard);

    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'bpc-bid-reader-rows';

    const sections = items.map((item, idx) => {
      const id = item.getAttribute('id') || ('bpc-section-' + idx);
      if (!item.getAttribute('id')) item.setAttribute('id', id);
      const eyebrowEl = item.querySelector('.pub-scope-item-eyebrow');
      const nameEl = item.querySelector('.pub-scope-item-name');
      const amountEl = item.querySelector('.pub-scope-item-amount');
      const eyebrow = eyebrowEl ? (eyebrowEl.textContent || '').trim() : ('Section ' + String(idx + 1).padStart(2, '0'));
      const name = nameEl ? (nameEl.textContent || '').trim() : 'Section';
      const amount = amountEl ? (amountEl.textContent || '').trim() : '';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bpc-bid-reader-row';
      btn.setAttribute('data-target', id);
      btn.innerHTML = `
        <div class="bpc-bid-reader-row-eyebrow">${escapeHtml(eyebrow)}</div>
        <div class="bpc-bid-reader-row-name">${escapeHtml(name)}</div>
        ${amount ? `<div class="bpc-bid-reader-row-amount">${escapeHtml(amount)}</div>` : ''}
      `;
      rowsWrap.appendChild(btn);

      return { id, btn, item };
    });
    listEl.appendChild(rowsWrap);

    const paneEl = document.createElement('div');
    paneEl.className = 'bpc-bid-reader-pane';
    sections.forEach(({ item }) => {
      paneEl.appendChild(item);
      item.classList.add('bpc-hidden-section');
    });

    reader.appendChild(listEl);
    reader.appendChild(paneEl);

    scopeList.parentNode.insertBefore(reader, scopeList);
    scopeList.remove();
    if (scopeTotal && scopeTotal.parentNode) {
      const parent = scopeTotal.parentElement;
      scopeTotal.remove();
      if (parent) {
        parent.querySelectorAll('.pub-scope-summary-row').forEach(el => el.remove());
      }
    }

    function select(id) {
      const target = sections.find(s => s.id === id);
      if (!target) return false;
      sections.forEach(s => {
        s.item.classList.add('bpc-hidden-section');
        s.btn.classList.remove('bpc-active');
      });
      target.item.classList.remove('bpc-hidden-section');
      target.btn.classList.add('bpc-active');
      paneEl.scrollTop = 0;
      target.btn.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
      return true;
    }

    sections.forEach((s) => {
      s.btn.addEventListener('click', () => select(s.id));
    });

    if (sections.length > 0) select(sections[0].id);

    return { root: reader, select };
  }

  async function init() {
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

    const token = getAuthToken();
    const slug = getSlugFromPath();
    if (token && slug) {
      try {
        const r = await fetch(API_DATA + '?slug=' + encodeURIComponent(slug), {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (r.ok) {
          customize.data = await r.json();
          customize.enabled = true;
        }
      } catch (e) {}
    }

    transformLayout(inner, siteMapEl, legendEl, regions, regionMap);
    _bidReader = transformBidSection();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
