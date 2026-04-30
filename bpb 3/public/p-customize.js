// ═══════════════════════════════════════════════════════════════════════════
// /p-customize.js — Phase 4.1 Sprint B1
//
// Homeowner customization overlay. Loads on /p/{slug} pages via the
// <script> tag injected by functions/p/[slug].js. Self-deactivates when:
//   - viewer isn't signed in (no Supabase JWT in localStorage), OR
//   - viewer doesn't own this proposal (server returns 403)
//
// B1 capabilities (this build):
//   - Auth detection from Supabase localStorage
//   - Context fetch from /api/proposal-substitution-context
//   - Welcome banner across the top of the page
//   - Polygon click → side panel showing that region's materials (READ-ONLY)
//
// B2 (next sprint): swap modal, pending changes tray, save & notify designer.
//
// CSS prefix: .bpc-  (Bayside Pavers Customize)
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const API_CONTEXT = '/api/proposal-substitution-context';

  // ─── Helpers ─────────────────────────────────────────────────────────
  function getAuthToken() {
    // Scan localStorage for the Supabase auth token. Key looks like
    // sb-{project-ref}-auth-token. We don't hardcode the project ref so
    // this works across project moves.
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

  // ─── Styles (injected once on activate) ─────────────────────────────
  const STYLES = `
    .bpc-banner {
      position: fixed; top: 0; left: 0; right: 0;
      background: #5d7e69; color: #fff;
      padding: 12px 24px;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 15px; font-weight: 500;
      box-shadow: 0 2px 12px rgba(0,0,0,0.12);
      z-index: 1000;
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      animation: bpcSlideDown 0.32s ease;
    }
    .bpc-banner-text { flex: 1; line-height: 1.4; }
    .bpc-banner-text strong { font-weight: 700; }
    .bpc-banner-help {
      display: block;
      font-size: 13px;
      opacity: 0.92;
      font-weight: 400;
      margin-top: 2px;
    }
    .bpc-banner-close {
      background: rgba(255,255,255,0.18);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.32);
      border-radius: 6px;
      padding: 6px 14px;
      font-family: inherit; font-size: 13px; font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      flex-shrink: 0;
    }
    .bpc-banner-close:hover { background: rgba(255,255,255,0.28); }
    @keyframes bpcSlideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }

    body.bpc-active { padding-top: 64px; }

    @media (max-width: 600px) {
      .bpc-banner { padding: 10px 16px; font-size: 14px; }
      body.bpc-active { padding-top: 76px; }
    }

    /* Side panel */
    .bpc-panel-backdrop {
      position: fixed; inset: 0;
      background: rgba(53, 53, 53, 0.32);
      z-index: 1100;
      animation: bpcFadeIn 0.18s ease;
    }
    @keyframes bpcFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .bpc-panel {
      position: fixed; top: 0; right: 0; bottom: 0;
      width: 420px; max-width: 92vw;
      background: #fff;
      box-shadow: -4px 0 24px rgba(0,0,0,0.16);
      z-index: 1110;
      display: flex; flex-direction: column;
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      animation: bpcSlideInRight 0.28s ease;
    }
    @keyframes bpcSlideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .bpc-panel-header {
      padding: 24px 24px 16px;
      border-bottom: 1px solid #eee;
      display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    }
    .bpc-panel-title { margin: 0; font-size: 22px; font-weight: 700; color: #353535; line-height: 1.15; }
    .bpc-panel-meta { font-size: 13px; color: #999; margin-top: 4px; }
    .bpc-panel-close {
      background: transparent; border: none; cursor: pointer;
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 6px; color: #666;
      font-size: 22px; line-height: 1;
      transition: background 0.15s, color 0.15s;
    }
    .bpc-panel-close:hover { background: #f4f4ef; color: #353535; }
    .bpc-panel-body {
      flex: 1; overflow-y: auto;
      padding: 16px 24px 32px;
    }
    .bpc-help-callout {
      background: #f4f4ef;
      border-left: 3px solid #5d7e69;
      padding: 12px 14px;
      border-radius: 4px;
      font-size: 13px;
      color: #58595b;
      line-height: 1.5;
      margin-bottom: 20px;
    }
    .bpc-mat-list {
      display: flex; flex-direction: column; gap: 12px;
    }
    .bpc-mat-card {
      display: flex; gap: 14px;
      padding: 12px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
    }
    .bpc-mat-thumb {
      width: 64px; height: 64px;
      border-radius: 6px;
      flex-shrink: 0;
      background: #f4f4ef;
      object-fit: cover;
      border: 1px solid #eee;
    }
    .bpc-mat-thumb-empty {
      width: 64px; height: 64px;
      border-radius: 6px;
      flex-shrink: 0;
      background: linear-gradient(135deg, #f4f4ef, #e5e7eb);
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; color: #999;
      letter-spacing: 0.05em;
    }
    .bpc-mat-body { flex: 1; min-width: 0; }
    .bpc-mat-name { font-weight: 600; font-size: 15px; color: #353535; line-height: 1.2; }
    .bpc-mat-color { font-size: 13px; color: #666; margin-top: 2px; }
    .bpc-mat-mfg {
      font-size: 11px; color: #999; margin-top: 4px;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .bpc-mat-soon {
      margin-top: 8px;
      display: inline-flex; align-items: center;
      padding: 4px 10px;
      background: #f4f4ef;
      color: #58595b;
      font-size: 11px; font-weight: 500;
      border-radius: 999px;
      letter-spacing: 0.03em;
    }
    .bpc-empty-state {
      text-align: center;
      padding: 24px 0;
      color: #999;
      font-size: 14px;
    }

    /* Strengthen polygon hover feedback when overlay is active so the user
       discovers the "tap a section" affordance naturally. */
    body.bpc-active .pub-drawing-region {
      cursor: pointer !important;
      transition: fill 0.15s ease, stroke-width 0.15s ease;
    }
    body.bpc-active .pub-drawing-region:hover {
      fill: rgba(93, 126, 105, 0.5) !important;
      stroke-width: 8 !important;
    }
  `;

  function injectStyles() {
    if (document.getElementById('bpc-styles')) return;
    const el = document.createElement('style');
    el.id = 'bpc-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  // ─── Overlay ─────────────────────────────────────────────────────────
  class Overlay {
    constructor(ctx) {
      this.ctx = ctx;
      this.bannerEl = null;
      this.panelEl = null;
      this.backdropEl = null;
      this._keyHandler = null;
    }

    mount() {
      injectStyles();
      document.body.classList.add('bpc-active');
      this.renderBanner();
      this.attachPolygonClicks();
    }

    renderBanner() {
      const fullName = (this.ctx.client && this.ctx.client.name) || '';
      const firstName = fullName.split(/\s+/)[0] || 'there';
      const banner = document.createElement('div');
      banner.className = 'bpc-banner';
      banner.innerHTML = `
        <div class="bpc-banner-text">
          <strong>Hi ${escapeHtml(firstName)}!</strong> You can request material changes on this proposal.
          <span class="bpc-banner-help">Tap a colored section on the site plan to see what's available.</span>
        </div>
        <button class="bpc-banner-close" type="button">Hide</button>
      `;
      banner.querySelector('.bpc-banner-close').addEventListener('click', () => {
        banner.remove();
        document.body.classList.remove('bpc-active');
      });
      document.body.insertBefore(banner, document.body.firstChild);
      this.bannerEl = banner;
    }

    attachPolygonClicks() {
      // Polygons are <polygon class="pub-drawing-region" data-region-id="...">
      // wrapped in <a href="#section-..."> anchors that scroll to a section.
      // Intercept and open the side panel for that region instead.
      const polygons = document.querySelectorAll('polygon.pub-drawing-region:not(.pub-drawing-region--static)');
      polygons.forEach((poly) => {
        const regionId = poly.getAttribute('data-region-id');
        if (!regionId) return;
        const target = poly.closest('a') || poly;
        target.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openPanelForRegion(regionId);
        });
      });
    }

    openPanelForRegion(regionId) {
      this.closePanel();

      const region = this.ctx.regions.find((r) => r.id === regionId);
      if (!region) return;

      const materials = this.ctx.region_materials
        .filter((rm) => rm.region_id === regionId && rm.material)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

      const matsHtml = materials.length === 0
        ? `<div class="bpc-empty-state">This section doesn't have materials assigned for customization yet.</div>`
        : materials.map((rm) => {
            const m = rm.material;
            const thumb = m.swatch_url
              ? `<img class="bpc-mat-thumb" src="${escapeHtml(m.swatch_url)}" alt="">`
              : `<div class="bpc-mat-thumb-empty">${escapeHtml((m.product_name || 'M').slice(0, 2).toUpperCase())}</div>`;
            return `
              <div class="bpc-mat-card">
                ${thumb}
                <div class="bpc-mat-body">
                  <div class="bpc-mat-name">${escapeHtml(m.product_name || 'Unnamed material')}</div>
                  ${m.color ? `<div class="bpc-mat-color">${escapeHtml(m.color)}</div>` : ''}
                  ${m.manufacturer ? `<div class="bpc-mat-mfg">${escapeHtml(m.manufacturer)}</div>` : ''}
                  <div class="bpc-mat-soon">Swap option coming soon</div>
                </div>
              </div>
            `;
          }).join('');

      const sqftStr = region.area_sqft ? `${region.area_sqft} sqft` : '';
      const lnftStr = region.area_lnft ? `${region.area_lnft} lnft` : '';
      const meta = [sqftStr, lnftStr].filter(Boolean).join(' · ');

      const backdrop = document.createElement('div');
      backdrop.className = 'bpc-panel-backdrop';
      backdrop.addEventListener('click', () => this.closePanel());

      const panel = document.createElement('div');
      panel.className = 'bpc-panel';
      panel.innerHTML = `
        <div class="bpc-panel-header">
          <div>
            <h2 class="bpc-panel-title">${escapeHtml(region.name || 'Section')}</h2>
            ${meta ? `<div class="bpc-panel-meta">${escapeHtml(meta)}</div>` : ''}
          </div>
          <button class="bpc-panel-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="bpc-panel-body">
          <div class="bpc-help-callout">
            These are the materials currently planned for this section. Soon you'll be able to swap any of them for other options and notify your designer.
          </div>
          <div class="bpc-mat-list">${matsHtml}</div>
        </div>
      `;
      panel.querySelector('.bpc-panel-close').addEventListener('click', () => this.closePanel());

      document.body.appendChild(backdrop);
      document.body.appendChild(panel);
      this.backdropEl = backdrop;
      this.panelEl = panel;

      this._keyHandler = (e) => { if (e.key === 'Escape') this.closePanel(); };
      document.addEventListener('keydown', this._keyHandler);
    }

    closePanel() {
      if (this.backdropEl) { this.backdropEl.remove(); this.backdropEl = null; }
      if (this.panelEl) { this.panelEl.remove(); this.panelEl = null; }
      if (this._keyHandler) {
        document.removeEventListener('keydown', this._keyHandler);
        this._keyHandler = null;
      }
    }
  }

  // ─── Boot ────────────────────────────────────────────────────────────
  async function init() {
    const token = getAuthToken();
    if (!token) return;  // not signed in — stay dormant

    const slug = getSlugFromPath();
    if (!slug) return;

    let ctx;
    try {
      const r = await fetch(`${API_CONTEXT}?slug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;  // 401/403/404 — viewer isn't an authorized homeowner
      ctx = await r.json();
    } catch (e) {
      console.warn('p-customize: context fetch failed', e);
      return;
    }

    if (!ctx || !Array.isArray(ctx.regions) || ctx.regions.length === 0) return;

    new Overlay(ctx).mount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
