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
  cursorPx: null,            // { x, y } current mouse position in canvas px (for rubber-band preview during draft)
  polygonDrag: null,         // { regionIdx, lastFrac:{x,y} } when dragging an entire polygon by its interior
  hoveredEdge: null,         // { regionIdx, edgeIdx, point:{x,y frac} } when cursor is over an edge of the selected polygon
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

  // Draw committed polygons
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
    ctx.strokeStyle = '#10b981';
    ctx.stroke();
    // Draw a "+" inside
    ctx.beginPath();
    ctx.moveTo(px.x - 4, px.y);
    ctx.lineTo(px.x + 4, px.y);
    ctx.moveTo(px.x, px.y - 4);
    ctx.lineTo(px.x, px.y + 4);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#10b981';
    ctx.stroke();
    ctx.restore();
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

  // Build the path once
  ctx.beginPath();
  const start = fracToPx(pts[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.lineTo(p.x, p.y);
  }

  // White halo behind the line so it stays visible against both light and dark
  // regions of the backdrop (construction drawings have busy grayscale areas).
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();

  // Bold red dashed line on top — the actual draft polygon edge.
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#dc2626';
  ctx.setLineDash([12, 6]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Rubber-band preview: faint line from last placed vertex to current cursor.
  // Helps Tim see where the next click will land before placing it.
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

  // Vertex markers: large white-filled circles with red border. First vertex
  // is green to signal "click here to close the polygon."
  for (let i = 0; i < pts.length; i++) {
    const p = fracToPx(pts[i]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = i === 0 ? '#10b981' : '#dc2626';
    ctx.stroke();
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
//
// Precedence on mousedown when a polygon is selected and we're not drafting:
//   1. Vertex drag (cursor over an existing vertex)
//   2. Edge insert (cursor near an edge — insert vertex there, then drag it)
//   3. Polygon interior drag (cursor inside the polygon — translate the whole shape)
//   4. Otherwise: fall through to click handler (selects another polygon or starts a draft)
//
// We do drag setup in mousedown (not click) so the user can immediately drag
// without an extra click. The `click` handler below only fires when no drag
// happened (see DRAG_SUPPRESSES_CLICK below).
// ---------------------------------------------------------------------------

// Set true on mousedown when a drag operation begins, so the upcoming click
// event is suppressed (otherwise mousedown→mousemove→mouseup→click would also
// fire a click on the same coordinate, which we don't want for drags).
let DRAG_SUPPRESSES_CLICK = false;

els.canvas.addEventListener('mousedown', (e) => {
  if (!state.backdropImg) return;
  if (state.draftPolygon) return;  // mousedown during draft is ignored — clicks place vertices

  const px = eventToCanvasPx(e);

  // 1. Vertex drag (only if a polygon is selected and we're on one of its vertices)
  if (state.selectedRegionIdx !== -1) {
    const hitV = hitTestVertex(px);
    if (hitV && hitV.regionIdx === state.selectedRegionIdx) {
      state.drag = hitV;
      els.canvas.classList.add('sm-cursor-grabbing');
      DRAG_SUPPRESSES_CLICK = true;
      e.preventDefault();
      return;
    }

    // 2. Edge insert: if cursor is near an edge of the selected polygon, insert
    // a new vertex there and immediately start dragging it (so Tim can refine
    // the position in one motion).
    const hitE = hitTestEdge(px);
    if (hitE) {
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

    // 3. Polygon interior drag: cursor inside the selected polygon.
    if (pointInPolygon(px, state.regions[state.selectedRegionIdx].polygon)) {
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

  // 4. Otherwise, fall through to click handler
});

els.canvas.addEventListener('mousemove', (e) => {
  if (!state.backdropImg) return;
  const px = eventToCanvasPx(e);

  // Vertex drag in progress — update the dragged vertex.
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

  // Polygon interior drag in progress — translate every vertex by the cursor delta.
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

  // Update rubber-band cursor position during draft drawing.
  if (state.draftPolygon) {
    state.cursorPx = px;
    redraw();
    return;
  }

  // Otherwise, hover detection — show edge-insert "+" indicator when over an edge
  // of the selected polygon (but not when over a vertex, which has its own behavior).
  if (state.selectedRegionIdx !== -1) {
    const hitV = hitTestVertex(px);
    const newHoveredEdge = hitV ? null : hitTestEdge(px);
    // Only redraw if the hovered-edge state changed (avoid redrawing on every pixel of mouse movement)
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
    // Keep DRAG_SUPPRESSES_CLICK true — the trailing click will reset it.
  }
});

els.canvas.addEventListener('click', (e) => {
  if (!state.backdropImg) return;

  // Suppress the click that follows a drag operation (so e.g. dragging a vertex
  // doesn't also trigger "place a new vertex" on the underlying click).
  if (DRAG_SUPPRESSES_CLICK) {
    DRAG_SUPPRESSES_CLICK = false;
    return;
  }

  const px = eventToCanvasPx(e);

  // If we're drawing, add a vertex (the dblclick handler runs after this for closure)
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
    state.cursorPx = px;
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
    state.cursorPx = null;
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
  state.cursorPx = null;
  selectRegion(state.regions.length - 1);
  setStatus(`Polygon committed. ${state.regions.length} region(s).`);
  refreshSidePanel();
  redraw();
  els.btnSave.disabled = false;
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
    toast('Polygon must have at least 3 vertices — delete the whole region instead', 'error');
    return;
  }
  r.polygon.splice(hit.vertexIdx, 1);
  redraw();
  els.btnSave.disabled = false;
});

// Mouse leaving the canvas: clear hover/cursor state so leftover indicators don't linger
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
  // Escape cancels a draft
  if (e.key === 'Escape' && state.draftPolygon) {
    state.draftPolygon = null;
    state.cursorPx = null;
    setStatus('Drawing cancelled');
    redraw();
    return;
  }
  // Delete/Backspace deletes the selected polygon (when not focused in an input)
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedRegionIdx !== -1) {
    if (document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA'
    )) {
      return;  // typing in a side-panel input — don't hijack delete
    }
    e.preventDefault();
    deleteRegion(state.selectedRegionIdx);
  }
});

/** Delete a region by index. Used by both the side-panel ✕ button and the
 *  Delete/Backspace key. */
function deleteRegion(idx) {
  if (idx < 0 || idx >= state.regions.length) return;
  const r = state.regions[idx];
  if (!confirm(`Delete region "${r.name || 'Region ' + (idx + 1)}"?`)) return;
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
