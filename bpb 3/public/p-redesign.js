// ═══════════════════════════════════════════════════════════════════════════
// /p-redesign.js — Phase 6 Sprint 2 (client redesign autonomy)
//
// Loaded by p-customize.js when the customize feature is enabled (i.e., the
// caller is the authenticated homeowner of this proposal). Adds two entry
// points to the proposal page:
//
//   1. Floating CTA at bottom-right: "Suggest changes" + "Print for markup"
//   2. "Suggest changes" → fullscreen overlay with:
//        - Site map image as backdrop
//        - SVG drawing layer (pencil, 3 colors, undo, clear)
//        - Photo upload alternative (canvas-converted to JPEG for HEIC robustness)
//        - Note textarea
//        - Submit → POST /api/submit-redesign
//   3. "Print for markup" → window.print() with @media print rules that
//      hide everything except the site map area
//
// Strokes are stored as {color, points:[{x,y}]} relative to the site map's
// natural pixel dimensions. On submit they're serialized to a clean SVG
// string that the admin queue renders directly via dangerouslySetInnerHTML
// equivalent (innerHTML of a sanitized container).
//
// HEIC handling: createImageBitmap(file) → canvas → toBlob('image/jpeg').
// Safari handles HEIC natively at the createImageBitmap step.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (window.__bpcRedesignLoaded) return;
  window.__bpcRedesignLoaded = true;

  const API_REDESIGN = '/api/submit-redesign';

  // Drawing state
  const draw = {
    strokes: [],          // [{color, points:[{x,y}]}]
    currentColor: '#dc2626',
    currentStroke: null,  // active stroke during pointerdown→up
    isDrawing: false,
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
    fab.innerHTML =
      '<button type="button" class="bpc-redesign-fab-btn" data-action="suggest">✏️ Suggest changes</button>' +
      '<button type="button" class="bpc-redesign-fab-btn--secondary" data-action="print">🖨 Print for markup</button>';
    document.body.appendChild(fab);
    fab.querySelector('[data-action="suggest"]').addEventListener('click', openOverlay);
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
