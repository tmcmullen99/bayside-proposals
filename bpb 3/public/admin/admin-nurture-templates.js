// ═══════════════════════════════════════════════════════════════════════════
// admin-nurture-templates.js — Sprint 14B
//
// Master-only template authoring at /admin/nurture-templates.html.
// CRUD over nurture_templates with markdown body + live preview, merge
// field substitution, project-type filter, day-offset, and is_active toggle.
//
// Companion to admin-nurture-clients.js (Sprint 14A): that page tracks
// client phases; this page authors the email content sent at each phase.
//
// The dry-run cron (nurture_daily_run at 23:00 UTC) reads the active
// templates here and inserts 'would_send' rows into nurture_sends for
// every client whose phase + days-in-phase + project_types match.
// Sprint 14B does NOT actually send; 14C will.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireMaster } from '/js/auth-util.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked/+esm';

const PHASE_LABELS = {
  pre_consult: 'Pre-consult',
  design_in_progress: 'Design in progress',
  post_review: 'Post-review',
  cooling: 'Cooling',
  dead: 'Dead',
};

const PROJECT_TYPE_LABELS = {
  pavers: 'Pavers',
  driveway: 'Driveway',
  turf: 'Turf',
  walls: 'Walls',
  drainage: 'Drainage',
  pool_deck: 'Pool deck',
  fire_features: 'Fire features',
  lighting: 'Lighting',
  other: 'Other',
};

// Order phases by lifecycle progression for the page layout
const PHASE_ORDER = ['pre_consult', 'design_in_progress', 'post_review', 'cooling', 'dead'];

// Sample data for live preview merge-field substitution
const SAMPLE = {
  client_first_name: 'Sarah',
  proposal_address: '123 Main St, Campbell',
  designer_name: 'Bayside',
};

const ctx = {
  viewer: null,
  templates: [],
  editing: null,         // template object, or null for new
  showInactive: false,
};

(async function init() {
  const auth = await requireMaster();
  if (!auth) return;
  ctx.viewer = { ...auth.user, role: auth.profile.role };

  await loadTemplates();
  render();
  wireEditorModal();

  document.getElementById('ntNewBtn').addEventListener('click', () => openEditor(null));
})();

async function loadTemplates() {
  const { data, error } = await supabase
    .from('nurture_templates')
    .select('id, phase, day_offset, subject, body_md, project_type_filter, is_active, notes, updated_at')
    .order('phase')
    .order('day_offset')
    .order('subject');

  if (error) {
    console.error('[nurture-templates] load failed:', error);
    showError('Could not load templates: ' + error.message);
    return;
  }

  ctx.templates = data || [];
}

function render() {
  const active = ctx.templates.filter(t => t.is_active);
  const inactive = ctx.templates.filter(t => !t.is_active);

  // Group active by phase, in lifecycle order
  const byPhase = {};
  for (const phase of PHASE_ORDER) byPhase[phase] = [];
  for (const t of active) {
    if (!byPhase[t.phase]) byPhase[t.phase] = [];
    byPhase[t.phase].push(t);
  }

  let html = '';
  let totalActive = 0;
  for (const phase of PHASE_ORDER) {
    const items = byPhase[phase];
    if (!items || items.length === 0) continue;
    totalActive += items.length;
    html += `
      <section class="nt-phase-group">
        <div class="nt-phase-head">
          <h2>${escapeHtml(PHASE_LABELS[phase] || phase)}</h2>
          <span class="nt-phase-count">${items.length} template${items.length === 1 ? '' : 's'}</span>
        </div>
        ${items.map(renderCard).join('')}
      </section>
    `;
  }

  if (totalActive === 0) {
    html += `
      <div class="nt-phase-group">
        <div class="nt-empty">No active templates yet. Click <strong>+ New template</strong> to create one.</div>
      </div>
    `;
  }

  if (inactive.length > 0) {
    const expanded = ctx.showInactive;
    html += `
      <section class="nt-phase-group">
        <button class="nt-inactive-toggle" id="ntInactiveToggle" aria-expanded="${expanded}" type="button">
          <span class="nt-chev">▶</span>
          Inactive (${inactive.length})
        </button>
        <div ${expanded ? '' : 'hidden'}>
          ${inactive.map(renderCard).join('')}
        </div>
      </section>
    `;
  }

  document.getElementById('ntContent').innerHTML = html;

  document.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const t = ctx.templates.find(x => x.id === id);
      if (t) openEditor(t);
    });
  });

  const tog = document.getElementById('ntInactiveToggle');
  if (tog) {
    tog.addEventListener('click', () => {
      ctx.showInactive = !ctx.showInactive;
      render();
    });
  }
}

function renderCard(t) {
  const filterTag = t.project_type_filter
    ? `<span class="nt-meta-tag">${escapeHtml(PROJECT_TYPE_LABELS[t.project_type_filter] || t.project_type_filter)} only</span>`
    : '';
  const inactiveTag = t.is_active ? '' : '<span class="nt-meta-tag inactive">Inactive</span>';
  // Strip simple markdown punctuation for the inline preview tease
  const preview = (t.body_md || '')
    .replace(/[#*_`>\[\]\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  return `
    <div class="nt-card">
      <span class="nt-day-pill">Day ${t.day_offset}</span>
      <div class="nt-card-body">
        <h3 class="nt-card-subject">${escapeHtml(t.subject)}</h3>
        <p class="nt-card-preview">${escapeHtml(preview || '(empty body)')}</p>
        <div class="nt-card-meta">
          ${filterTag}
          ${inactiveTag}
        </div>
      </div>
      <div class="nt-card-actions">
        <button class="nt-btn" data-action="edit" data-id="${escapeAttr(t.id)}" type="button">Edit</button>
      </div>
    </div>
  `;
}

// ─── Editor modal ─────────────────────────────────────────────────────────
function wireEditorModal() {
  const overlay = document.getElementById('nteOverlay');
  document.getElementById('nteCancel').addEventListener('click', closeEditor);
  document.getElementById('nteSave').addEventListener('click', saveTemplate);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEditor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) closeEditor();
  });

  // Live preview on every keystroke. Subject + body are the only fields
  // with merge-field substitution; phase/filter/day-offset don't affect preview.
  ['nteSubject', 'nteBody'].forEach(id => {
    document.getElementById(id).addEventListener('input', updatePreview);
  });
}

function openEditor(t) {
  ctx.editing = t;
  const isNew = !t;

  document.getElementById('nteEyebrow').textContent = isNew ? 'New template' : 'Edit template';
  document.getElementById('nteTitle').textContent = isNew
    ? 'Create a new nurture template'
    : `Editing: ${t.subject}`;

  document.getElementById('ntePhase').value = isNew ? 'design_in_progress' : t.phase;
  document.getElementById('nteDayOffset').value = isNew ? 0 : t.day_offset;
  document.getElementById('nteSubject').value = isNew ? '' : t.subject;
  document.getElementById('nteBody').value = isNew ? '' : (t.body_md || '');
  document.getElementById('nteFilter').value = isNew ? '' : (t.project_type_filter || '');
  document.getElementById('nteNotes').value = isNew ? '' : (t.notes || '');
  document.getElementById('nteIsActive').checked = isNew ? true : !!t.is_active;

  const errEl = document.getElementById('nteError');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  updatePreview();
  document.getElementById('nteOverlay').classList.add('visible');
  setTimeout(() => document.getElementById('nteSubject').focus(), 100);
}

function closeEditor() {
  document.getElementById('nteOverlay').classList.remove('visible');
  ctx.editing = null;
}

function updatePreview() {
  const subjectRaw = document.getElementById('nteSubject').value;
  const bodyRaw = document.getElementById('nteBody').value;

  const subjectSubbed = substituteMergeFields(subjectRaw, SAMPLE) || '(subject)';
  const bodySubbed = substituteMergeFields(bodyRaw, SAMPLE).trim();

  document.getElementById('ntePreviewSubject').textContent = subjectSubbed;
  document.getElementById('ntePreviewBody').innerHTML = bodySubbed
    ? marked.parse(bodySubbed, { gfm: true, breaks: true })
    : '<em style="color:#888">(body)</em>';
}

function substituteMergeFields(text, sample) {
  if (!text) return '';
  return text
    .replace(/\{\{\s*client_first_name\s*\}\}/g, sample.client_first_name)
    .replace(/\{\{\s*proposal_address\s*\}\}/g, sample.proposal_address)
    .replace(/\{\{\s*designer_name\s*\}\}/g, sample.designer_name);
}

async function saveTemplate() {
  const errEl = document.getElementById('nteError');
  const saveBtn = document.getElementById('nteSave');
  errEl.classList.add('hidden');

  const phase = document.getElementById('ntePhase').value;
  const dayOffset = parseInt(document.getElementById('nteDayOffset').value, 10);
  const subject = document.getElementById('nteSubject').value.trim();
  const body = document.getElementById('nteBody').value;
  const filter = document.getElementById('nteFilter').value || null;
  const notes = document.getElementById('nteNotes').value.trim() || null;
  const isActive = document.getElementById('nteIsActive').checked;

  // Basic validation
  if (!Number.isInteger(dayOffset) || dayOffset < 0) {
    showEditorError('Day offset must be a non-negative integer.');
    return;
  }
  if (!subject) {
    showEditorError('Subject is required.');
    return;
  }
  if (!body.trim()) {
    showEditorError('Body is required.');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const payload = {
      phase,
      day_offset: dayOffset,
      subject,
      body_md: body,
      project_type_filter: filter,
      is_active: isActive,
      notes,
      updated_at: new Date().toISOString(),
    };

    if (ctx.editing) {
      const { error } = await supabase
        .from('nurture_templates')
        .update(payload)
        .eq('id', ctx.editing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('nurture_templates')
        .insert(payload);
      if (error) throw error;
    }

    closeEditor();
    await loadTemplates();
    render();
  } catch (err) {
    console.error('[nurture-templates] save failed:', err);
    let msg = err.message || 'Could not save template.';
    // 23505 = unique_violation. The unique constraint is
    // (phase, day_offset, project_type_filter) NULLS NOT DISTINCT.
    if (err.code === '23505') {
      msg = 'A template already exists with that phase, day-offset, and project type filter. Each combination must be unique — change one of the three, or edit the existing template instead.';
    }
    showEditorError(msg);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

function showEditorError(msg) {
  const errEl = document.getElementById('nteError');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('ntContent').innerHTML =
    `<div class="nt-error">${escapeHtml(msg)}</div>`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
