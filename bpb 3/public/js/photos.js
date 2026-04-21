// ═══════════════════════════════════════════════════════════════════════════
// Photos section (Phase 1.3).
//
// Property condition / "before" photos for this proposal.
//
// Flow:
//   1. User drags image onto dropzone OR picks via file input
//   2. Client-side: Canvas API resizes to max 2400px long edge, JPEG quality 85
//   3. A 400px thumbnail is generated the same way
//   4. Both uploaded directly to Supabase Storage (bucket 'proposal-photos')
//      under paths: {proposalId}/{uuid}.jpg and {proposalId}/{uuid}_thumb.jpg
//   5. A proposal_images row is inserted with the public URLs + metadata
//   6. UI re-renders the list
//
// Reorder: up/down arrow buttons swap display_order with the neighbor row.
// Delete: removes Storage objects + DB row.
//
// No drag-and-drop reorder library needed — vertical list with arrows is
// sufficient for single-user tool with typically 5-20 photos per proposal.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

const BUCKET = 'proposal-photos';
const MAX_DIMENSION = 2400;
const THUMB_DIMENSION = 400;
const JPEG_QUALITY = 0.85;

const LOCATION_TAGS = [
  { value: '',             label: '— no tag —' },
  { value: 'front_yard',   label: 'Front yard' },
  { value: 'backyard',     label: 'Backyard' },
  { value: 'side_yard',    label: 'Side yard' },
  { value: 'full_property',label: 'Full property' }
];

const state = {
  proposalId: null,
  container: null,
  onSave: null,
  photos: [],      // rows from proposal_images, sorted by display_order
  uploading: 0,    // count of in-flight uploads
  error: null
};

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────
export async function initPhotos({ proposalId, container, onSave }) {
  Object.assign(state, {
    proposalId,
    container,
    onSave,
    photos: [],
    uploading: 0,
    error: null
  });

  container.innerHTML = `<div class="mp-loading">Loading photos…</div>`;

  await loadPhotos();
  render();
}

async function loadPhotos() {
  const { data, error } = await supabase
    .from('proposal_images')
    .select('*')
    .eq('proposal_id', state.proposalId)
    .eq('category', 'property_condition')
    .order('display_order', { ascending: true });

  if (error) {
    state.error = 'Could not load photos: ' + error.message;
    state.photos = [];
    return;
  }

  state.photos = data || [];
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────
function render() {
  const { photos, uploading, error } = state;

  state.container.innerHTML = `
    <div class="section-header">
      <span class="eyebrow">Section 05</span>
      <h2>Photos — property condition</h2>
      <p class="lead">
        Drag "before" photos of the property here. Images are resized to 2400px and compressed
        automatically. Order and tag them below; the final proposal renders them in this order.
      </p>
    </div>

    ${error ? `<div class="bp-error-box">${escapeHtml(error)}</div>` : ''}

    <div class="bp-photo-dropzone" id="bpPhotoDrop">
      <div class="bp-photo-dropzone-inner">
        <div class="bp-photo-dropzone-icon">+</div>
        <div class="bp-photo-dropzone-text">
          <strong>Drag photos here</strong>
          <span>or <button type="button" class="bp-link" id="bpPhotoPick">pick from your computer</button></span>
        </div>
        <div class="bp-photo-dropzone-hint">JPEG, PNG, HEIC · any size · multiple at once</div>
      </div>
      <input type="file" id="bpPhotoInput" accept="image/*" multiple style="display:none">
    </div>

    ${uploading > 0 ? `
      <div class="bp-photo-uploading">
        Uploading ${uploading} photo${uploading === 1 ? '' : 's'}… don't navigate away.
      </div>
    ` : ''}

    <div class="bp-photo-list">
      ${photos.length === 0 && uploading === 0
        ? `<div class="bp-photo-empty">No photos yet — drop some above to get started.</div>`
        : photos.map((p, idx) => renderPhotoRow(p, idx, photos.length)).join('')
      }
    </div>
  `;

  attachDropzone();
  attachRowControls();
}

function renderPhotoRow(photo, idx, total) {
  const thumbUrl = photo.thumbnail_path ? publicUrl(photo.thumbnail_path) : publicUrl(photo.storage_path);
  const fullUrl  = publicUrl(photo.storage_path);

  const locationOptions = LOCATION_TAGS.map(t => `
    <option value="${t.value}" ${(photo.location_tag || '') === t.value ? 'selected' : ''}>
      ${t.label}
    </option>
  `).join('');

  return `
    <div class="bp-photo-row" data-id="${photo.id}">
      <div class="bp-photo-thumb">
        <a href="${fullUrl}" target="_blank" rel="noopener">
          <img src="${thumbUrl}" alt="" loading="lazy">
        </a>
      </div>
      <div class="bp-photo-meta">
        <div class="bp-photo-filename" title="${escapeHtml(photo.original_filename || '')}">
          ${escapeHtml(photo.original_filename || 'Untitled')}
        </div>
        <div class="bp-photo-dims">
          ${photo.width && photo.height ? `${photo.width} × ${photo.height}` : ''}
        </div>
        <label class="bp-photo-location">
          <span class="eyebrow">Location</span>
          <select data-field="location_tag" data-id="${photo.id}">
            ${locationOptions}
          </select>
        </label>
      </div>
      <div class="bp-photo-actions">
        <button type="button" class="bp-icon-btn" data-action="up" data-id="${photo.id}"
                ${idx === 0 ? 'disabled' : ''} title="Move up">▲</button>
        <button type="button" class="bp-icon-btn" data-action="down" data-id="${photo.id}"
                ${idx === total - 1 ? 'disabled' : ''} title="Move down">▼</button>
        <button type="button" class="bp-icon-btn bp-icon-btn-danger" data-action="delete"
                data-id="${photo.id}" title="Delete">✕</button>
      </div>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Dropzone + file input wiring
// ───────────────────────────────────────────────────────────────────────────
function attachDropzone() {
  const drop = state.container.querySelector('#bpPhotoDrop');
  const input = state.container.querySelector('#bpPhotoInput');
  const pick = state.container.querySelector('#bpPhotoPick');

  if (!drop || !input) return;

  pick?.addEventListener('click', (e) => { e.preventDefault(); input.click(); });

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    await handleFiles(files);
  });

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (files.length === 0) return;
    await handleFiles(files);
    input.value = '';
  });
}

function attachRowControls() {
  state.container.querySelectorAll('.bp-photo-row [data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'up') await movePhoto(id, -1);
      else if (action === 'down') await movePhoto(id, +1);
      else if (action === 'delete') await deletePhoto(id);
    });
  });

  state.container.querySelectorAll('.bp-photo-row select[data-field]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.id;
      const field = sel.dataset.field;
      const value = sel.value || null;
      const { error } = await supabase
        .from('proposal_images')
        .update({ [field]: value })
        .eq('id', id);
      if (error) {
        state.error = `Could not save ${field}: ${error.message}`;
        render();
      } else {
        const row = state.photos.find(p => p.id === id);
        if (row) row[field] = value;
        state.onSave?.();
      }
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Upload pipeline
// ───────────────────────────────────────────────────────────────────────────
async function handleFiles(files) {
  state.uploading += files.length;
  state.error = null;
  render();

  // Process files in parallel (browser will naturally throttle canvas work)
  const uploads = files.map(file => processAndUpload(file).catch(err => {
    console.error('Upload failed:', file.name, err);
    return { error: err.message || String(err), file };
  }));

  const results = await Promise.all(uploads);
  const failures = results.filter(r => r && r.error);

  state.uploading -= files.length;

  if (failures.length > 0) {
    state.error = `${failures.length} upload${failures.length === 1 ? '' : 's'} failed: ${failures[0].error}`;
  }

  await loadPhotos();
  render();
  state.onSave?.();
}

async function processAndUpload(file) {
  // 1. Decode image
  const img = await loadImage(file);

  // 2. Resize main image to max 2400px long edge
  const { blob: mainBlob, width, height } = await resizeToBlob(img, MAX_DIMENSION, JPEG_QUALITY);

  // 3. Resize thumbnail to 400px long edge
  const { blob: thumbBlob } = await resizeToBlob(img, THUMB_DIMENSION, JPEG_QUALITY);

  // 4. Generate unique paths
  const uuid = crypto.randomUUID();
  const mainPath  = `${state.proposalId}/${uuid}.jpg`;
  const thumbPath = `${state.proposalId}/${uuid}_thumb.jpg`;

  // 5. Upload both to Storage
  const { error: mainErr } = await supabase.storage
    .from(BUCKET)
    .upload(mainPath, mainBlob, { contentType: 'image/jpeg', upsert: false });
  if (mainErr) throw new Error(`Storage upload failed: ${mainErr.message}`);

  const { error: thumbErr } = await supabase.storage
    .from(BUCKET)
    .upload(thumbPath, thumbBlob, { contentType: 'image/jpeg', upsert: false });
  if (thumbErr) {
    // Best-effort cleanup of main, then surface the thumbnail error
    await supabase.storage.from(BUCKET).remove([mainPath]);
    throw new Error(`Thumbnail upload failed: ${thumbErr.message}`);
  }

  // 6. Determine next display_order
  const maxOrder = state.photos.reduce((m, p) => Math.max(m, p.display_order ?? 0), -1);

  // 7. Insert DB row
  const { error: insertErr } = await supabase
    .from('proposal_images')
    .insert({
      proposal_id: state.proposalId,
      category: 'property_condition',
      storage_path: mainPath,
      thumbnail_path: thumbPath,
      original_filename: file.name,
      width,
      height,
      display_order: maxOrder + 1
    });

  if (insertErr) {
    // Best-effort cleanup of both Storage objects
    await supabase.storage.from(BUCKET).remove([mainPath, thumbPath]);
    throw new Error(`Database insert failed: ${insertErr.message}`);
  }

  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────
// Canvas-based resize
// ───────────────────────────────────────────────────────────────────────────
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode ${file.name} — unsupported format?`));
    };
    img.src = url;
  });
}

function resizeToBlob(img, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longEdge > maxDim ? maxDim / longEdge : 1;
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('Canvas toBlob failed'));
        resolve({ blob, width, height });
      },
      'image/jpeg',
      quality
    );
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Reorder + delete
// ───────────────────────────────────────────────────────────────────────────
async function movePhoto(id, direction) {
  const idx = state.photos.findIndex(p => p.id === id);
  if (idx === -1) return;
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= state.photos.length) return;

  const a = state.photos[idx];
  const b = state.photos[swapIdx];

  // Swap display_order values
  const { error: errA } = await supabase
    .from('proposal_images')
    .update({ display_order: b.display_order })
    .eq('id', a.id);
  const { error: errB } = await supabase
    .from('proposal_images')
    .update({ display_order: a.display_order })
    .eq('id', b.id);

  if (errA || errB) {
    state.error = `Reorder failed: ${(errA || errB).message}`;
    render();
    return;
  }

  await loadPhotos();
  render();
  state.onSave?.();
}

async function deletePhoto(id) {
  const photo = state.photos.find(p => p.id === id);
  if (!photo) return;
  if (!confirm(`Delete "${photo.original_filename || 'this photo'}"? This can't be undone.`)) return;

  // Remove Storage objects first (best-effort; a dangling row is worse than dangling blobs)
  const pathsToRemove = [photo.storage_path, photo.thumbnail_path].filter(Boolean);
  if (pathsToRemove.length > 0) {
    await supabase.storage.from(BUCKET).remove(pathsToRemove);
  }

  // Remove DB row
  const { error } = await supabase
    .from('proposal_images')
    .delete()
    .eq('id', id);

  if (error) {
    state.error = `Delete failed: ${error.message}`;
    render();
    return;
  }

  await loadPhotos();
  render();
  state.onSave?.();
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function publicUrl(storagePath) {
  if (!storagePath) return '';
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl || '';
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
