/**
 * BPB Phase 1A — Site Map Editor (admin JS module)
 *
 * Responsibilities:
 *   - Load backdrop image and existing regions for a proposal
 *   - Polygon drawing: click to add vertex, double-click to close, ESC to cancel
 *   - Polygon editing: click to select, drag vertex to move, right-click vertex to delete
 *   - Side panel: name + sqft + lnft per region, "Save All" persists everything
 *
 * Coordinate system:
 *   - Polygon vertices are stored as {x, y} fractions in [0..1] of backdrop dimensions
 *   - The canvas renders at the backdrop's native pixel dimensions
 *   - Mouse events are translated from canvas pixels to fractions before storage
 *
 * Per Principle 2 (simplicity): no zoom, no pan, no undo/redo in v1.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  proposalId: null,
  backdrop: null,            // { url, width, height } or null
  backdropImg: null,         // HTMLImageElement
  regions: [],               // [{ id?, name, polygon:[{x,y}], area_sqft, area_lnft, display_order, _color }]
  selectedRegionIdx: -1,
  draftPolygon: null,        // { points:[{x,y}] } during draw mode, null otherwise
  drag: null,                // { regionIdx, vertexIdx } during vertex drag
  hoveredVertex: null,       // { regionIdx, vertexIdx } for visual feedback
};

// Distinct colors for region overlays — cycled by region index
const REGION_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
  '#a855f7', '#f43f5e',
];
function colorForIndex(i) { return REGION_COLORS[i % REGION_COLORS.length]; }

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const els = {
  canvas: document.getElementById('sm-canvas'),
  canvasInner: document.getElementById('sm-canvas-inner'),
  empty: document.getElementById('sm-empty'),
  status: document.getElementById('sm-status'),
  proposalLabel: document.getElementById('sm-proposal-label'),
  btnUpload: document.getElementById('sm-btn-upload'),
  btnSave: document.getElementById('sm-btn-save'),
  btnAddRegion: document.getElementById('sm-btn-add-region'),
  fileInput: document.getElementById('sm-file-input'),
  sideList: document.getElementById('sm-side-list'),
  regionCount: document.getElementById('sm-region-count'),
  toastWrap: document.getElementById('sm-toast-wrap'),
  modalBackdrop: document.getElementById('sm-modal-backdrop'),
  modalInput: document.getElementById('sm-modal-input'),
  modalOk: document.getElementById('sm-modal-ok'),
};
const ctx = els.canvas.getContext('2d');

// ---------------------------------------------------------------------------
// Toast helpers
// ---------------------------------------------------------------------------
function toast(message, kind = 'info', durationMs = 3000) {
  const el = document.createElement('div');
  el.className = `sm-toast sm-toast-${kind}`;
  el.textContent = message;
  els.toastWrap.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------
async function apiGetRegions(proposalId) {
  const r = await fetch(`/api/site-map-regions?proposal_id=${proposalId}`);
  if (!r.ok) throw new Error(`GET regions failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function apiSaveRegions(proposalId, regions) {
  // Strip the local-only _color field before sending
  const cleaned = regions.map(({ _color, ...r }) => r);
  const r = await fetch('/api/site-map-regions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal_id: proposalId, regions: cleaned }),
  });
  if (!r.ok) throw new Error(`Save failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function apiUploadBackdrop(proposalId, file) {
  const fd = new FormData();
  fd.append('proposal_id', proposalId);
  fd.append('file', file);
  const r = await fetch('/api/site-map-backdrop-upload', {
    method: 'POST',
    body: fd,
  });
  if (!r.ok) throw new Error(`Upload failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Backdrop loading
// ---------------------------------------------------------------------------
function loadBackdropImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Image load failed: ' + url));
    img.src = url;
  });
}

async function setBackdrop(backdrop) {
  if (!backdrop || !backdrop.site_plan_backdrop_url) {
    state.backdrop = null;
    state.backdropImg = null;
    els.empty.style.display = 'flex';
    els.canvasInner.style.display = 'none';
    return;
  }
  state.backdrop = {
    url: backdrop.site_plan_backdrop_url,
    width: backdrop.site_plan_backdrop_width,
    height: backdrop.site_plan_backdrop_height,
  };
  state.backdropImg = await loadBackdropImage(state.backdrop.url);

  // Size canvas to native dimensions
  els.canvas.width = state.backdrop.width;
  els.canvas.height = state.backdrop.height;
  els.empty.style.display = 'none';
  els.canvasInner.style.display = 'block';
  redraw();
}

// ---------------------------------------------------------------------------
// Coordinate translation: canvas pixels ↔ fractional [0..1]
// ---------------------------------------------------------------------------
function eventToCanvasPx(e) {
  const rect = els.canvas.getBoundingClientRect();
  const scaleX = els.canvas.width / rect.width;
  const scaleY = els.canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}
function pxToFrac(px) {
  return { x: px.x / els.canvas.width, y: px.y / els.canvas.height };
}
function fracToPx(frac) {
  return { x: frac.x * els.canvas.width, y: frac.y * els.canvas.height };
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------
const VERTEX_RADIUS_PX = 8;

/** Returns { regionIdx, vertexIdx } if the canvas-pixel point is on a vertex, else null. */
function hitTestVertex(px) {
  for (let ri = state.regions.length - 1; ri >= 0; ri--) {
    const r = state.regions[ri];
    for (let vi = 0; vi < r.polygon.length; vi++) {
      const vpx = fracToPx(r.polygon[vi]);
      const dx = vpx.x - px.x, dy = vpx.y - px.y;
      if (dx * dx + dy * dy <= VERTEX_RADIUS_PX * VERTEX_RADIUS_PX) {
        return { regionIdx: ri, vertexIdx: vi };
      }
    }
  }
  return null;
}

/** Returns regionIdx if the canvas-pixel point is inside any polygon, else -1.
 *  Iterates topmost (last in array) first so click selects the topmost polygon. */
function hitTestPolygon(px) {
  for (let ri = state.regions.length - 1; ri >= 0; ri--) {
    if (pointInPolygon(px, state.regions[ri].polygon)) return ri;
  }
  return -1;
}

/** Ray-casting point-in-polygon. polygon is array of {x,y} fractions. */
function pointInPolygon(px, polygon) {
  const x = px.x, y = px.y;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = fracToPx(polygon[i]);
    const pj = fracToPx(polygon[j]);
    const intersect =
      pi.y > y !== pj.y > y &&
      x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function redraw() {
  if (!state.backdropImg) return;
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.drawImage(state.backdropImg, 0, 0, els.canvas.width, els.canvas.height);

  // Draw committed polygons
  for (let i = 0; i < state.regions.length; i++) {
    drawPolygon(state.regions[i], i, i === state.selectedRegionIdx);
  }

  // Draw draft polygon
  if (state.draftPolygon && state.draftPolygon.points.length > 0) {
    drawDraft(state.draftPolygon);
  }
}

function drawPolygon(region, idx, isSelected) {
  const color = region._color || colorForIndex(idx);
  const pts = region.polygon;
  if (pts.length === 0) return;

  ctx.save();
  ctx.beginPath();
  const start = fracToPx(pts[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();

  // Fill (translucent)
  ctx.fillStyle = hexToRgba(color, isSelected ? 0.35 : 0.20);
  ctx.fill();

  // Stroke
  ctx.lineWidth = isSelected ? 3 : 2;
  ctx.strokeStyle = color;
  ctx.stroke();

  // Vertices (only visible when selected, to keep canvas clean)
  if (isSelected) {
    for (let i = 0; i < pts.length; i++) {
      const p = fracToPx(pts[i]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, VERTEX_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  // Label (region name + index badge near centroid)
  const c = polygonCentroidPx(pts);
  const label = `${idx + 1}. ${region.name || '(unnamed)'}`;
  ctx.font = 'bold 14px DM Sans, sans-serif';
  const metrics = ctx.measureText(label);
  const padding = 6;
  const labelW = metrics.width + padding * 2;
  const labelH = 22;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(c.x - labelW / 2, c.y - labelH / 2, labelW, labelH);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.strokeRect(c.x - labelW / 2, c.y - labelH / 2, labelW, labelH);
  ctx.fillStyle = '#1a1f2e';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, c.x, c.y);

  ctx.restore();
}

function drawDraft(draft) {
  const pts = draft.points;
  ctx.save();
  ctx.beginPath();
  const start = fracToPx(pts[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1a1f2e';
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 0; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#10b981' : '#1a1f2e';
    ctx.fill();
  }
  ctx.restore();
}

function polygonCentroidPx(pts) {
  // Simple average of vertices in canvas pixels — good enough for label placement
  let sx = 0, sy = 0;
  for (const p of pts) {
    const px = fracToPx(p);
    sx += px.x; sy += px.y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

function hexToRgba(hex, a) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return `rgba(0,0,0,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------------------------------------------------------------------------
// Mouse / keyboard handlers
// ---------------------------------------------------------------------------
els.canvas.addEventListener('click', (e) => {
  if (!state.backdropImg) return;
  const px = eventToCanvasPx(e);

  // If we're drawing, add a vertex (but ignore if we just closed via dblclick)
  if (state.draftPolygon) {
    state.draftPolygon.points.push(pxToFrac(px));
    redraw();
    return;
  }

  // Not drawing — try to select an existing polygon
  const ri = hitTestPolygon(px);
  if (ri !== -1) {
    selectRegion(ri);
  } else {
    selectRegion(-1);
    // Clicking empty canvas starts a new draft polygon
    state.draftPolygon = { points: [pxToFrac(px)] };
    setStatus('Drawing — click to add vertices, double-click to close, Esc to cancel');
    redraw();
  }
});

els.canvas.addEventListener('dblclick', (e) => {
  if (!state.draftPolygon) return;
  // Remove the duplicate vertex from the click that preceded the dblclick
  if (state.draftPolygon.points.length >= 2) {
    state.draftPolygon.points.pop();
  }
  if (state.draftPolygon.points.length < 3) {
    toast('Polygon needs at least 3 vertices', 'error');
    state.draftPolygon = null;
    setStatus('Click to start drawing a polygon');
    redraw();
    return;
  }
  // Commit the draft as a new region
  const newRegion = {
    name: `Region ${state.regions.length + 1}`,
    polygon: state.draftPolygon.points.slice(),
    area_sqft: null,
    area_lnft: null,
    display_order: state.regions.length,
    _color: colorForIndex(state.regions.length),
  };
  state.regions.push(newRegion);
  state.draftPolygon = null;
  selectRegion(state.regions.length - 1);
  setStatus(`Polygon committed. ${state.regions.length} region(s).`);
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
});

els.canvas.addEventListener('mousedown', (e) => {
  if (state.draftPolygon) return;  // ignore drag during draft
  if (state.selectedRegionIdx === -1) return;
  const px = eventToCanvasPx(e);
  const hit = hitTestVertex(px);
  if (hit && hit.regionIdx === state.selectedRegionIdx) {
    state.drag = hit;
    els.canvas.classList.add('sm-cursor-grabbing');
    e.preventDefault();
  }
});

els.canvas.addEventListener('mousemove', (e) => {
  if (state.drag) {
    const px = eventToCanvasPx(e);
    const frac = pxToFrac(px);
    const r = state.regions[state.drag.regionIdx];
    r.polygon[state.drag.vertexIdx] = {
      x: Math.max(0, Math.min(1, frac.x)),
      y: Math.max(0, Math.min(1, frac.y)),
    };
    redraw();
    els.btnSave.disabled = false;
  }
});

window.addEventListener('mouseup', () => {
  if (state.drag) {
    state.drag = null;
    els.canvas.classList.remove('sm-cursor-grabbing');
  }
});

els.canvas.addEventListener('contextmenu', (e) => {
  // Right-click a vertex to delete it
  e.preventDefault();
  if (state.selectedRegionIdx === -1) return;
  const px = eventToCanvasPx(e);
  const hit = hitTestVertex(px);
  if (!hit || hit.regionIdx !== state.selectedRegionIdx) return;
  const r = state.regions[hit.regionIdx];
  if (r.polygon.length <= 3) {
    toast('Polygon must have at least 3 vertices', 'error');
    return;
  }
  r.polygon.splice(hit.vertexIdx, 1);
  redraw();
  els.btnSave.disabled = false;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.draftPolygon) {
    state.draftPolygon = null;
    setStatus('Drawing cancelled');
    redraw();
  }
});

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
function refreshSidePanel() {
  els.regionCount.textContent = state.regions.length;
  els.sideList.innerHTML = '';
  state.regions.forEach((r, idx) => {
    const card = document.createElement('div');
    card.className = 'sm-region-card' + (idx === state.selectedRegionIdx ? ' sm-selected' : '');
    card.dataset.idx = idx;

    card.innerHTML = `
      <div class="sm-region-card-row">
        <div class="sm-region-swatch" style="background:${r._color || colorForIndex(idx)};"></div>
        <input type="text" class="sm-input-name" placeholder="Region name" value="${escapeHtml(r.name || '')}" />
      </div>
      <div class="sm-region-card-fields">
        <div>
          <label>SQFT</label>
          <input type="number" class="sm-input-sqft" placeholder="0" min="0" step="0.01" value="${r.area_sqft ?? ''}" />
        </div>
        <div>
          <label>LNFT</label>
          <input type="number" class="sm-input-lnft" placeholder="0" min="0" step="0.01" value="${r.area_lnft ?? ''}" />
        </div>
      </div>
      <div class="sm-region-card-actions">
        <button class="sm-btn sm-btn-danger sm-btn-delete">Delete</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      // Don't re-select if user clicked an input
      if (e.target.tagName !== 'INPUT' && !e.target.classList.contains('sm-btn-delete')) {
        selectRegion(idx);
      }
    });

    card.querySelector('.sm-input-name').addEventListener('input', (e) => {
      r.name = e.target.value;
      redraw();
      els.btnSave.disabled = false;
    });
    card.querySelector('.sm-input-sqft').addEventListener('input', (e) => {
      const v = e.target.value === '' ? null : parseFloat(e.target.value);
      r.area_sqft = isNaN(v) ? null : v;
      els.btnSave.disabled = false;
    });
    card.querySelector('.sm-input-lnft').addEventListener('input', (e) => {
      const v = e.target.value === '' ? null : parseFloat(e.target.value);
      r.area_lnft = isNaN(v) ? null : v;
      els.btnSave.disabled = false;
    });
    card.querySelector('.sm-btn-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete region "${r.name}"?`)) return;
      state.regions.splice(idx, 1);
      // Reassign display_order so they're sequential
      state.regions.forEach((r, i) => { r.display_order = i; r._color = colorForIndex(i); });
      if (state.selectedRegionIdx === idx) state.selectedRegionIdx = -1;
      else if (state.selectedRegionIdx > idx) state.selectedRegionIdx--;
      refreshSidePanel();
      redraw();
      els.btnSave.disabled = false;
    });

    els.sideList.appendChild(card);
  });
}

function selectRegion(idx) {
  state.selectedRegionIdx = idx;
  refreshSidePanel();
  redraw();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setStatus(msg) {
  els.status.textContent = msg;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
els.btnSave.addEventListener('click', async () => {
  if (state.draftPolygon) {
    toast('Finish drawing the current polygon first (double-click to close, Esc to cancel)', 'error');
    return;
  }
  els.btnSave.disabled = true;
  els.btnSave.textContent = 'Saving…';
  try {
    const result = await apiSaveRegions(state.proposalId, state.regions);
    // Refresh state with the server's authoritative version (gives us new ids)
    state.regions = result.regions.map((r, i) => ({
      ...r,
      _color: colorForIndex(i),
    }));
    refreshSidePanel();
    redraw();
    toast(`Saved. ${result.stats.inserted} new, ${result.stats.updated} updated, ${result.stats.deleted} removed.`, 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error', 6000);
    els.btnSave.disabled = false;
  } finally {
    els.btnSave.textContent = 'Save All';
  }
});

// ---------------------------------------------------------------------------
// Upload backdrop
// ---------------------------------------------------------------------------
els.btnUpload.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    toast('File must be PNG or JPEG', 'error');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    toast('File exceeds 10MB', 'error');
    return;
  }
  try {
    toast('Uploading backdrop…', 'info', 2000);
    const result = await apiUploadBackdrop(state.proposalId, file);
    await setBackdrop({
      site_plan_backdrop_url: result.url,
      site_plan_backdrop_width: result.width,
      site_plan_backdrop_height: result.height,
    });
    toast(`Backdrop uploaded (${result.width}×${result.height})`, 'success');
  } catch (err) {
    toast('Upload failed: ' + err.message, 'error', 6000);
  } finally {
    e.target.value = '';
  }
});

// ---------------------------------------------------------------------------
// "+ New polygon" button (alternative to clicking empty canvas)
// ---------------------------------------------------------------------------
els.btnAddRegion.addEventListener('click', () => {
  if (!state.backdropImg) {
    toast('Upload a backdrop first', 'error');
    return;
  }
  selectRegion(-1);
  state.draftPolygon = { points: [] };
  setStatus('Click on the canvas to add the first vertex');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // Get proposal_id from URL or prompt
  const url = new URL(window.location.href);
  let proposalId = url.searchParams.get('proposal_id');
  if (!proposalId) {
    proposalId = await promptForProposalId();
    if (!proposalId) return;
    // Update URL without reload so refresh works
    url.searchParams.set('proposal_id', proposalId);
    window.history.replaceState({}, '', url);
  }
  state.proposalId = proposalId;
  els.proposalLabel.textContent = `Proposal: ${proposalId}`;

  try {
    const data = await apiGetRegions(proposalId);
    state.regions = (data.regions || []).map((r, i) => ({
      ...r,
      _color: colorForIndex(i),
    }));
    await setBackdrop(data.backdrop);
    refreshSidePanel();
    if (state.regions.length > 0) {
      setStatus(`${state.regions.length} region(s) loaded.`);
    }
  } catch (err) {
    toast('Failed to load: ' + err.message, 'error', 6000);
  }
}

function promptForProposalId() {
  return new Promise((resolve) => {
    els.modalBackdrop.style.display = 'flex';
    els.modalInput.focus();
    const submit = () => {
      const v = els.modalInput.value.trim();
      if (!v) return;
      els.modalBackdrop.style.display = 'none';
      resolve(v);
    };
    els.modalOk.addEventListener('click', submit, { once: true });
    els.modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    }, { once: true });
  });
}

boot();
