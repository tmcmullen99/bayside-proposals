// ═══════════════════════════════════════════════════════════════════════════
// /p-redesign.js — Phase 6 Sprint 2 + Sprint 14C.11 (client redesign autonomy)
//
// Loaded by p-customize.js when the customize feature is enabled (i.e., the
// caller is the authenticated homeowner of this proposal). Adds three entry
// points to the proposal page:
//
//   1. Floating CTA at bottom-right with three buttons:
//        - "Suggest changes"   → markup overlay (draw/photo/note)
//        - "Reshape my areas"  → polygon-vertex-drag overlay (sprint 14C.11)
//        - "Print for markup"  → @media print rules
//
//   2. "Suggest changes" → fullscreen overlay with:
//        - Site map image as backdrop
//        - SVG drawing layer (pencil, 3 colors, undo, clear)
//        - Photo upload alternative (canvas-converted to JPEG for HEIC robustness)
//        - Note textarea
//        - Submit → POST /api/submit-redesign
//
//   3. "Reshape my areas" → fullscreen overlay with:
//        - Same site map backdrop
//        - All region polygons rendered draggable (vertex handles)
//        - Live sqft / lnft readout per region (Shoelace formula scaled
//          by original area_sqft from the published legend)
//        - Per-region reset + global reset
//        - Submit → POST /api/submit-redesign with modified_polygons FormData
//
//   4. "Print for markup" → window.print() with @media print rules that
//      hide everything except the site map area
//
// Strokes are stored as {color, points:[{x,y}]} relative to the site map's
// natural pixel dimensions. On submit they're serialized to a clean SVG
// string that the admin queue renders directly via dangerouslySetInnerHTML
// equivalent (innerHTML of a sanitized container).
//
// Reshape data is stored as fractional 0..1 polygon coords in a self-
// contained diff (original + modified + areas) so the designer review
// is stable even if proposal_regions is later edited.
//
// HEIC handling: createImageBitmap(file) → canvas → toBlob('image/jpeg').
// Safari handles HEIC natively at the createImageBitmap step.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (window.__bpcRedesignLoaded) return;
  window.__bpcRedesignLoaded = true;

  const API_REDESIGN = '/api/submit-redesign';

  // Sprint 14C.11 — region color palette mirrors publish.js
  // REGION_LEGEND_COLORS so the colors a homeowner sees on their proposal
  // page match what they see in the reshape overlay. Used for the legend
  // dot, polygon stroke/fill, region selector chips, and the diff
  // visualization on the designer side. If publish.js changes its
  // palette, update both.
  const RESHAPE_PALETTE = [
    '#5d7e69', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899',
    '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#ef4444',
  ];

  // Drawing state
  const draw = {
    strokes: [],          // [{color, points:[{x,y}]}]
    currentColor: '#dc2626',
    currentStroke: null,  // active stroke during pointerdown→up
    isDrawing: false,
  };

  // Sprint 14C.11 — reshape state. Built lazily when the user opens the
  // reshape overlay; reset on close. Shape:
  //   regions: [{
  //     id, name, color,
  //     original_polygon: [{x,y}],   // fractional 0..1, pristine, never mutated
  //     modified_polygon: [{x,y}],   // fractional 0..1, mutated as user drags
  //     original_area_sqft, original_area_lnft,
  //   }]
  const reshape = {
    regions: [],
    selectedIdx: 0,         // which region is currently "active" (vertices visible)
    isDragging: false,
    dragRegionIdx: -1,
    dragVertexIdx: -1,
    backdropW: 0,
    backdropH: 0,
    backdropUrl: '',
  };

  // Photo upload state
  let pickedPhoto = null; // { blob, previewUrl } or null

  // Refs to overlay elements (built lazily on first open)
  let overlayEl = null;
  let svgEl = null;
  let canvasBgEl = null;
  let toolbarEl = null;
  let photoPreviewEl = null;
  let noteTextareaEl = null;
  let submitBtnEl = null;
  let submitStatusEl = null;
  let printNotesAreaEl = null;

  // Sprint 14C.11 — reshape overlay refs (separate DOM tree from markup
  // overlay so the two can't collide; only one open at a time anyway).
  let reshapeOverlayEl   = null;
  let reshapeStageSvgEl  = null;     // the SVG containing backdrop image + draggable polygons
  let reshapeBackdropEl  = null;     // <image> within reshapeStageSvgEl
  let reshapeRegionsGEl  = null;     // <g> holding all region polygons
  let reshapeHandlesGEl  = null;     // <g> holding vertex-drag handles for selectedIdx
  let reshapeReadoutEl   = null;     // legend showing live areas per region
  let reshapeNoteEl      = null;     // optional note textarea
  let reshapeSubmitBtnEl = null;
  let reshapeStatusEl    = null;

  // ── Helpers ──────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

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

  /**
   * Find the site map backdrop image URL + natural dimensions from the
   * existing publish.js DOM. The backdrop is rendered as either an
   * <image> element inside the .pub-site-plan-map SVG or a CSS background.
   * We prefer the SVG <image> href, which is what publish.js outputs.
   */
  function getSiteMapInfo() {
    const svg = document.querySelector('.pub-site-plan-map');
    if (!svg) return null;
    const imageEl = svg.querySelector('image');
    let url = '';
    if (imageEl) {
      url = imageEl.getAttribute('href') || imageEl.getAttribute('xlink:href') || '';
    }
    // Fallback: viewBox dimensions
    let width = 0, height = 0;
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/\s+/).map(Number);
      if (parts.length === 4) { width = parts[2]; height = parts[3]; }
    }
    if (imageEl) {
      width = parseFloat(imageEl.getAttribute('width')) || width;
      height = parseFloat(imageEl.getAttribute('height')) || height;
    }
    return { url, width, height, svgEl: svg };
  }

  // ── Styles ────────────────────────────────────────────────────────────
  const STYLES = `
    /* Floating CTA */
    .bpc-redesign-fab {
      position: fixed;
      bottom: 18px; right: 18px;
      z-index: 1500;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: stretch;
      pointer-events: auto;
    }
    .bpc-redesign-fab-btn,
    .bpc-redesign-fab-btn--secondary {
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.01em;
      padding: 11px 18px;
      border-radius: 24px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(53, 53, 53, 0.18);
      transition: transform 0.08s, background 0.12s;
      white-space: nowrap;
    }
    .bpc-redesign-fab-btn {
      background: #5d7e69;
      color: #fff;
    }
    .bpc-redesign-fab-btn:hover { background: #4a6554; }
    .bpc-redesign-fab-btn--secondary {
      background: #fff;
      color: #5d7e69;
      border: 1px solid #d8d2bf;
    }
    .bpc-redesign-fab-btn--secondary:hover { background: #faf8f3; }
    .bpc-redesign-fab-btn:active,
    .bpc-redesign-fab-btn--secondary:active { transform: scale(0.97); }

    /* Overlay */
    .bpc-redesign-overlay {
      position: fixed; inset: 0;
      background: rgba(20, 22, 24, 0.92);
      z-index: 3000;
      display: flex;
      flex-direction: column;
      animation: bpcrFadeIn 0.16s ease;
    }
    @keyframes bpcrFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .bpc-redesign-overlay-header {
      flex-shrink: 0;
      padding: 14px 20px;
      background: #353535;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid #2a2a2a;
    }
    .bpc-redesign-overlay-header h2 {
      margin: 0;
      font-family: 'Onest', sans-serif;
      font-size: 16px;
      font-weight: 600;
    }
    .bpc-redesign-overlay-close {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }
    .bpc-redesign-overlay-close:hover { background: rgba(255,255,255,0.12); }

    .bpc-redesign-overlay-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .bpc-redesign-canvas-wrap {
      position: relative;
      max-width: 100%;
      max-height: calc(100vh - 280px);
      background: #fff;
      box-shadow: 0 4px 24px rgba(0,0,0,0.25);
      border-radius: 8px;
      overflow: hidden;
      touch-action: none;
    }
    .bpc-redesign-canvas-bg {
      display: block;
      max-width: 100%;
      max-height: calc(100vh - 280px);
      pointer-events: none;
      user-select: none;
    }
    .bpc-redesign-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      cursor: crosshair;
      touch-action: none;
    }

    /* Toolbar */
    .bpc-redesign-toolbar {
      flex-shrink: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
    }
    .bpc-redesign-tool {
      width: 32px; height: 32px;
      border-radius: 6px;
      border: 1.5px solid transparent;
      background: #f4f4ef;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      transition: background 0.12s, border-color 0.12s;
      padding: 0;
    }
    .bpc-redesign-tool:hover { background: #e7e3d6; }
    .bpc-redesign-tool--active { border-color: #353535; background: #fff; }
    .bpc-redesign-color-swatch {
      width: 16px; height: 16px;
      border-radius: 50%;
      display: block;
    }
    .bpc-redesign-toolbar-divider {
      width: 1px;
      height: 22px;
      background: #d8d2bf;
      margin: 0 4px;
    }
    .bpc-redesign-tool-text {
      padding: 0 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      color: #353535;
      background: #f4f4ef;
      border: 1px solid transparent;
      border-radius: 6px;
      height: 32px;
      cursor: pointer;
      white-space: nowrap;
    }
    .bpc-redesign-tool-text:hover { background: #e7e3d6; }
    .bpc-redesign-photo-input { display: none; }

    /* Photo preview */
    .bpc-redesign-photo-preview {
      position: relative;
      max-width: 280px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #fff;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
    }
    .bpc-redesign-photo-preview img {
      display: block;
      max-width: 100%;
      max-height: 200px;
    }
    .bpc-redesign-photo-preview-clear {
      position: absolute;
      top: 6px; right: 6px;
      background: rgba(53, 53, 53, 0.85);
      color: #fff;
      border: none;
      width: 24px; height: 24px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }

    /* Footer with note + submit */
    .bpc-redesign-overlay-footer {
      flex-shrink: 0;
      padding: 12px 16px;
      background: #fff;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-top: 1px solid #e4e4df;
    }
    .bpc-redesign-footer-row {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .bpc-redesign-note {
      flex: 1;
      min-height: 60px;
      max-height: 120px;
      padding: 8px 10px;
      border: 1px solid #d8d2bf;
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      box-sizing: border-box;
    }
    .bpc-redesign-note:focus {
      outline: none;
      border-color: #5d7e69;
      box-shadow: 0 0 0 3px rgba(93,126,105,0.16);
    }
    .bpc-redesign-submit-btn {
      flex-shrink: 0;
      background: #5d7e69;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      align-self: stretch;
      min-width: 140px;
    }
    .bpc-redesign-submit-btn:hover:not(:disabled) { background: #4a6554; }
    .bpc-redesign-submit-btn:disabled {
      background: #a8b5ac;
      cursor: not-allowed;
    }
    .bpc-redesign-submit-status {
      font-size: 12px;
      color: #888;
    }
    .bpc-redesign-submit-status--error { color: #b85450; }
    .bpc-redesign-submit-status--success { color: #5d7e69; font-weight: 600; }

    /* Print rules — hide everything except site map area */
    .bpc-redesign-print-notes {
      display: none;
    }
    @media print {
      body.bpc-redesign-printing > *:not(.pub-page) { display: none !important; }
      body.bpc-redesign-printing .pub-page > *:not(.pub-section--map):not(.pub-cover) {
        display: none !important;
      }
      body.bpc-redesign-printing .pub-cover *:not(.pub-cover-address-block):not(.pub-cover-address):not(.pub-cover-address *) {
        display: none !important;
      }
      body.bpc-redesign-printing .bpc-twocol {
        grid-template-columns: 1fr !important;
      }
      body.bpc-redesign-printing .bpc-detail-card,
      body.bpc-redesign-printing .bpc-redesign-fab,
      body.bpc-redesign-printing .bpc-redesign-overlay,
      body.bpc-redesign-printing .pub-region-legend-actions,
      body.bpc-redesign-printing .bpc-tray { display: none !important; }
      body.bpc-redesign-printing .bpc-redesign-print-notes {
        display: block !important;
        margin: 24px;
        border-top: 1px solid #888;
        padding-top: 16px;
      }
      body.bpc-redesign-printing .bpc-redesign-print-notes h3 {
        font-family: 'Onest', sans-serif;
        font-size: 16px;
        font-weight: 600;
        margin: 0 0 12px;
        color: #353535;
      }
      body.bpc-redesign-printing .bpc-redesign-print-notes-lines {
        height: 4in;
        background: repeating-linear-gradient(
          to bottom,
          transparent 0,
          transparent 23px,
          #d4d0c2 23px,
          #d4d0c2 24px
        );
      }
      @page { margin: 0.5in; }
    }

    /* ════════════════════════════════════════════════════════════════
       Sprint 14C.11 — reshape overlay
       Separate DOM tree from the markup overlay so styles don't collide.
       Reuses the same overlay/header/footer scaffolding visually but
       with a different toolbar (region chips, area readout) and no
       drawing tools.
       ════════════════════════════════════════════════════════════════ */
    .bpc-redesign-fab-btn--reshape {
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.01em;
      padding: 11px 18px;
      border-radius: 24px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(53, 53, 53, 0.18);
      transition: transform 0.08s, background 0.12s;
      white-space: nowrap;
      background: #dad7c5;
      color: #353535;
    }
    .bpc-redesign-fab-btn--reshape:hover { background: #cdc7ae; }
    .bpc-redesign-fab-btn--reshape:active { transform: scale(0.97); }

    .bpc-reshape-overlay {
      position: fixed; inset: 0;
      background: rgba(20, 22, 24, 0.94);
      z-index: 3000;
      display: flex;
      flex-direction: column;
      animation: bpcrFadeIn 0.16s ease;
    }
    .bpc-reshape-header {
      flex-shrink: 0;
      padding: 14px 20px;
      background: #353535;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid #2a2a2a;
    }
    .bpc-reshape-header h2 {
      margin: 0;
      font-family: 'Onest', sans-serif;
      font-size: 16px;
      font-weight: 600;
    }
    .bpc-reshape-header-sub {
      font-size: 12px;
      color: #c8c5b3;
      margin-top: 2px;
    }
    .bpc-reshape-close {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }
    .bpc-reshape-close:hover { background: rgba(255,255,255,0.12); }

    .bpc-reshape-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }

    /* Hint banner shown on first open. The flow is non-obvious for
       people who've never seen polygon-edit UIs, so spelling it out
       up front avoids the "what am I supposed to do?" stall. */
    .bpc-reshape-hint {
      max-width: 680px;
      width: 100%;
      background: #faf8f3;
      border: 1px solid #dad7c5;
      border-left: 3px solid #5d7e69;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 13px;
      color: #353535;
      line-height: 1.5;
    }
    .bpc-reshape-hint strong { color: #1f2125; font-weight: 600; }

    /* Region selector chip row — one chip per region, color-matched
       to the legend dots on the published page. Selected chip has a
       contrasted ring; unselected chips fade to .72 opacity. */
    .bpc-reshape-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      max-width: 100%;
      justify-content: center;
    }
    .bpc-reshape-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px 6px 8px;
      border-radius: 999px;
      background: #fff;
      border: 1.5px solid transparent;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      color: #353535;
      cursor: pointer;
      opacity: 0.72;
      transition: opacity 0.12s, border-color 0.12s, transform 0.08s;
    }
    .bpc-reshape-chip:hover { opacity: 0.92; }
    .bpc-reshape-chip:active { transform: scale(0.97); }
    .bpc-reshape-chip--active {
      opacity: 1;
      border-color: #353535;
    }
    .bpc-reshape-chip-dot {
      width: 14px; height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    /* The stage — backdrop + draggable polygons + vertex handles. Sized
       to fit within the available viewport while keeping a sensible
       max-height. touch-action:none on the SVG so vertex drag doesn't
       trigger page scroll on mobile. */
    .bpc-reshape-stage-wrap {
      position: relative;
      max-width: 100%;
      max-height: calc(100vh - 380px);
      background: #fff;
      box-shadow: 0 4px 24px rgba(0,0,0,0.28);
      border-radius: 8px;
      overflow: hidden;
    }
    .bpc-reshape-stage-svg {
      display: block;
      max-width: 100%;
      max-height: calc(100vh - 380px);
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      cursor: default;
    }
    .bpc-reshape-region-poly {
      cursor: pointer;
      transition: opacity 0.12s, stroke-width 0.12s;
    }
    .bpc-reshape-region-poly--selected {
      /* Bumped stroke so the active region pops; same color stays */
    }
    .bpc-reshape-vertex-handle {
      cursor: grab;
      transition: r 0.08s;
    }
    .bpc-reshape-vertex-handle:hover { /* sized in JS to support mobile */ }
    .bpc-reshape-vertex-handle--dragging { cursor: grabbing; }

    /* Legend / readout column on the right of the stage on wide screens,
       below it on narrow. Each row is a region with its name + sqft and
       lnft delta vs the original. Updates live during drag. */
    .bpc-reshape-readout {
      max-width: 680px;
      width: 100%;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
      overflow: hidden;
    }
    .bpc-reshape-readout-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid #f1efe6;
      font-size: 13px;
    }
    .bpc-reshape-readout-row:last-child { border-bottom: none; }
    .bpc-reshape-readout-row.is-selected { background: #faf8f3; }
    .bpc-reshape-readout-dot {
      width: 14px; height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .bpc-reshape-readout-name {
      font-weight: 600;
      color: #1f2125;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bpc-reshape-readout-meta {
      font-size: 11px;
      color: #70726f;
      margin-top: 2px;
    }
    .bpc-reshape-readout-delta {
      font-size: 12px;
      font-weight: 600;
      color: #70726f;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .bpc-reshape-readout-delta.is-up   { color: #2e7d4f; }
    .bpc-reshape-readout-delta.is-down { color: #b85450; }
    .bpc-reshape-readout-reset {
      background: transparent;
      border: 1px solid #e4e4df;
      color: #58595b;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      margin-left: 6px;
    }
    .bpc-reshape-readout-reset:hover { background: #faf8f3; border-color: #58595b; }
    .bpc-reshape-readout-reset:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      background: transparent;
    }

    .bpc-reshape-toolbar-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
    }
    .bpc-reshape-tool-text {
      padding: 0 14px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      color: #353535;
      background: #f4f4ef;
      border: 1px solid transparent;
      border-radius: 6px;
      height: 32px;
      cursor: pointer;
      white-space: nowrap;
    }
    .bpc-reshape-tool-text:hover { background: #e7e3d6; }
    .bpc-reshape-tool-text:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      background: #f4f4ef;
    }

    /* Footer — same scaffolding as the markup overlay. */
    .bpc-reshape-footer {
      flex-shrink: 0;
      padding: 12px 16px;
      background: #fff;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-top: 1px solid #e4e4df;
    }
    .bpc-reshape-footer-row {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .bpc-reshape-note {
      flex: 1;
      min-height: 60px;
      max-height: 120px;
      padding: 8px 10px;
      border: 1px solid #d8d2bf;
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      box-sizing: border-box;
    }
    .bpc-reshape-note:focus {
      outline: none;
      border-color: #5d7e69;
      box-shadow: 0 0 0 3px rgba(93,126,105,0.16);
    }
    .bpc-reshape-submit-btn {
      flex-shrink: 0;
      background: #5d7e69;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      align-self: stretch;
      min-width: 140px;
    }
    .bpc-reshape-submit-btn:hover:not(:disabled) { background: #4a6554; }
    .bpc-reshape-submit-btn:disabled {
      background: #a8b5ac;
      cursor: not-allowed;
    }
    .bpc-reshape-status {
      font-size: 12px;
      color: #888;
    }
    .bpc-reshape-status--error { color: #b85450; }
    .bpc-reshape-status--success { color: #5d7e69; font-weight: 600; }
  `;

  function injectStyles() {
    if (document.getElementById('bpc-redesign-styles')) return;
    const el = document.createElement('style');
    el.id = 'bpc-redesign-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  // ── Floating CTA ──────────────────────────────────────────────────────
  function renderFab() {
    if (document.getElementById('bpcRedesignFab')) return;
    const fab = document.createElement('div');
    fab.id = 'bpcRedesignFab';
    fab.className = 'bpc-redesign-fab';
    // Sprint 14C.11 — third button "Reshape my areas" sits between
    // Suggest changes (the primary action) and Print for markup (the
    // fallback). Reshape is the most actionable modality — it produces
    // explicit sqft deltas the designer can reprice from — so it's
    // visually heavier than the Print fallback but lighter than the
    // primary "Suggest changes".
    fab.innerHTML =
      '<button type="button" class="bpc-redesign-fab-btn" data-action="suggest">✏️ Suggest changes</button>' +
      '<button type="button" class="bpc-redesign-fab-btn--reshape" data-action="reshape">✥ Reshape my areas</button>' +
      '<button type="button" class="bpc-redesign-fab-btn--secondary" data-action="print">🖨 Print for markup</button>';
    document.body.appendChild(fab);
    fab.querySelector('[data-action="suggest"]').addEventListener('click', openOverlay);
    fab.querySelector('[data-action="reshape"]').addEventListener('click', openReshapeOverlay);
    fab.querySelector('[data-action="print"]').addEventListener('click', handlePrint);
  }

  // ── Print mode ────────────────────────────────────────────────────────
  function ensurePrintNotesArea() {
    if (document.getElementById('bpcRedesignPrintNotes')) return;
    const notes = document.createElement('div');
    notes.id = 'bpcRedesignPrintNotes';
    notes.className = 'bpc-redesign-print-notes';
    notes.innerHTML =
      '<h3>Notes &amp; markup space</h3>' +
      '<div class="bpc-redesign-print-notes-lines"></div>';
    document.body.appendChild(notes);
    printNotesAreaEl = notes;
  }

  function handlePrint() {
    ensurePrintNotesArea();
    document.body.classList.add('bpc-redesign-printing');
    // Defer so the class change applies before the print dialog opens
    setTimeout(() => {
      window.print();
      // Clean up shortly after the print dialog closes (or is dismissed)
      setTimeout(() => document.body.classList.remove('bpc-redesign-printing'), 800);
    }, 80);
  }

  // ── Overlay ───────────────────────────────────────────────────────────
  function openOverlay() {
    if (overlayEl) return;
    const info = getSiteMapInfo();
    if (!info || !info.url) {
      alert('Could not find your site map. Please refresh and try again.');
      return;
    }

    // Reset state
    draw.strokes = [];
    draw.currentColor = '#dc2626';
    draw.currentStroke = null;
    draw.isDrawing = false;
    pickedPhoto = null;

    overlayEl = document.createElement('div');
    overlayEl.className = 'bpc-redesign-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');

    overlayEl.innerHTML = renderOverlayHtml(info);
    document.body.appendChild(overlayEl);

    // Wire references
    canvasBgEl = overlayEl.querySelector('.bpc-redesign-canvas-bg');
    svgEl = overlayEl.querySelector('.bpc-redesign-canvas');
    toolbarEl = overlayEl.querySelector('.bpc-redesign-toolbar');
    photoPreviewEl = overlayEl.querySelector('.bpc-redesign-photo-preview');
    noteTextareaEl = overlayEl.querySelector('.bpc-redesign-note');
    submitBtnEl = overlayEl.querySelector('.bpc-redesign-submit-btn');
    submitStatusEl = overlayEl.querySelector('.bpc-redesign-submit-status');

    // Set SVG viewBox to image natural dimensions (or 1000×750 fallback)
    const w = info.width || 1000;
    const h = info.height || 750;
    svgEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

    // Wire handlers
    overlayEl.querySelector('.bpc-redesign-overlay-close').addEventListener('click', closeOverlay);
    document.addEventListener('keydown', onEscClose);

    toolbarEl.querySelectorAll('[data-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        draw.currentColor = btn.getAttribute('data-color');
        toolbarEl.querySelectorAll('[data-color]').forEach((b) =>
          b.classList.toggle('bpc-redesign-tool--active', b === btn));
      });
    });
    toolbarEl.querySelector('[data-action="undo"]').addEventListener('click', undoStroke);
    toolbarEl.querySelector('[data-action="clear"]').addEventListener('click', clearStrokes);
    const photoInput = toolbarEl.querySelector('.bpc-redesign-photo-input');
    toolbarEl.querySelector('[data-action="pickphoto"]').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', onPhotoPicked);

    photoPreviewEl.querySelector('.bpc-redesign-photo-preview-clear').addEventListener('click', clearPhoto);

    submitBtnEl.addEventListener('click', submitRedesign);
    noteTextareaEl.addEventListener('input', updateSubmitButton);

    // Drawing pointer events
    svgEl.addEventListener('pointerdown', onPointerDown);
    svgEl.addEventListener('pointermove', onPointerMove);
    svgEl.addEventListener('pointerup', onPointerUp);
    svgEl.addEventListener('pointerleave', onPointerUp);

    updateSubmitButton();
  }

  function renderOverlayHtml(info) {
    return (
      '<div class="bpc-redesign-overlay-header">' +
        '<h2>Suggest design changes</h2>' +
        '<button type="button" class="bpc-redesign-overlay-close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="bpc-redesign-overlay-body">' +
        '<div class="bpc-redesign-canvas-wrap">' +
          '<img class="bpc-redesign-canvas-bg" src="' + escapeHtml(info.url) + '" alt="Site map">' +
          '<svg class="bpc-redesign-canvas" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none"></svg>' +
        '</div>' +
        '<div class="bpc-redesign-toolbar">' +
          '<button type="button" class="bpc-redesign-tool bpc-redesign-tool--active" data-color="#dc2626" title="Red"><span class="bpc-redesign-color-swatch" style="background:#dc2626"></span></button>' +
          '<button type="button" class="bpc-redesign-tool" data-color="#1d4ed8" title="Blue"><span class="bpc-redesign-color-swatch" style="background:#1d4ed8"></span></button>' +
          '<button type="button" class="bpc-redesign-tool" data-color="#15803d" title="Green"><span class="bpc-redesign-color-swatch" style="background:#15803d"></span></button>' +
          '<div class="bpc-redesign-toolbar-divider"></div>' +
          '<button type="button" class="bpc-redesign-tool-text" data-action="undo">↶ Undo</button>' +
          '<button type="button" class="bpc-redesign-tool-text" data-action="clear">Clear</button>' +
          '<div class="bpc-redesign-toolbar-divider"></div>' +
          '<button type="button" class="bpc-redesign-tool-text" data-action="pickphoto">📷 Or attach photo of paper markup</button>' +
          '<input type="file" class="bpc-redesign-photo-input" accept="image/jpeg,image/png,image/heic,image/heif,image/webp">' +
        '</div>' +
        '<div class="bpc-redesign-photo-preview" hidden>' +
          '<img alt="Photo preview">' +
          '<button type="button" class="bpc-redesign-photo-preview-clear" aria-label="Remove photo">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="bpc-redesign-overlay-footer">' +
        '<div class="bpc-redesign-footer-row">' +
          '<textarea class="bpc-redesign-note" placeholder="Add a note for your designer (optional). Tell them what you\'d like to change."></textarea>' +
          '<button type="button" class="bpc-redesign-submit-btn" disabled>Send to designer</button>' +
        '</div>' +
        '<div class="bpc-redesign-submit-status"></div>' +
      '</div>'
    );
  }

  function closeOverlay() {
    if (!overlayEl) return;
    // Confirm if there's unsaved work
    const hasWork = draw.strokes.length > 0 || pickedPhoto || (noteTextareaEl && noteTextareaEl.value.trim());
    if (hasWork && !confirm('Discard your design change request?')) return;
    overlayEl.remove();
    overlayEl = null;
    document.removeEventListener('keydown', onEscClose);
    if (pickedPhoto && pickedPhoto.previewUrl) URL.revokeObjectURL(pickedPhoto.previewUrl);
    pickedPhoto = null;
    draw.strokes = [];
    draw.currentStroke = null;
  }

  function onEscClose(e) { if (e.key === 'Escape') closeOverlay(); }

  // ── Drawing ───────────────────────────────────────────────────────────
  function svgPointFromEvent(e) {
    const rect = svgEl.getBoundingClientRect();
    const vb = svgEl.viewBox.baseVal;
    const x = ((e.clientX - rect.left) / rect.width) * vb.width;
    const y = ((e.clientY - rect.top) / rect.height) * vb.height;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function onPointerDown(e) {
    if (pickedPhoto) {
      // Photo and digital markup are mutually exclusive
      alert('You\'ve attached a photo. Remove it first to draw on the site map.');
      return;
    }
    e.preventDefault();
    if (svgEl.setPointerCapture) {
      try { svgEl.setPointerCapture(e.pointerId); } catch (_) {}
    }
    draw.isDrawing = true;
    const p = svgPointFromEvent(e);
    draw.currentStroke = { color: draw.currentColor, points: [p] };
    draw.strokes.push(draw.currentStroke);
    redrawStrokes();
    updateSubmitButton();
  }
  function onPointerMove(e) {
    if (!draw.isDrawing || !draw.currentStroke) return;
    e.preventDefault();
    const p = svgPointFromEvent(e);
    const prev = draw.currentStroke.points[draw.currentStroke.points.length - 1];
    // Throttle: only add if moved at least 2 SVG units
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (dx * dx + dy * dy < 4) return;
    draw.currentStroke.points.push(p);
    redrawStrokes();
  }
  function onPointerUp(e) {
    if (!draw.isDrawing) return;
    draw.isDrawing = false;
    // Drop strokes with only 1 point (taps) — they're not visible anyway
    if (draw.currentStroke && draw.currentStroke.points.length < 2) {
      draw.strokes.pop();
    }
    draw.currentStroke = null;
    redrawStrokes();
  }

  function redrawStrokes() {
    if (!svgEl) return;
    const vb = svgEl.viewBox.baseVal;
    const strokeWidth = Math.max(2, Math.round(vb.width / 200));
    const parts = draw.strokes.map((s) => {
      if (s.points.length < 2) return '';
      const d = s.points.map(p => p.x + ',' + p.y).join(' ');
      return '<polyline points="' + d + '" stroke="' + s.color + '" fill="none" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }).join('');
    svgEl.innerHTML = parts;
  }

  function undoStroke() {
    if (draw.strokes.length === 0) return;
    draw.strokes.pop();
    redrawStrokes();
    updateSubmitButton();
  }

  function clearStrokes() {
    if (draw.strokes.length === 0) return;
    if (!confirm('Clear all your drawing?')) return;
    draw.strokes = [];
    draw.currentStroke = null;
    redrawStrokes();
    updateSubmitButton();
  }

  // ── Photo upload (with HEIC handling via canvas) ──────────────────────
  async function onPhotoPicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-pick same file later
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      alert('Photo too large (>15MB). Try a smaller one.');
      return;
    }
    if (draw.strokes.length > 0) {
      if (!confirm('Replace your digital drawing with this photo?')) return;
      draw.strokes = [];
      redrawStrokes();
    }
    submitStatusEl.textContent = 'Processing photo…';
    try {
      const resized = await resizeAndConvertToJpeg(file, 1800);
      if (pickedPhoto && pickedPhoto.previewUrl) URL.revokeObjectURL(pickedPhoto.previewUrl);
      const previewUrl = URL.createObjectURL(resized);
      pickedPhoto = { blob: resized, previewUrl };
      photoPreviewEl.querySelector('img').src = previewUrl;
      photoPreviewEl.hidden = false;
      submitStatusEl.textContent = '';
      updateSubmitButton();
    } catch (err) {
      submitStatusEl.textContent = 'Could not process photo: ' + (err && err.message || 'unknown');
      submitStatusEl.classList.add('bpc-redesign-submit-status--error');
    }
  }

  /**
   * Resize file → canvas → JPEG blob. Uses createImageBitmap which handles
   * HEIC natively on Safari. Max long edge defaults to 1800px so uploaded
   * photos stay under 1MB after JPEG-85% compression.
   */
  async function resizeAndConvertToJpeg(file, maxEdge) {
    const bitmap = await createImageBitmap(file);
    const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * ratio);
    const h = Math.round(bitmap.height * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode image'));
      }, 'image/jpeg', 0.85);
    });
  }

  function clearPhoto() {
    if (pickedPhoto && pickedPhoto.previewUrl) URL.revokeObjectURL(pickedPhoto.previewUrl);
    pickedPhoto = null;
    photoPreviewEl.hidden = true;
    photoPreviewEl.querySelector('img').src = '';
    updateSubmitButton();
  }

  // ── Submit ────────────────────────────────────────────────────────────
  function updateSubmitButton() {
    if (!submitBtnEl) return;
    const hasContent = draw.strokes.length > 0 || pickedPhoto || (noteTextareaEl && noteTextareaEl.value.trim().length > 0);
    submitBtnEl.disabled = !hasContent;
    if (submitStatusEl && submitStatusEl.classList.contains('bpc-redesign-submit-status--error')) {
      // Clear stale errors when user makes new progress
      if (hasContent) {
        submitStatusEl.textContent = '';
        submitStatusEl.classList.remove('bpc-redesign-submit-status--error');
      }
    }
  }

  async function submitRedesign() {
    const slug = getSlugFromPath();
    const token = getAuthToken();
    if (!slug || !token) {
      submitStatusEl.textContent = 'You need to be signed in to submit. Refresh and try again.';
      submitStatusEl.classList.add('bpc-redesign-submit-status--error');
      return;
    }
    submitBtnEl.disabled = true;
    submitBtnEl.textContent = 'Sending…';
    submitStatusEl.textContent = '';
    submitStatusEl.classList.remove('bpc-redesign-submit-status--error', 'bpc-redesign-submit-status--success');

    try {
      const info = getSiteMapInfo();
      const fd = new FormData();
      fd.append('slug', slug);
      const note = (noteTextareaEl.value || '').trim();
      if (note) fd.append('homeowner_note', note);
      if (info && info.url) fd.append('site_map_url', info.url);
      if (info && info.width) fd.append('site_map_width', String(info.width));
      if (info && info.height) fd.append('site_map_height', String(info.height));
      if (draw.strokes.length > 0) {
        fd.append('markup_svg', serializeStrokesToSvg(info));
      }
      if (pickedPhoto && pickedPhoto.blob) {
        fd.append('photo', pickedPhoto.blob, 'markup.jpg');
      }

      const resp = await fetch(API_REDESIGN, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: fd,
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        submitStatusEl.textContent = 'Could not send: ' + (result.error || ('HTTP ' + resp.status));
        submitStatusEl.classList.add('bpc-redesign-submit-status--error');
        submitBtnEl.disabled = false;
        submitBtnEl.textContent = 'Send to designer';
        return;
      }

      // Success — show inline confirmation, close on next click
      submitBtnEl.textContent = 'Sent ✓';
      submitStatusEl.textContent = result.email_sent
        ? 'Sent to your designer. They\'ll review and follow up.'
        : 'Submitted. Your designer will see this in the queue.';
      submitStatusEl.classList.add('bpc-redesign-submit-status--success');

      // Auto-close after 2.5s
      setTimeout(() => {
        // Force-clear so confirm() doesn't fire on close
        draw.strokes = [];
        if (pickedPhoto && pickedPhoto.previewUrl) URL.revokeObjectURL(pickedPhoto.previewUrl);
        pickedPhoto = null;
        if (noteTextareaEl) noteTextareaEl.value = '';
        closeOverlay();
      }, 2500);

    } catch (err) {
      submitStatusEl.textContent = 'Network error: ' + (err && err.message || 'unknown');
      submitStatusEl.classList.add('bpc-redesign-submit-status--error');
      submitBtnEl.disabled = false;
      submitBtnEl.textContent = 'Send to designer';
    }
  }

  function serializeStrokesToSvg(info) {
    const w = (info && info.width) || 1000;
    const h = (info && info.height) || 750;
    const strokeWidth = Math.max(2, Math.round(w / 200));
    const polylines = draw.strokes
      .filter(s => s.points.length >= 2)
      .map((s) => {
        const d = s.points.map(p => p.x + ',' + p.y).join(' ');
        return '<polyline points="' + d + '" stroke="' + s.color + '" fill="none" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"/>';
      })
      .join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '">' + polylines + '</svg>';
  }

  // ════════════════════════════════════════════════════════════════════
  // Sprint 14C.11 — RESHAPE MODE
  // Polygon-vertex-drag overlay. Lets the homeowner physically resize
  // the regions on their published proposal by dragging vertices, with
  // live sqft/lnft readouts. Submits a self-contained diff (original +
  // modified polygons + areas) to the same /api/submit-redesign endpoint.
  // ════════════════════════════════════════════════════════════════════

  // Parse "660 sqft · 180 lnft" (or "660 sqft", "180 lnft", or empty)
  // into a {sqft, lnft} pair. Numbers may include thousands separators
  // and decimals. Used to read the original area off the legend rows
  // publish.js renders alongside each polygon.
  function parseAreaFromMetaText(text) {
    if (!text) return { sqft: 0, lnft: 0 };
    const sqftMatch = text.match(/([\d,]+(?:\.\d+)?)\s*sqft/i);
    const lnftMatch = text.match(/([\d,]+(?:\.\d+)?)\s*lnft/i);
    const sqft = sqftMatch ? parseFloat(sqftMatch[1].replace(/,/g, '')) : 0;
    const lnft = lnftMatch ? parseFloat(lnftMatch[1].replace(/,/g, '')) : 0;
    return {
      sqft: Number.isFinite(sqft) ? sqft : 0,
      lnft: Number.isFinite(lnft) ? lnft : 0,
    };
  }

  // Convert publish.js's SVG `points="x,y x,y ..."` string back into
  // fractional 0..1 coordinates (publish.js multiplied by W/H to write
  // them out, so we divide here to invert).
  function parsePolygonPoints(svgPoints, W, H) {
    if (!svgPoints || !W || !H) return [];
    return svgPoints.trim().split(/\s+/).map((pair) => {
      const [xs, ys] = pair.split(',');
      const x = parseFloat(xs);
      const y = parseFloat(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: x / W, y: y / H };
    }).filter(Boolean);
  }

  // Read the published proposal's regions from the DOM. publish.js
  // renders polygons inside `.pub-site-plan-map` SVG with data-region-id,
  // and a corresponding legend row `.pub-region-legend-row[data-region-id]`
  // carrying the human label + area meta. We tie those together here so
  // the reshape overlay has a self-contained view of what to manipulate.
  function readPublishedRegionsFromDom() {
    const svg = document.querySelector('.pub-site-plan-map');
    if (!svg) return null;
    const vbAttr = svg.getAttribute('viewBox');
    if (!vbAttr) return null;
    const [, , vbW, vbH] = vbAttr.split(/\s+/).map(Number);
    if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || vbW <= 0 || vbH <= 0) return null;

    const imageEl = svg.querySelector('image');
    const backdropUrl = imageEl
      ? (imageEl.getAttribute('href') || imageEl.getAttribute('xlink:href') || '')
      : '';

    const regions = [];
    svg.querySelectorAll('polygon[data-region-id]').forEach((poly, idx) => {
      const id = poly.getAttribute('data-region-id');
      if (!id) return;
      // Name lives on the polygon itself (static regions) or on the
      // wrapping <a> (anchored regions).
      const ariaSelf = poly.getAttribute('aria-label');
      const ariaAnchor = poly.parentNode && poly.parentNode.getAttribute
        ? poly.parentNode.getAttribute('aria-label')
        : null;
      const name = ariaSelf || ariaAnchor || ('Region ' + (idx + 1));

      const polygon = parsePolygonPoints(poly.getAttribute('points'), vbW, vbH);
      if (polygon.length < 3) return; // degenerate, skip

      // Read the matching legend row to extract sqft / lnft.
      const legendRow = document.querySelector(
        '.pub-region-legend-row[data-region-id="' + cssEscape(id) + '"]'
      );
      const metaText = legendRow
        ? (legendRow.querySelector('.pub-region-legend-meta')
            ? legendRow.querySelector('.pub-region-legend-meta').textContent
            : '')
        : '';
      const { sqft, lnft } = parseAreaFromMetaText(metaText);

      regions.push({
        id,
        name,
        color: RESHAPE_PALETTE[idx % RESHAPE_PALETTE.length],
        // Deep-copy the polygon so original_polygon stays pristine
        // even if modified_polygon is mutated later.
        original_polygon: polygon.map(p => ({ x: p.x, y: p.y })),
        modified_polygon: polygon.map(p => ({ x: p.x, y: p.y })),
        original_area_sqft: sqft,
        original_area_lnft: lnft,
      });
    });

    return {
      regions,
      backdropW: vbW,
      backdropH: vbH,
      backdropUrl,
    };
  }

  // Minimal CSS.escape() shim. Covers the characters that show up in
  // UUIDs (digits + a-f + dashes), which is what data-region-id holds.
  // Avoids pulling in a polyfill for a one-off attribute selector.
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  // Shoelace formula — signed area of a simple polygon in fractional
  // units². Magnitude is what we care about, sign reflects winding order.
  function shoelaceArea(polygon) {
    if (!polygon || polygon.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  // Sum of edge lengths in fractional units. Used for linear-footage
  // scaling — perimeter scales linearly with linear footage.
  function shoelacePerimeter(polygon) {
    if (!polygon || polygon.length < 2) return 0;
    let perim = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      perim += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return perim;
  }

  // Compute the modified region's sqft from the polygon ratio. The
  // original_area_sqft was set at proposal-publish time using the
  // designer's calibrated px-to-feet scale; we anchor to that and
  // assume the px²-to-sqft conversion is constant across the backdrop
  // (true for orthogonal site plans; close-enough for perspective
  // backdrops since the homeowner is shaping intent, not surveying).
  function computeModifiedSqft(region) {
    const origArea = shoelaceArea(region.original_polygon);
    if (origArea < 1e-9) return region.original_area_sqft || 0;
    const newArea = shoelaceArea(region.modified_polygon);
    return Math.round((region.original_area_sqft || 0) * (newArea / origArea));
  }

  function computeModifiedLnft(region) {
    const origPerim = shoelacePerimeter(region.original_polygon);
    if (origPerim < 1e-9) return region.original_area_lnft || 0;
    const newPerim = shoelacePerimeter(region.modified_polygon);
    return Math.round((region.original_area_lnft || 0) * (newPerim / origPerim));
  }

  // Polygon-was-modified test using a small epsilon. Floating-point
  // round-trip from publish.js → DOM → re-parse can shift coords by
  // ~1e-15, so strict equality would falsely report no-changes.
  function regionWasModified(region) {
    const a = region.original_polygon;
    const b = region.modified_polygon;
    if (!a || !b || a.length !== b.length) return true;
    const EPS = 1e-4;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].x - b[i].x) > EPS) return true;
      if (Math.abs(a[i].y - b[i].y) > EPS) return true;
    }
    return false;
  }

  // ── Open / close ─────────────────────────────────────────────────────
  function openReshapeOverlay() {
    if (reshapeOverlayEl) return;
    const info = getSiteMapInfo();
    const data = readPublishedRegionsFromDom();
    if (!info || !info.url || !data || data.regions.length === 0) {
      alert(
        'Could not find any regions to reshape. ' +
        'Please refresh the page or use "Suggest changes" to send a markup or photo instead.'
      );
      return;
    }

    // Hydrate state. Use info.url for the snapshot since it'll match
    // what the markup-mode submission uses, keeping admin queue
    // rendering consistent across modalities.
    reshape.regions = data.regions;
    reshape.selectedIdx = 0;
    reshape.isDragging = false;
    reshape.dragRegionIdx = -1;
    reshape.dragVertexIdx = -1;
    reshape.backdropW = data.backdropW;
    reshape.backdropH = data.backdropH;
    reshape.backdropUrl = info.url || data.backdropUrl;

    reshapeOverlayEl = document.createElement('div');
    reshapeOverlayEl.className = 'bpc-reshape-overlay';
    reshapeOverlayEl.setAttribute('role', 'dialog');
    reshapeOverlayEl.setAttribute('aria-modal', 'true');
    reshapeOverlayEl.innerHTML = renderReshapeOverlayHtml();
    document.body.appendChild(reshapeOverlayEl);

    // Wire references
    reshapeStageSvgEl  = reshapeOverlayEl.querySelector('.bpc-reshape-stage-svg');
    reshapeBackdropEl  = reshapeStageSvgEl.querySelector('image');
    reshapeRegionsGEl  = reshapeStageSvgEl.querySelector('.bpc-reshape-regions-g');
    reshapeHandlesGEl  = reshapeStageSvgEl.querySelector('.bpc-reshape-handles-g');
    reshapeReadoutEl   = reshapeOverlayEl.querySelector('.bpc-reshape-readout');
    reshapeNoteEl      = reshapeOverlayEl.querySelector('.bpc-reshape-note');
    reshapeSubmitBtnEl = reshapeOverlayEl.querySelector('.bpc-reshape-submit-btn');
    reshapeStatusEl    = reshapeOverlayEl.querySelector('.bpc-reshape-status');

    // Backdrop + viewBox
    reshapeStageSvgEl.setAttribute('viewBox', '0 0 ' + reshape.backdropW + ' ' + reshape.backdropH);
    reshapeBackdropEl.setAttribute('href', reshape.backdropUrl);
    reshapeBackdropEl.setAttribute('width', reshape.backdropW);
    reshapeBackdropEl.setAttribute('height', reshape.backdropH);

    // Wire close + ESC
    reshapeOverlayEl.querySelector('.bpc-reshape-close').addEventListener('click', closeReshapeOverlay);
    document.addEventListener('keydown', onReshapeEscClose);

    // Wire region chips (delegate)
    reshapeOverlayEl.querySelector('.bpc-reshape-chips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-region-idx]');
      if (!btn) return;
      const idx = parseInt(btn.getAttribute('data-region-idx'), 10);
      if (Number.isFinite(idx)) selectReshapeRegion(idx);
    });

    // Wire toolbar
    reshapeOverlayEl.querySelector('[data-action="reset-region"]').addEventListener('click', () => {
      resetReshapeRegion(reshape.selectedIdx);
    });
    reshapeOverlayEl.querySelector('[data-action="reset-all"]').addEventListener('click', resetAllReshape);

    // Wire submit + note
    reshapeSubmitBtnEl.addEventListener('click', submitReshape);
    reshapeNoteEl.addEventListener('input', updateReshapeSubmitButton);

    // Render initial state
    redrawReshapeStage();
    updateReshapeReadout();
    updateReshapeSubmitButton();
  }

  function renderReshapeOverlayHtml() {
    const chips = reshape.regions.map((r, i) =>
      '<button type="button" class="bpc-reshape-chip ' + (i === 0 ? 'bpc-reshape-chip--active' : '') + '"' +
        ' data-region-idx="' + i + '">' +
        '<span class="bpc-reshape-chip-dot" style="background:' + r.color + ';"></span>' +
        escapeHtml(r.name) +
      '</button>'
    ).join('');

    return (
      '<div class="bpc-reshape-header">' +
        '<div>' +
          '<h2>Reshape your areas</h2>' +
          '<div class="bpc-reshape-header-sub">Drag the dots on each area\'s edges to resize it. Sizes update live.</div>' +
        '</div>' +
        '<button type="button" class="bpc-reshape-close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="bpc-reshape-body">' +
        '<div class="bpc-reshape-hint">' +
          '<strong>How this works:</strong> Tap an area below to select it, then drag the colored dots on its edges to make it bigger or smaller. ' +
          'The square footage and linear footage update as you drag. ' +
          'Hit <em>Send to designer</em> when you\'re happy — they\'ll review your requested sizes and follow up with a revised quote.' +
        '</div>' +
        '<div class="bpc-reshape-chips">' + chips + '</div>' +
        '<div class="bpc-reshape-stage-wrap">' +
          '<svg class="bpc-reshape-stage-svg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">' +
            '<image x="0" y="0"/>' +
            '<g class="bpc-reshape-regions-g"></g>' +
            '<g class="bpc-reshape-handles-g"></g>' +
          '</svg>' +
        '</div>' +
        '<div class="bpc-reshape-toolbar-row">' +
          '<button type="button" class="bpc-reshape-tool-text" data-action="reset-region">↺ Reset this area</button>' +
          '<button type="button" class="bpc-reshape-tool-text" data-action="reset-all">↺↺ Reset all areas</button>' +
        '</div>' +
        '<div class="bpc-reshape-readout"></div>' +
      '</div>' +
      '<div class="bpc-reshape-footer">' +
        '<div class="bpc-reshape-footer-row">' +
          '<textarea class="bpc-reshape-note" placeholder="Optional note for your designer (e.g., \'I\'d like the patio bigger so a 6-person dining table fits\')."></textarea>' +
          '<button type="button" class="bpc-reshape-submit-btn" disabled>Send to designer</button>' +
        '</div>' +
        '<div class="bpc-reshape-status"></div>' +
      '</div>'
    );
  }

  function closeReshapeOverlay() {
    if (!reshapeOverlayEl) return;
    const hasChanges = reshape.regions.some(regionWasModified)
      || (reshapeNoteEl && reshapeNoteEl.value.trim());
    if (hasChanges && !confirm('Discard your reshape request?')) return;
    reshapeOverlayEl.remove();
    reshapeOverlayEl   = null;
    reshapeStageSvgEl  = null;
    reshapeBackdropEl  = null;
    reshapeRegionsGEl  = null;
    reshapeHandlesGEl  = null;
    reshapeReadoutEl   = null;
    reshapeNoteEl      = null;
    reshapeSubmitBtnEl = null;
    reshapeStatusEl    = null;
    reshape.regions = [];
    reshape.isDragging = false;
    document.removeEventListener('keydown', onReshapeEscClose);
  }

  function onReshapeEscClose(e) { if (e.key === 'Escape') closeReshapeOverlay(); }

  // ── Selection ────────────────────────────────────────────────────────
  function selectReshapeRegion(idx) {
    if (idx < 0 || idx >= reshape.regions.length) return;
    reshape.selectedIdx = idx;
    // Update chip styles
    reshapeOverlayEl.querySelectorAll('.bpc-reshape-chip').forEach((chip) => {
      const i = parseInt(chip.getAttribute('data-region-idx'), 10);
      chip.classList.toggle('bpc-reshape-chip--active', i === idx);
    });
    redrawReshapeStage();
    updateReshapeReadout();
  }

  // ── Stage rendering ──────────────────────────────────────────────────
  function redrawReshapeStage() {
    if (!reshapeRegionsGEl || !reshapeHandlesGEl) return;
    const W = reshape.backdropW;
    const H = reshape.backdropH;

    // Polygons: render every region (so the homeowner sees the whole
    // site at once), with the selected one stroked thicker.
    let polysHtml = '';
    reshape.regions.forEach((r, idx) => {
      const points = r.modified_polygon
        .map(p => (p.x * W).toFixed(1) + ',' + (p.y * H).toFixed(1))
        .join(' ');
      const isSel = idx === reshape.selectedIdx;
      const sw = isSel ? Math.max(3, Math.round(W * 0.0026)) : Math.max(2, Math.round(W * 0.0016));
      polysHtml +=
        '<polygon class="bpc-reshape-region-poly' + (isSel ? ' bpc-reshape-region-poly--selected' : '') + '"' +
          ' points="' + points + '"' +
          ' fill="' + r.color + '" fill-opacity="' + (isSel ? '0.32' : '0.18') + '"' +
          ' stroke="' + r.color + '" stroke-width="' + sw + '"' +
          ' stroke-linejoin="round"' +
          ' data-region-idx="' + idx + '"' +
          '/>';
    });
    reshapeRegionsGEl.innerHTML = polysHtml;

    // Wire region-poly clicks to select
    reshapeRegionsGEl.querySelectorAll('polygon').forEach((poly) => {
      poly.addEventListener('pointerdown', (e) => {
        if (reshape.isDragging) return;
        const idx = parseInt(poly.getAttribute('data-region-idx'), 10);
        if (Number.isFinite(idx) && idx !== reshape.selectedIdx) {
          // Don't preventDefault — let the browser process the pointer
          // event normally; we just update selection.
          selectReshapeRegion(idx);
        }
      });
    });

    // Vertex handles: only on the selected region.
    const sel = reshape.regions[reshape.selectedIdx];
    if (!sel) {
      reshapeHandlesGEl.innerHTML = '';
      return;
    }
    // Handle radius scales with backdrop and bumps up on coarse pointers
    // (touch). Empirically 22+px tap target is reliable for fingertip drag.
    const touchish = matchMedia && matchMedia('(pointer: coarse)').matches;
    const handleR = touchish
      ? Math.max(20, Math.round(W * 0.022))
      : Math.max(12, Math.round(W * 0.014));

    let handlesHtml = '';
    sel.modified_polygon.forEach((p, vIdx) => {
      const cx = (p.x * W).toFixed(1);
      const cy = (p.y * H).toFixed(1);
      handlesHtml +=
        '<circle class="bpc-reshape-vertex-handle"' +
          ' cx="' + cx + '" cy="' + cy + '" r="' + handleR + '"' +
          ' fill="#fff" stroke="' + sel.color + '" stroke-width="' + Math.max(2, Math.round(W * 0.0022)) + '"' +
          ' data-vertex-idx="' + vIdx + '"' +
          '/>';
    });
    reshapeHandlesGEl.innerHTML = handlesHtml;

    // Wire vertex pointer events
    reshapeHandlesGEl.querySelectorAll('circle').forEach((handle) => {
      handle.addEventListener('pointerdown', onVertexPointerDown);
    });
  }

  function updateReshapeReadout() {
    if (!reshapeReadoutEl) return;
    const html = reshape.regions.map((r, idx) => {
      const newSqft = computeModifiedSqft(r);
      const newLnft = computeModifiedLnft(r);
      const dSqft = newSqft - (r.original_area_sqft || 0);
      const dPctSqft = (r.original_area_sqft || 0) > 0
        ? Math.round((dSqft / r.original_area_sqft) * 100)
        : 0;
      const cls = dSqft > 0 ? 'is-up' : (dSqft < 0 ? 'is-down' : '');
      const isSel = idx === reshape.selectedIdx;
      const isModified = regionWasModified(r);
      const sqftMeta = (r.original_area_sqft || 0) > 0
        ? Number(r.original_area_sqft).toLocaleString('en-US') + ' sqft → ' + newSqft.toLocaleString('en-US') + ' sqft'
        : 'No square footage';
      const lnftMeta = (r.original_area_lnft || 0) > 0
        ? Number(r.original_area_lnft).toLocaleString('en-US') + ' lnft → ' + newLnft.toLocaleString('en-US') + ' lnft'
        : '';
      const deltaLabel = (r.original_area_sqft || 0) > 0
        ? (dSqft > 0 ? '+' : '') + dPctSqft + '%'
        : '—';

      return (
        '<div class="bpc-reshape-readout-row ' + (isSel ? 'is-selected' : '') + '" data-region-idx="' + idx + '">' +
          '<span class="bpc-reshape-readout-dot" style="background:' + r.color + ';"></span>' +
          '<div>' +
            '<div class="bpc-reshape-readout-name">' + escapeHtml(r.name) + '</div>' +
            '<div class="bpc-reshape-readout-meta">' + escapeHtml(sqftMeta) + (lnftMeta ? ' · ' + escapeHtml(lnftMeta) : '') + '</div>' +
          '</div>' +
          '<div>' +
            '<span class="bpc-reshape-readout-delta ' + cls + '">' + deltaLabel + '</span>' +
            '<button type="button" class="bpc-reshape-readout-reset" data-region-idx="' + idx + '"' +
              (isModified ? '' : ' disabled') + '>Reset</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    reshapeReadoutEl.innerHTML = html;

    // Wire row clicks → select region; reset buttons → reset that region
    reshapeReadoutEl.querySelectorAll('.bpc-reshape-readout-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const idx = parseInt(row.getAttribute('data-region-idx'), 10);
        if (Number.isFinite(idx)) selectReshapeRegion(idx);
      });
    });
    reshapeReadoutEl.querySelectorAll('.bpc-reshape-readout-reset').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-region-idx'), 10);
        if (Number.isFinite(idx)) resetReshapeRegion(idx);
      });
    });
  }

  // ── Vertex drag ──────────────────────────────────────────────────────
  function svgPointFromEventReshape(e) {
    const rect = reshapeStageSvgEl.getBoundingClientRect();
    const W = reshape.backdropW;
    const H = reshape.backdropH;
    // viewBox is xMidYMid meet, so figure out the actual rendered area
    // inside the bounding rect (letterboxing).
    const scaleX = rect.width / W;
    const scaleY = rect.height / H;
    const scale = Math.min(scaleX, scaleY);
    const renderedW = W * scale;
    const renderedH = H * scale;
    const offsetX = (rect.width - renderedW) / 2;
    const offsetY = (rect.height - renderedH) / 2;
    const localX = e.clientX - rect.left - offsetX;
    const localY = e.clientY - rect.top - offsetY;
    return {
      x: Math.max(0, Math.min(W, localX / scale)),
      y: Math.max(0, Math.min(H, localY / scale)),
    };
  }

  function onVertexPointerDown(e) {
    const handle = e.currentTarget;
    const vIdx = parseInt(handle.getAttribute('data-vertex-idx'), 10);
    if (!Number.isFinite(vIdx)) return;
    e.preventDefault();
    e.stopPropagation();
    if (handle.setPointerCapture) {
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    }
    handle.classList.add('bpc-reshape-vertex-handle--dragging');
    reshape.isDragging = true;
    reshape.dragRegionIdx = reshape.selectedIdx;
    reshape.dragVertexIdx = vIdx;

    handle.addEventListener('pointermove', onVertexPointerMove);
    handle.addEventListener('pointerup',   onVertexPointerUp);
    handle.addEventListener('pointercancel', onVertexPointerUp);
    handle.addEventListener('lostpointercapture', onVertexPointerUp);
  }

  function onVertexPointerMove(e) {
    if (!reshape.isDragging) return;
    e.preventDefault();
    const region = reshape.regions[reshape.dragRegionIdx];
    if (!region) return;
    const px = svgPointFromEventReshape(e);
    const W = reshape.backdropW;
    const H = reshape.backdropH;
    const fx = px.x / W;
    const fy = px.y / H;
    region.modified_polygon[reshape.dragVertexIdx] = {
      x: Math.max(0, Math.min(1, fx)),
      y: Math.max(0, Math.min(1, fy)),
    };

    // Cheap update — move the polygon points + the dragged handle
    // directly without rebuilding the whole stage. Saves a lot of GC.
    const polyEl = reshapeRegionsGEl.querySelector(
      'polygon[data-region-idx="' + reshape.dragRegionIdx + '"]'
    );
    if (polyEl) {
      const points = region.modified_polygon
        .map(p => (p.x * W).toFixed(1) + ',' + (p.y * H).toFixed(1))
        .join(' ');
      polyEl.setAttribute('points', points);
    }
    const handle = e.currentTarget;
    handle.setAttribute('cx', (region.modified_polygon[reshape.dragVertexIdx].x * W).toFixed(1));
    handle.setAttribute('cy', (region.modified_polygon[reshape.dragVertexIdx].y * H).toFixed(1));

    updateReshapeReadout();
  }

  function onVertexPointerUp(e) {
    if (!reshape.isDragging) return;
    reshape.isDragging = false;
    const handle = e.currentTarget;
    if (handle && handle.classList) {
      handle.classList.remove('bpc-reshape-vertex-handle--dragging');
    }
    if (handle && handle.releasePointerCapture) {
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    if (handle) {
      handle.removeEventListener('pointermove', onVertexPointerMove);
      handle.removeEventListener('pointerup',   onVertexPointerUp);
      handle.removeEventListener('pointercancel', onVertexPointerUp);
      handle.removeEventListener('lostpointercapture', onVertexPointerUp);
    }
    reshape.dragRegionIdx = -1;
    reshape.dragVertexIdx = -1;
    updateReshapeSubmitButton();
  }

  // ── Reset ────────────────────────────────────────────────────────────
  function resetReshapeRegion(idx) {
    const r = reshape.regions[idx];
    if (!r) return;
    if (!regionWasModified(r)) return;
    r.modified_polygon = r.original_polygon.map(p => ({ x: p.x, y: p.y }));
    redrawReshapeStage();
    updateReshapeReadout();
    updateReshapeSubmitButton();
  }

  function resetAllReshape() {
    const anyModified = reshape.regions.some(regionWasModified);
    if (!anyModified) return;
    if (!confirm('Reset all areas back to their original sizes?')) return;
    reshape.regions.forEach((r) => {
      r.modified_polygon = r.original_polygon.map(p => ({ x: p.x, y: p.y }));
    });
    redrawReshapeStage();
    updateReshapeReadout();
    updateReshapeSubmitButton();
  }

  // ── Submit ───────────────────────────────────────────────────────────
  function updateReshapeSubmitButton() {
    if (!reshapeSubmitBtnEl) return;
    const anyModified = reshape.regions.some(regionWasModified);
    reshapeSubmitBtnEl.disabled = !anyModified;
    if (reshapeStatusEl && reshapeStatusEl.classList.contains('bpc-reshape-status--error')) {
      if (anyModified) {
        reshapeStatusEl.textContent = '';
        reshapeStatusEl.classList.remove('bpc-reshape-status--error');
      }
    }
  }

  async function submitReshape() {
    const slug = getSlugFromPath();
    const token = getAuthToken();
    if (!slug || !token) {
      reshapeStatusEl.textContent = 'You need to be signed in to submit. Refresh and try again.';
      reshapeStatusEl.classList.add('bpc-reshape-status--error');
      return;
    }
    const modifiedRegions = reshape.regions
      .filter(regionWasModified)
      .map((r) => ({
        region_id: r.id,
        region_name: r.name,
        color: r.color,
        original_polygon: r.original_polygon,
        modified_polygon: r.modified_polygon,
        original_area_sqft: r.original_area_sqft || 0,
        modified_area_sqft: computeModifiedSqft(r),
        original_area_lnft: r.original_area_lnft || 0,
        modified_area_lnft: computeModifiedLnft(r),
      }));
    if (modifiedRegions.length === 0) {
      reshapeStatusEl.textContent = 'Drag a vertex to resize at least one area before submitting.';
      reshapeStatusEl.classList.add('bpc-reshape-status--error');
      return;
    }

    reshapeSubmitBtnEl.disabled = true;
    reshapeSubmitBtnEl.textContent = 'Sending…';
    reshapeStatusEl.textContent = '';
    reshapeStatusEl.classList.remove('bpc-reshape-status--error', 'bpc-reshape-status--success');

    try {
      const fd = new FormData();
      fd.append('slug', slug);
      fd.append('modified_polygons', JSON.stringify(modifiedRegions));
      const note = (reshapeNoteEl.value || '').trim();
      if (note) fd.append('homeowner_note', note);
      if (reshape.backdropUrl) fd.append('site_map_url', reshape.backdropUrl);
      if (reshape.backdropW)   fd.append('site_map_width',  String(reshape.backdropW));
      if (reshape.backdropH)   fd.append('site_map_height', String(reshape.backdropH));

      const resp = await fetch(API_REDESIGN, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: fd,
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        reshapeStatusEl.textContent = 'Could not send: ' + (result.error || ('HTTP ' + resp.status));
        reshapeStatusEl.classList.add('bpc-reshape-status--error');
        reshapeSubmitBtnEl.disabled = false;
        reshapeSubmitBtnEl.textContent = 'Send to designer';
        return;
      }

      reshapeSubmitBtnEl.textContent = 'Sent ✓';
      reshapeStatusEl.textContent = result.email_sent
        ? 'Sent to your designer. They\'ll review your requested sizes and follow up.'
        : 'Submitted. Your designer will see this in the queue.';
      reshapeStatusEl.classList.add('bpc-reshape-status--success');

      // Auto-close. Pre-clear so confirm() doesn't fire on close.
      setTimeout(() => {
        reshape.regions.forEach((r) => {
          r.modified_polygon = r.original_polygon.map(p => ({ x: p.x, y: p.y }));
        });
        if (reshapeNoteEl) reshapeNoteEl.value = '';
        closeReshapeOverlay();
      }, 2500);

    } catch (err) {
      reshapeStatusEl.textContent = 'Network error: ' + (err && err.message || 'unknown');
      reshapeStatusEl.classList.add('bpc-reshape-status--error');
      reshapeSubmitBtnEl.disabled = false;
      reshapeSubmitBtnEl.textContent = 'Send to designer';
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    renderFab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
