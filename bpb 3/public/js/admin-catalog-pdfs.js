// ═══════════════════════════════════════════════════════════════════════════
// Admin tool: Catalog PDFs (Phase 3B.2 foundation)
//
// This is the foundation pass — it ships:
//   • Drag-drop PDF upload to the catalog-pdfs Supabase Storage bucket.
//   • A row inserted into the catalog_pdfs table for each upload.
//   • A list view of every registered PDF (external or uploaded).
//   • An "Extract Swatches" button per row that calls /api/extract-pdf-swatches.
//   • A delete button that removes both the storage object and DB row.
//
// The extraction endpoint itself returns a 501 Not Implemented in this
// session — the actual swatch vision-extraction is built in 3B.2 part 2.
// We're shipping foundation first so Tim can upload the Techo-Bloc and
// Keystone PDFs and see them in the list before we write the heavy bits.
//
// This page is master-only. Designers reaching it will have working auth
// (the supabase-client.js side-effect gate handles that) but the RLS
// policies on catalog_pdfs and storage.objects will reject their writes
// with a clear error, which we surface in the UI.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

const MAX_FILE_BYTES = 80 * 1024 * 1024; // 80 MB safety cap

const state = {
  selectedFile: null,
  pdfs: [],
  uploading: false,
  loadingList: false,
  myProfile: null,
};

// ───────────────────────────────────────────────────────────────────────────
// Bootstrap
// ───────────────────────────────────────────────────────────────────────────
init();

async function init() {
  // Confirm we're master before showing anything write-related. Designer
  // would still see the list (RLS allows authenticated reads) but the
  // upload form should be disabled with a clear message.
  await loadMyProfile();
  if (state.myProfile && state.myProfile.role !== 'master') {
    disableUploadForNonMaster();
  }

  wireUploadForm();
  wireDropZone();
  await loadPdfList();
}

async function loadMyProfile() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .maybeSingle();
    if (!error && data) state.myProfile = data;
  } catch (err) {
    console.error('Could not load profile:', err);
  }
}

function disableUploadForNonMaster() {
  const panel = document.getElementById('cpUploadPanel');
  panel.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
  showUploadMessage(
    'Only master users can upload new catalogs. You can still view registered PDFs below.',
    'info'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Upload form
// ───────────────────────────────────────────────────────────────────────────
function wireUploadForm() {
  document.getElementById('cpUploadBtn').addEventListener('click', runUpload);

  // Auto-fill catalog name from filename if empty
  const fileInput = document.getElementById('cpFileInput');
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    setSelectedFile(file);
  });

  // Validate-as-they-type to enable/disable upload button
  document.getElementById('cpManufacturer').addEventListener('change', refreshUploadButton);
  document.getElementById('cpPdfName').addEventListener('input', refreshUploadButton);
}

function wireDropZone() {
  const zone = document.getElementById('cpDropZone');

  ['dragenter', 'dragover'].forEach(evt => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('is-dragover');
    });
  });
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    setSelectedFile(file);
  });
}

function setSelectedFile(file) {
  if (!file) {
    state.selectedFile = null;
    document.getElementById('cpDropZone').classList.remove('has-file');
    document.getElementById('cpDropText').style.display = '';
    document.getElementById('cpDropFilename').style.display = 'none';
    refreshUploadButton();
    return;
  }
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showUploadMessage('Only PDF files are supported.', 'error');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showUploadMessage(
      `File is ${formatBytes(file.size)} — that's larger than the ${formatBytes(MAX_FILE_BYTES)} limit. ` +
      'Try compressing the PDF first, or upload page ranges separately.',
      'error'
    );
    return;
  }

  state.selectedFile = file;
  document.getElementById('cpDropZone').classList.add('has-file');
  document.getElementById('cpDropText').style.display = 'none';
  const fnEl = document.getElementById('cpDropFilename');
  fnEl.textContent = `${file.name} (${formatBytes(file.size)})`;
  fnEl.style.display = '';

  // Auto-suggest the catalog name from the filename if empty
  const nameInput = document.getElementById('cpPdfName');
  if (!nameInput.value.trim()) {
    nameInput.value = file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  }

  clearUploadMessage();
  refreshUploadButton();
}

function refreshUploadButton() {
  const manufacturer = document.getElementById('cpManufacturer').value.trim();
  const pdfName = document.getElementById('cpPdfName').value.trim();
  const valid = !!(state.selectedFile && manufacturer && pdfName);
  document.getElementById('cpUploadBtn').disabled = !valid || state.uploading;
}

async function runUpload() {
  if (state.uploading) return;
  const manufacturer = document.getElementById('cpManufacturer').value.trim();
  const pdfName = document.getElementById('cpPdfName').value.trim();
  const file = state.selectedFile;
  if (!manufacturer || !pdfName || !file) return;

  state.uploading = true;
  refreshUploadButton();
  clearUploadMessage();

  const btn = document.getElementById('cpUploadBtn');
  const originalLabel = btn.textContent;
  btn.textContent = 'Uploading…';

  // Storage path: <manufacturer-slug>/<uuid>-<safe-filename>.pdf
  // Slugify the manufacturer for grouping; use uuid prefix to prevent collisions.
  const manufacturerSlug = manufacturer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const uuid = (crypto.randomUUID && crypto.randomUUID()) || ('id-' + Math.random().toString(36).slice(2));
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const storagePath = `${manufacturerSlug}/${uuid}-${safeName}`;

  let uploadResult, dbResult;
  try {
    uploadResult = await supabase.storage
      .from('catalog-pdfs')
      .upload(storagePath, file, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (uploadResult.error) {
      throw new Error('Storage upload failed: ' + uploadResult.error.message);
    }

    // Build the public URL (the bucket is public; the path is hard to guess)
    const pub = supabase.storage.from('catalog-pdfs').getPublicUrl(storagePath);
    const pdfUrl = pub.data.publicUrl;

    dbResult = await supabase
      .from('catalog_pdfs')
      .insert({
        manufacturer,
        pdf_name: pdfName,
        pdf_url: pdfUrl,
        storage_path: storagePath,
        file_size_bytes: file.size,
        uploaded_by: state.myProfile && state.myProfile.id || null,
      })
      .select('id')
      .single();

    if (dbResult.error) {
      // Roll back the storage upload so we don't leave an orphan
      await supabase.storage.from('catalog-pdfs').remove([storagePath]).catch(() => {});
      throw new Error('Database insert failed: ' + dbResult.error.message);
    }

    showUploadMessage(`Uploaded "${pdfName}" successfully.`, 'success');
    resetUploadForm();
    await loadPdfList();
  } catch (err) {
    showUploadMessage(err.message || 'Upload failed for an unknown reason.', 'error');
  } finally {
    state.uploading = false;
    btn.textContent = originalLabel;
    refreshUploadButton();
  }
}

function resetUploadForm() {
  document.getElementById('cpManufacturer').value = '';
  document.getElementById('cpPdfName').value = '';
  document.getElementById('cpFileInput').value = '';
  setSelectedFile(null);
}

// ───────────────────────────────────────────────────────────────────────────
// Listing
// ───────────────────────────────────────────────────────────────────────────
async function loadPdfList() {
  if (state.loadingList) return;
  state.loadingList = true;

  const wrap = document.getElementById('cpTableWrap');
  wrap.innerHTML = '<div class="cp-empty">Loading…</div>';

  const { data, error } = await supabase
    .from('catalog_pdfs')
    .select('id, manufacturer, pdf_name, pdf_url, storage_path, page_count, file_size_bytes, notes, uploaded_at')
    .order('uploaded_at', { ascending: false });

  state.loadingList = false;

  if (error) {
    wrap.innerHTML = `<div class="cp-msg cp-msg-error">Could not load catalogs: ${escapeHtml(error.message)}</div>`;
    return;
  }

  state.pdfs = data || [];
  renderPdfList();
}

function renderPdfList() {
  const wrap = document.getElementById('cpTableWrap');

  if (state.pdfs.length === 0) {
    wrap.innerHTML = '<div class="cp-empty">No catalogs registered yet. Upload one above to get started.</div>';
    return;
  }

  const rows = state.pdfs.map(p => {
    const isExternal = !p.storage_path;
    const sourcePill = isExternal
      ? '<span class="cp-source-pill external">External</span>'
      : '<span class="cp-source-pill uploaded">Uploaded</span>';

    const sizeText = p.file_size_bytes ? formatBytes(p.file_size_bytes) : '—';
    const pagesText = p.page_count ? `${p.page_count} pages` : '—';
    const uploadedDate = p.uploaded_at ? new Date(p.uploaded_at).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    }) : '—';

    return `
      <tr data-pdf-id="${escapeAttr(p.id)}">
        <td>
          <div class="cp-pdf-name">${escapeHtml(p.pdf_name)}</div>
          <div class="cp-pdf-meta">
            ${escapeHtml(p.manufacturer)} ·
            <a href="${escapeAttr(p.pdf_url)}" target="_blank" rel="noopener">View PDF ↗</a>
          </div>
        </td>
        <td>${sourcePill}</td>
        <td>${sizeText}</td>
        <td>${pagesText}</td>
        <td>${uploadedDate}</td>
        <td>
          <div class="cp-row-actions">
            <button class="cp-btn cp-btn-secondary cp-extract-btn" data-id="${escapeAttr(p.id)}">
              Extract swatches
            </button>
            ${isExternal ? '' : `
              <button class="cp-btn cp-btn-danger cp-delete-btn" data-id="${escapeAttr(p.id)}">
                Delete
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  wrap.innerHTML = `
    <table class="cp-table">
      <thead>
        <tr>
          <th>Catalog</th>
          <th style="width: 100px;">Source</th>
          <th style="width: 80px;">Size</th>
          <th style="width: 80px;">Pages</th>
          <th style="width: 110px;">Uploaded</th>
          <th style="width: 240px;"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Wire row actions
  wrap.querySelectorAll('.cp-extract-btn').forEach(btn => {
    btn.addEventListener('click', () => runExtract(btn.dataset.id));
  });
  wrap.querySelectorAll('.cp-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => runDelete(btn.dataset.id));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Extract (placeholder — calls API which returns 501 this session)
// ───────────────────────────────────────────────────────────────────────────
async function runExtract(pdfId) {
  const pdf = state.pdfs.find(p => p.id === pdfId);
  if (!pdf) return;

  const btn = document.querySelector(`.cp-extract-btn[data-id="${cssEscape(pdfId)}"]`);
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      alert('Your session expired — please refresh and sign in again.');
      return;
    }

    const r = await fetch('/api/extract-pdf-swatches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({ catalog_pdf_id: pdfId }),
    });
    const result = await r.json().catch(() => ({}));

    if (r.status === 501) {
      // Expected this session — extraction not yet implemented
      alert(
        'Swatch extraction isn\'t built yet — this is the foundation pass.\n\n' +
        'Status: ' + (result.status || 'pending') + '\n' +
        'Will ship in the next session.'
      );
      return;
    }

    if (!r.ok || !result.ok) {
      alert('Extract failed: ' + (result.error || ('HTTP ' + r.status)));
      return;
    }

    alert('Extract complete!\n' + JSON.stringify(result.summary || {}, null, 2));
    await loadPdfList();
  } catch (err) {
    alert('Extract failed: ' + (err.message || 'Network error'));
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Delete
// ───────────────────────────────────────────────────────────────────────────
async function runDelete(pdfId) {
  const pdf = state.pdfs.find(p => p.id === pdfId);
  if (!pdf) return;

  if (!confirm(
    `Delete "${pdf.pdf_name}"?\n\n` +
    'This removes the PDF file from storage and its catalog row. ' +
    'Any swatches already extracted from it will stay in your materials catalog. ' +
    'This cannot be undone.'
  )) return;

  const btn = document.querySelector(`.cp-delete-btn[data-id="${cssEscape(pdfId)}"]`);
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Deleting…';

  try {
    // Storage first, then DB. If storage delete fails the user can retry.
    if (pdf.storage_path) {
      const stRes = await supabase.storage.from('catalog-pdfs').remove([pdf.storage_path]);
      if (stRes.error) throw new Error('Storage delete failed: ' + stRes.error.message);
    }

    const dbRes = await supabase.from('catalog_pdfs').delete().eq('id', pdfId);
    if (dbRes.error) throw new Error('Database delete failed: ' + dbRes.error.message);

    await loadPdfList();
  } catch (err) {
    alert('Delete failed: ' + (err.message || 'Network error'));
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function showUploadMessage(text, kind) {
  const el = document.getElementById('cpUploadMsg');
  const klass = kind === 'success' ? 'cp-msg-success'
              : kind === 'info'    ? 'cp-msg-info'
              :                       'cp-msg-error';
  el.innerHTML = `<div class="cp-msg ${klass}">${escapeHtml(text)}</div>`;
}

function clearUploadMessage() {
  document.getElementById('cpUploadMsg').innerHTML = '';
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) { return escapeHtml(str); }

// CSS.escape() is widely available; fall back if missing
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ');
}
