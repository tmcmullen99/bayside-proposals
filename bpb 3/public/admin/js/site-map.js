/**
 * BPB Phase 1A — Site Map Editor (admin JS module)
 *
 * Responsibilities:
 *   - Load backdrop image and existing regions for a proposal
 *   - Polygon drawing: click to add vertex, double-click to close, ESC to cancel
 *   - Polygon editing: click to select, drag vertex to move, right-click vertex to delete
 *   - Side panel: name + sqft + lnft + section + materials per region, "Save All" persists everything
 *
 * Coordinate system:
 *   - Polygon vertices are stored as {x, y} fractions in [0..1] of backdrop dimensions
 *   - The canvas renders at the backdrop's native pixel dimensions
 *   - Mouse events are translated from canvas pixels to fractions before storage
 *
 * Per Principle 2 (simplicity): no zoom, no pan in v1.
 *
 * Phase 1B.3 additions:
 *   - state.materials holds the proposal's materials with embedded catalog rows
 *     (Belgard / third-party) for picker display.
 *   - each region carries a `materials: [{proposal_material_id, display_order}]`
 *     array reflecting proposal_region_materials assignments.
 *   - Each region card shows a togglable pill list of all proposal materials.
 *     Click a pill to add/remove from the region's set; order = pick order.
 *   - Snapshot wiring: pushUndoSnapshot('toggle material') before each pill click
 *     so Cmd+Z reverses one click per stroke.
 *
 * Phase 4.1 Sprint A: McMullen palette → Bayside palette for non-region UI.
 *   - Polygon name label fill: #1a1f2e → #353535 (charcoal)
 *   - Edge-insert "+" indicator stroke: #10b981 → #5d7e69 (Bayside green)
 *   - Draft polygon first-vertex marker: #10b981 → #5d7e69 (Bayside green)
 *   - REGION_COLORS array intentionally unchanged (functional polygon hues)
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  proposalId: null,
  backdrop: null,            // { url, width, height } or null
  backdropImg: null,         // HTMLImageElement
  regions: [],               // [{ id?, name, polygon:[{x,y}], area_sqft, area_lnft, display_order, proposal_section_id, materials:[{proposal_material_id, display_order}], _color }]
  selectedRegionIdx: -1,
  draftPolygon: null,        // { points:[{x,y}] } during draw mode, null otherwise
  drag: null,                // { regionIdx, vertexIdx } during vertex drag
  hoveredVertex: null,       // { regionIdx, vertexIdx } for visual feedback
  cursorPx: null,            // { x, y } current mouse position in canvas px (for rubber-band preview during draft)
  polygonDrag: null,         // { regionIdx, lastFrac:{x,y} } when dragging an entire polygon by its interior
  hoveredEdge: null,         // { regionIdx, edgeIdx, point:{x,y frac} } when cursor is over an edge of the selected polygon
  sections: [],              // [{ id, name, display_order }] — proposal's bid sections (Phase 1B click-to-link target)
  materials: [],             // [{ id, material_source, belgard_material:{...}|null, third_party_material:{...}|null, ... }] — Phase 1B.3 multi-material picker source
};

// Distinct colors for region overlays — cycled by region index
const REGION_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
  '#a855f7', '#f43f5e',
];
function colorForIndex(i) { return REGION_COLORS[i % REGION_COLORS.length]; }

// ---------------------------------------------------------------------------
// Undo / Redo stack
//
// We snapshot state.regions at every discrete user action. The snapshot is a
// deep-cloned regions array (JSON round-trip — they're plain {x,y,name,...}
// objects, no class instances or circular refs).
//
// Stack model:
//   - past: snapshots BEFORE recent actions (oldest first). Bounded to UNDO_LIMIT.
//   - future: snapshots AFTER actions that have been undone. Cleared on any
//     fresh action (you can't redo after a new edit — same as VS Code, Figma).
//
// pushUndoSnapshot(label) is called at every commit point: vertex placed,
// polygon closed, vertex/polygon drag finished, vertex/polygon/region deleted,
// region renamed, sqft/lnft edited (debounced), edge insert, polygon translate,
// section change, material toggle.
// Save All does NOT push a snapshot (it's not a state change, just persistence).
//
// Saves don't clear the stack — Tim can save, then undo, then save again. The
// CF Function bulk-upserts whatever's currently in state.regions, so next save
// just persists the post-undo state.
// ---------------------------------------------------------------------------
const UNDO_LIMIT = 50;
const undoStack = {
  past: [],   // [{ regions: [...], label: '...' }]  oldest first
  future: [], // [{ regions: [...], label: '...' }]  newest first (top-of-stack semantics)
};

/** Deep-clone the regions array. JSON round-trip is safe — no class instances. */
function cloneRegions() {
  return JSON.parse(JSON.stringify(state.regions));
}

/** Push the CURRENT state onto the undo stack, then clear the redo stack.
 *  Call BEFORE mutating state, so that undo can restore the pre-mutation snapshot.
 *  `label` is for status-bar feedback during undo/redo. */
function pushUndoSnapshot(label) {
  undoStack.past.push({ regions: cloneRegions(), label });
  if (undoStack.past.length > UNDO_LIMIT) {
    undoStack.past.shift();  // drop oldest
  }
  undoStack.future = [];  // any fresh edit invalidates redo history
}

/** Undo the most recent action. */
function undo() {
  if (undoStack.past.length === 0) {
    setStatus('Nothing to undo');
    return;
  }
  const currentLabel = undoStack.past[undoStack.past.length - 1].label;
  undoStack.future.push({ regions: cloneRegions(), label: currentLabel });
  const prev = undoStack.past.pop();
  state.regions = prev.regions;
  if (state.selectedRegionIdx >= state.regions.length) {
    state.selectedRegionIdx = -1;
  }
  state.draftPolygon = null;
  state.cursorPx = null;
  state.drag = null;
  state.polygonDrag = null;
  state.hoveredEdge = null;
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
  setStatus(`Undid: ${currentLabel}`);
}

/** Redo the most recently undone action. */
function redo() {
  if (undoStack.future.length === 0) {
    setStatus('Nothing to redo');
    return;
  }
  const next = undoStack.future.pop();
  undoStack.past.push({ regions: cloneRegions(), label: next.label });
  state.regions = next.regions;
  if (state.selectedRegionIdx >= state.regions.length) {
    state.selectedRegionIdx = -1;
  }
  state.draftPolygon = null;
  state.cursorPx = null;
  state.drag = null;
  state.polygonDrag = null;
  state.hoveredEdge = null;
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
  setStatus(`Redid: ${next.label}`);
}

/** Reset the undo stack — called once after a successful initial regions load.
 *  Without this, the very first edit would have an undo target of "empty regions",
 *  which would make Cmd+Z look like it deleted everything Tim just had loaded. */
function resetUndoStack() {
  undoStack.past = [];
  undoStack.future = [];
}

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
  // Strip the local-only _color field before sending. Everything else
  // (including Phase 1B.3 `materials` array) rides through unchanged so
  // the CF Function can reconcile proposal_region_materials.
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

/** Returns { regionIdx, edgeIdx, point:{x,y fractional} } if the canvas-pixel
 *  point is within EDGE_HIT_TOLERANCE_PX of any edge of the SELECTED polygon
 *  (only — checking all polygons would conflict with interior-drag and vertex-drag).
 *  edgeIdx is the index of the vertex BEFORE the edge (edge runs from vertex
 *  edgeIdx to edgeIdx+1, with wraparound). point is where the new vertex would
 *  be inserted (the foot of perpendicular from cursor to edge, clamped to segment). */
const EDGE_HIT_TOLERANCE_PX = 8;
function hitTestEdge(px) {
  if (state.selectedRegionIdx === -1) return null;
  const r = state.regions[state.selectedRegionIdx];
  const poly = r.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = fracToPx(poly[i]);
    const b = fracToPx(poly[(i + 1) % poly.length]);
    const foot = pointOnSegment(px, a, b);
    if (!foot) continue;
    const dx = foot.x - px.x, dy = foot.y - px.y;
    if (dx * dx + dy * dy <= EDGE_HIT_TOLERANCE_PX * EDGE_HIT_TOLERANCE_PX) {
      return {
        regionIdx: state.selectedRegionIdx,
        edgeIdx: i,
        point: pxToFrac(foot),
      };
    }
  }
  return null;
}

/** Foot of perpendicular from p to segment [a,b], clamped to the segment. */
function pointOnSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return null;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * abx, y: a.y + t * aby };
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

  for (let i = 0; i < state.regions.length; i++) {
    drawPolygon(state.regions[i], i, i === state.selectedRegionIdx);
  }

  // Edge-insert indicator: a "+" at the cursor's foot-of-perpendicular on the
  // hovered edge of the selected polygon, signalling "click here to insert vertex"
  if (state.hoveredEdge && !state.draftPolygon && !state.drag && !state.polygonDrag) {
    const px = fracToPx(state.hoveredEdge.point);
    ctx.save();
    ctx.beginPath();
    ctx.arc(px.x, px.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#5d7e69';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px.x - 4, px.y);
    ctx.lineTo(px.x + 4, px.y);
    ctx.moveTo(px.x, px.y - 4);
    ctx.lineTo(px.x, px.y + 4);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#5d7e69';
    ctx.stroke();
    ctx.restore();
  }

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

  ctx.fillStyle = hexToRgba(color, isSelected ? 0.35 : 0.20);
  ctx.fill();

  ctx.lineWidth = isSelected ? 3 : 2;
  ctx.strokeStyle = color;
  ctx.stroke();

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
  ctx.fillStyle = '#353535';
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

  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();

  ctx.lineWidth = 4;
  ctx.strokeStyle = '#dc2626';
  ctx.setLineDash([12, 6]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (state.cursorPx && pts.length > 0) {
    const lastPx = fracToPx(pts[pts.length - 1]);
    ctx.beginPath();
    ctx.moveTo(lastPx.x, lastPx.y);
    ctx.lineTo(state.cursorPx.x, state.cursorPx.y);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.6)';
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = 0; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = i === 0 ? '#5d7e69' : '#dc2626';
    ctx.stroke();
  }
  ctx.restore();
}

function polygonCentroidPx(pts) {
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

let DRAG_SUPPRESSES_CLICK = false;

els.canvas.addEventListener('mousedown', (e) => {
  if (!state.backdropImg) return;
  if (state.draftPolygon) return;

  const px = eventToCanvasPx(e);

  if (state.selectedRegionIdx !== -1) {
    const hitV = hitTestVertex(px);
    if (hitV && hitV.regionIdx === state.selectedRegionIdx) {
      pushUndoSnapshot('move vertex');
      state.drag = hitV;
      els.canvas.classList.add('sm-cursor-grabbing');
      DRAG_SUPPRESSES_CLICK = true;
      e.preventDefault();
      return;
    }

    const hitE = hitTestEdge(px);
    if (hitE) {
      pushUndoSnapshot('insert vertex');
      const r = state.regions[hitE.regionIdx];
      const insertAt = hitE.edgeIdx + 1;
      r.polygon.splice(insertAt, 0, hitE.point);
      state.drag = { regionIdx: hitE.regionIdx, vertexIdx: insertAt };
      state.hoveredEdge = null;
      els.canvas.classList.add('sm-cursor-grabbing');
      DRAG_SUPPRESSES_CLICK = true;
      els.btnSave.disabled = false;
      redraw();
      e.preventDefault();
      return;
    }

    if (pointInPolygon(px, state.regions[state.selectedRegionIdx].polygon)) {
      pushUndoSnapshot('move polygon');
      state.polygonDrag = {
        regionIdx: state.selectedRegionIdx,
        lastFrac: pxToFrac(px),
      };
      els.canvas.classList.add('sm-cursor-grabbing');
      DRAG_SUPPRESSES_CLICK = true;
      e.preventDefault();
      return;
    }
  }
});

els.canvas.addEventListener('mousemove', (e) => {
  if (!state.backdropImg) return;
  const px = eventToCanvasPx(e);

  if (state.drag) {
    const frac = pxToFrac(px);
    const r = state.regions[state.drag.regionIdx];
    r.polygon[state.drag.vertexIdx] = {
      x: Math.max(0, Math.min(1, frac.x)),
      y: Math.max(0, Math.min(1, frac.y)),
    };
    redraw();
    els.btnSave.disabled = false;
    return;
  }

  if (state.polygonDrag) {
    const curFrac = pxToFrac(px);
    const dx = curFrac.x - state.polygonDrag.lastFrac.x;
    const dy = curFrac.y - state.polygonDrag.lastFrac.y;
    const r = state.regions[state.polygonDrag.regionIdx];
    for (const v of r.polygon) {
      v.x = Math.max(0, Math.min(1, v.x + dx));
      v.y = Math.max(0, Math.min(1, v.y + dy));
    }
    state.polygonDrag.lastFrac = curFrac;
    redraw();
    els.btnSave.disabled = false;
    return;
  }

  if (state.draftPolygon) {
    state.cursorPx = px;
    redraw();
    return;
  }

  if (state.selectedRegionIdx !== -1) {
    const hitV = hitTestVertex(px);
    const newHoveredEdge = hitV ? null : hitTestEdge(px);
    const changed =
      (newHoveredEdge === null) !== (state.hoveredEdge === null) ||
      (newHoveredEdge && state.hoveredEdge && newHoveredEdge.edgeIdx !== state.hoveredEdge.edgeIdx);
    state.hoveredEdge = newHoveredEdge;
    if (changed) redraw();
  } else if (state.hoveredEdge) {
    state.hoveredEdge = null;
    redraw();
  }
});

window.addEventListener('mouseup', () => {
  let wasDragging = false;
  if (state.drag) {
    state.drag = null;
    wasDragging = true;
  }
  if (state.polygonDrag) {
    state.polygonDrag = null;
    wasDragging = true;
  }
  if (wasDragging) {
    els.canvas.classList.remove('sm-cursor-grabbing');
  }
});

els.canvas.addEventListener('click', (e) => {
  if (!state.backdropImg) return;

  if (DRAG_SUPPRESSES_CLICK) {
    DRAG_SUPPRESSES_CLICK = false;
    return;
  }

  const px = eventToCanvasPx(e);

  if (state.draftPolygon) {
    state.draftPolygon.points.push(pxToFrac(px));
    redraw();
    return;
  }

  const ri = hitTestPolygon(px);
  if (ri !== -1) {
    selectRegion(ri);
  } else {
    selectRegion(-1);
    state.draftPolygon = { points: [pxToFrac(px)] };
    state.cursorPx = px;
    setStatus('Drawing — click to add vertices, double-click to close, Esc to cancel');
    redraw();
  }
});

els.canvas.addEventListener('dblclick', (e) => {
  if (!state.draftPolygon) return;
  if (state.draftPolygon.points.length >= 2) {
    state.draftPolygon.points.pop();
  }
  if (state.draftPolygon.points.length < 3) {
    toast('Polygon needs at least 3 vertices', 'error');
    state.draftPolygon = null;
    state.cursorPx = null;
    setStatus('Click to start drawing a polygon');
    redraw();
    return;
  }
  pushUndoSnapshot('add polygon');
  const newRegion = {
    name: `Region ${state.regions.length + 1}`,
    polygon: state.draftPolygon.points.slice(),
    area_sqft: null,
    area_lnft: null,
    display_order: state.regions.length,
    materials: [],
    _color: colorForIndex(state.regions.length),
  };
  state.regions.push(newRegion);
  state.draftPolygon = null;
  state.cursorPx = null;
  selectRegion(state.regions.length - 1);
  setStatus(`Polygon committed. ${state.regions.length} region(s).`);
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
});

els.canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.selectedRegionIdx === -1) return;
  const px = eventToCanvasPx(e);
  const hit = hitTestVertex(px);
  if (!hit || hit.regionIdx !== state.selectedRegionIdx) return;
  const r = state.regions[hit.regionIdx];
  if (r.polygon.length <= 3) {
    toast('Polygon must have at least 3 vertices — delete the whole region instead', 'error');
    return;
  }
  pushUndoSnapshot('delete vertex');
  r.polygon.splice(hit.vertexIdx, 1);
  redraw();
  els.btnSave.disabled = false;
});

els.canvas.addEventListener('mouseleave', () => {
  if (state.hoveredEdge) {
    state.hoveredEdge = null;
    redraw();
  }
  if (state.cursorPx && state.draftPolygon) {
    state.cursorPx = null;
    redraw();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    if (document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA'
    )) {
      return;
    }
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else {
      undo();
    }
    return;
  }
  if (e.key === 'Escape' && state.draftPolygon) {
    state.draftPolygon = null;
    state.cursorPx = null;
    setStatus('Drawing cancelled');
    redraw();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedRegionIdx !== -1) {
    if (document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA'
    )) {
      return;
    }
    e.preventDefault();
    deleteRegion(state.selectedRegionIdx);
  }
});

function deleteRegion(idx) {
  if (idx < 0 || idx >= state.regions.length) return;
  const r = state.regions[idx];
  if (!confirm(`Delete region "${r.name || 'Region ' + (idx + 1)}"?`)) return;
  pushUndoSnapshot('delete region');
  state.regions.splice(idx, 1);
  if (state.selectedRegionIdx === idx) {
    state.selectedRegionIdx = -1;
  } else if (state.selectedRegionIdx > idx) {
    state.selectedRegionIdx--;
  }
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
  setStatus(`Region deleted. ${state.regions.length} region(s).`);
}

// ---------------------------------------------------------------------------
// Phase 1B.3 — material display helpers
// ---------------------------------------------------------------------------
function materialDisplayName(m) {
  if (!m) return 'Material';
  if (m.material_source === 'belgard' && m.belgard_material) {
    return m.belgard_material.product_name || 'Belgard product';
  }
  if (m.material_source === 'third_party' && m.third_party_material) {
    return m.third_party_material.product_name || 'Third-party product';
  }
  return 'Material';
}

function materialMeta(m) {
  if (!m) return '';
  if (m.material_source === 'belgard' && m.belgard_material) {
    const bm = m.belgard_material;
    const parts = [];
    if (bm.color) parts.push(bm.color);
    if (bm.pattern) parts.push(bm.pattern);
    return parts.join(' · ');
  }
  if (m.material_source === 'third_party' && m.third_party_material) {
    const tp = m.third_party_material;
    const parts = [];
    if (tp.manufacturer) parts.push(tp.manufacturer);
    if (tp.color) parts.push(tp.color);
    return parts.join(' · ');
  }
  return '';
}

function materialThumbUrl(m) {
  if (!m) return '';
  if (m.material_source === 'belgard' && m.belgard_material) {
    const bm = m.belgard_material;
    return bm.swatch_url || bm.primary_image_url || bm.image_url || '';
  }
  if (m.material_source === 'third_party' && m.third_party_material) {
    const tp = m.third_party_material;
    return tp.primary_image_url || tp.image_url || '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
function refreshSidePanel() {
  els.regionCount.textContent = state.regions.length;
  els.sideList.innerHTML = '';
  state.regions.forEach((r, idx) => {
    if (!Array.isArray(r.materials)) r.materials = [];

    const card = document.createElement('div');
    card.className = 'sm-region-card' + (idx === state.selectedRegionIdx ? ' sm-selected' : '');
    card.dataset.idx = idx;

    const sectionOptions = ['<option value="">— No section —</option>']
      .concat(state.sections.map(s =>
        `<option value="${escapeHtml(s.id)}"${r.proposal_section_id === s.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
      )).join('');

    let materialsBlock;
    if (state.materials.length === 0) {
      materialsBlock = `<div class="sm-material-pills-empty">No materials in this proposal yet — add them in the editor's Materials section.</div>`;
    } else {
      const selectedOrder = new Map();
      r.materials.forEach((entry, j) => {
        selectedOrder.set(entry.proposal_material_id, j + 1);
      });

      const pills = state.materials.map(m => {
        const isSel = selectedOrder.has(m.id);
        const order = selectedOrder.get(m.id) || '';
        const name = materialDisplayName(m);
        const meta = materialMeta(m);
        const thumb = materialThumbUrl(m);
        const thumbHtml = thumb
          ? `<img src="${escapeHtml(thumb)}" alt="" class="sm-material-pill-thumb">`
          : `<div class="sm-material-pill-thumb-empty">${escapeHtml(name.slice(0, 2).toUpperCase())}</div>`;
        return `
          <button type="button" class="sm-material-pill${isSel ? ' sm-selected' : ''}" data-mat-id="${escapeHtml(m.id)}">
            <span class="sm-material-pill-order">${order}</span>
            ${thumbHtml}
            <span class="sm-material-pill-text">
              <span class="sm-material-pill-name">${escapeHtml(name)}</span>
              ${meta ? `<span class="sm-material-pill-meta">${escapeHtml(meta)}</span>` : ''}
            </span>
          </button>
        `;
      }).join('');
      materialsBlock = `<div class="sm-material-pills">${pills}</div>`;
    }

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
      <div class="sm-region-card-row" style="margin-top:8px;">
        <label style="display:block;width:100%;font-size:11px;font-weight:500;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Section</label>
        <select class="sm-input-section" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-family:inherit;font-size:14px;background:#fff;">
          ${sectionOptions}
        </select>
      </div>
      <div class="sm-region-card-materials-wrap">
        <label>Materials</label>
        ${materialsBlock}
      </div>
      <div class="sm-region-card-actions">
        <button class="sm-btn sm-btn-danger sm-btn-delete">Delete</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (
        e.target.tagName !== 'INPUT' &&
        e.target.tagName !== 'SELECT' &&
        e.target.tagName !== 'OPTION' &&
        !e.target.classList.contains('sm-btn-delete') &&
        !e.target.closest('.sm-material-pill')
      ) {
        selectRegion(idx);
      }
    });

    const nameInput = card.querySelector('.sm-input-name');
    const sqftInput = card.querySelector('.sm-input-sqft');
    const lnftInput = card.querySelector('.sm-input-lnft');
    const sectionSelect = card.querySelector('.sm-input-section');

    const snapshotOnFocus = (label) => () => pushUndoSnapshot(label);
    nameInput.addEventListener('focus', snapshotOnFocus('rename region'));
    sqftInput.addEventListener('focus', snapshotOnFocus('edit sqft'));
    lnftInput.addEventListener('focus', snapshotOnFocus('edit lnft'));

    nameInput.addEventListener('input', (e) => {
      r.name = e.target.value;
      redraw();
      els.btnSave.disabled = false;
    });
    sqftInput.addEventListener('input', (e) => {
      const v = e.target.value === '' ? null : parseFloat(e.target.value);
      r.area_sqft = isNaN(v) ? null : v;
      els.btnSave.disabled = false;
    });
    lnftInput.addEventListener('input', (e) => {
      const v = e.target.value === '' ? null : parseFloat(e.target.value);
      r.area_lnft = isNaN(v) ? null : v;
      els.btnSave.disabled = false;
    });
    sectionSelect.addEventListener('change', (e) => {
      pushUndoSnapshot('change section');
      r.proposal_section_id = e.target.value || null;
      els.btnSave.disabled = false;
    });

    card.querySelectorAll('.sm-material-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const matId = pill.dataset.matId;
        if (!matId) return;
        const existingIdx = r.materials.findIndex(x => x.proposal_material_id === matId);
        pushUndoSnapshot(existingIdx >= 0 ? 'remove material' : 'add material');
        if (existingIdx >= 0) {
          r.materials.splice(existingIdx, 1);
          r.materials.forEach((entry, j) => { entry.display_order = j; });
        } else {
          r.materials.push({
            proposal_material_id: matId,
            display_order: r.materials.length,
          });
        }
        refreshSidePanel();
        els.btnSave.disabled = false;
      });
    });

    card.querySelector('.sm-btn-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete region "${r.name}"?`)) return;
      pushUndoSnapshot('delete region');
      state.regions.splice(idx, 1);
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
async function saveAll() {
  if (state.draftPolygon) {
    toast('Finish drawing the current polygon first (double-click to close, Esc to cancel)', 'error');
    throw new Error('Draft polygon in progress');
  }
  els.btnSave.disabled = true;
  els.btnSave.textContent = 'Saving…';
  try {
    const result = await apiSaveRegions(state.proposalId, state.regions);
    state.regions = result.regions.map((r, i) => {
      const materials = Array.isArray(r.materials) ? r.materials : [];
      materials.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
      return {
        ...r,
        materials,
        _color: colorForIndex(i),
      };
    });
    refreshSidePanel();
    redraw();
    toast(`Saved. ${result.stats.inserted} new, ${result.stats.updated} updated, ${result.stats.deleted} removed.`, 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error', 6000);
    els.btnSave.disabled = false;
    throw err;
  } finally {
    els.btnSave.textContent = 'Save All';
  }
}

els.btnSave.addEventListener('click', () => {
  saveAll().catch(() => {});
});

window.saveSiteMap = saveAll;
window.hasUnsavedSiteMapChanges = () => !els.btnSave.disabled;

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
// "+ New polygon" button
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
  const url = new URL(window.location.href);
  let proposalId = url.searchParams.get('proposal_id');
  if (!proposalId) {
    proposalId = await promptForProposalId();
    if (!proposalId) return;
    url.searchParams.set('proposal_id', proposalId);
    window.history.replaceState({}, '', url);
  }
  state.proposalId = proposalId;
  els.proposalLabel.textContent = `Proposal: ${proposalId}`;

  try {
    const data = await apiGetRegions(proposalId);
    state.regions = (data.regions || []).map((r, i) => {
      const materials = Array.isArray(r.materials) ? r.materials : [];
      materials.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
      return {
        ...r,
        materials,
        _color: colorForIndex(i),
      };
    });
    state.sections = data.sections || [];
    state.materials = data.materials || [];
    await setBackdrop(data.backdrop);
    refreshSidePanel();
    if (state.regions.length > 0) {
      setStatus(`${state.regions.length} region(s) loaded.`);
    }
    resetUndoStack();
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
