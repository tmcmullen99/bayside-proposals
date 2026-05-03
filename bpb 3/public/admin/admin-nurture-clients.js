// ═══════════════════════════════════════════════════════════════════════════
// admin-nurture-clients.js — Sprint 14A
//
// Nurture pipeline visibility at /admin/nurture-clients.html.
// Lists all clients with current phase + days in phase + project type tags,
// filterable by phase. Per-client override modal lets master change phase,
// add/edit project types, pause until a date, or opt out entirely.
//
// Sprint 14A scope: visibility + manual override only. No email sending.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';

const PHASE_LABELS = {
  pre_consult: 'Pre-consult',
  design_in_progress: 'Design in progress',
  post_review: 'Post-review',
  cooling: 'Cooling',
  dead: 'Dead',
  signed: 'Signed',
  paused: 'Paused',
};

const PHASE_ICONS = {
  design_in_progress: '✏️',
  post_review: '👀',
  cooling: '🧊',
  dead: '💤',
  signed: '✅',
  paused: '⏸',
  pre_consult: '📅',
};

const PROJECT_TYPES = [
  { value: 'pavers', label: 'Pavers' },
  { value: 'driveway', label: 'Driveway' },
  { value: 'turf', label: 'Turf' },
  { value: 'walls', label: 'Walls' },
  { value: 'drainage', label: 'Drainage' },
  { value: 'pool_deck', label: 'Pool deck' },
  { value: 'fire_features', label: 'Fire features' },
  { value: 'lighting', label: 'Lighting' },
  { value: 'other', label: 'Other' },
];

const ctx = {
  viewer: null,
  clients: [],
  filter: 'all',
  editing: null,  // { client, types: Set }
};

(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.viewer = { ...auth.user, role: auth.profile.role };

  await loadClients();
  render();
  wireOverrideModal();
})();

async function loadClients() {
  const { data, error } = await supabase
    .from('clients')
    .select(`
      id, name, email, user_id, created_at,
      current_nurture_phase, phase_entered_at,
      nurture_paused_until, nurture_opted_out_at,
      project_types:client_project_types(project_type)
    `)
    .order('phase_entered_at', { ascending: false, nullsFirst: false });

  if (error) {
    console.error('[nurture-clients] load failed:', error);
    showError('Could not load clients: ' + error.message);
    return;
  }

  ctx.clients = (data || []).map(c => ({
    ...c,
    projectTypes: (c.project_types || []).map(pt => pt.project_type),
  }));
}

function render() {
  const counts = {
    all: ctx.clients.length,
    design_in_progress: 0,
    post_review: 0,
    cooling: 0,
    dead: 0,
    signed: 0,
    none: 0,
  };
  for (const c of ctx.clients) {
    if (!c.current_nurture_phase) counts.none++;
    else if (counts[c.current_nurture_phase] !== undefined) counts[c.current_nurture_phase]++;
  }

  const filters = [
    ['all', 'All'],
    ['design_in_progress', 'In progress'],
    ['post_review', 'Post-review'],
    ['cooling', 'Cooling'],
    ['dead', 'Dead'],
    ['signed', 'Signed'],
    ['none', 'Not enrolled'],
  ];

  const filtersHtml = filters.map(([key, label]) => {
    const count = counts[key] || 0;
    const cls = ctx.filter === key ? 'nu-filter active' : 'nu-filter';
    return `
      <button class="${cls}" data-filter="${escapeAttr(key)}">
        ${escapeHtml(label)}<span class="nu-filter-count">${count}</span>
      </button>
    `;
  }).join('');

  const visibleClients = ctx.filter === 'all'
    ? ctx.clients
    : ctx.filter === 'none'
      ? ctx.clients.filter(c => !c.current_nurture_phase)
      : ctx.clients.filter(c => c.current_nurture_phase === ctx.filter);

  let tableHtml;
  if (visibleClients.length === 0) {
    tableHtml = `<div class="nu-empty">No clients in this phase.</div>`;
  } else {
    tableHtml = `<div class="nu-table">${visibleClients.map(renderRow).join('')}</div>`;
  }

  document.getElementById('nuContent').innerHTML = `
    <div class="nu-filters">${filtersHtml}</div>
    ${tableHtml}
  `;

  document.querySelectorAll('.nu-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      ctx.filter = btn.dataset.filter;
      render();
    });
  });

  document.querySelectorAll('[data-action="edit-nurture"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const clientId = btn.dataset.clientId;
      const client = ctx.clients.find(c => c.id === clientId);
      if (client) openOverrideModal(client);
    });
  });
}

function renderRow(client) {
  const phase = client.current_nurture_phase;
  const phaseLabel = phase ? PHASE_LABELS[phase] || phase : '— None —';
  const phaseIcon = phase ? PHASE_ICONS[phase] || '' : '';
  const phaseClass = phase ? `nu-phase-${phase}` : 'nu-phase-none';

  let daysHtml = '';
  if (phase && client.phase_entered_at) {
    const days = Math.floor((Date.now() - new Date(client.phase_entered_at).getTime()) / 86400000);
    const dayLabel = days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
    daysHtml = `<div class="nu-days"><strong>${escapeHtml(dayLabel)}</strong> in phase</div>`;
  }

  let pausedHtml = '';
  if (client.nurture_paused_until && new Date(client.nurture_paused_until) > new Date()) {
    pausedHtml = `<div class="nu-days" style="color: #7a5a10;">⏸ Paused until ${formatDate(client.nurture_paused_until)}</div>`;
  }
  if (client.nurture_opted_out_at) {
    pausedHtml = `<div class="nu-days" style="color: var(--danger);">🚫 Opted out</div>`;
  }

  let typesHtml;
  if (client.projectTypes.length === 0) {
    typesHtml = `<span class="nu-type-tag empty" data-action="edit-nurture" data-client-id="${escapeAttr(client.id)}">+ Add project type</span>`;
  } else {
    typesHtml = client.projectTypes.map(pt => {
      const label = (PROJECT_TYPES.find(p => p.value === pt) || {}).label || pt;
      return `<span class="nu-type-tag">${escapeHtml(label)}</span>`;
    }).join('');
  }

  return `
    <div class="nu-row">
      <div>
        <div class="nu-row-name">${escapeHtml(client.name || '(unnamed)')}</div>
        <div class="nu-row-email">${escapeHtml(client.email || '')}</div>
        <div class="nu-types">${typesHtml}</div>
      </div>
      <div>
        <span class="nu-phase-pill ${phaseClass}">
          ${phaseIcon ? phaseIcon + ' ' : ''}${escapeHtml(phaseLabel)}
        </span>
        ${pausedHtml}
      </div>
      <div>
        ${daysHtml}
      </div>
      <div class="nu-row-actions">
        <a class="nu-btn" href="/admin/client.html?id=${escapeAttr(client.id)}">Open</a>
        <button class="nu-btn" data-action="edit-nurture" data-client-id="${escapeAttr(client.id)}">
          <span class="nu-btn-icon">⚙</span> Override
        </button>
      </div>
    </div>
  `;
}

// ─── Override modal ───────────────────────────────────────────────────────
function wireOverrideModal() {
  const overlay = document.getElementById('nuoOverlay');
  document.getElementById('nuoCancel').addEventListener('click', closeOverrideModal);
  document.getElementById('nuoSave').addEventListener('click', saveOverride);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOverrideModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) closeOverrideModal();
  });

  const grid = document.getElementById('nuoTypesGrid');
  grid.innerHTML = PROJECT_TYPES.map(pt => `
    <label class="nuo-type-check" data-type="${escapeAttr(pt.value)}">
      <input type="checkbox" value="${escapeAttr(pt.value)}">
      ${escapeHtml(pt.label)}
    </label>
  `).join('');

  grid.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const wrap = cb.closest('.nuo-type-check');
      wrap.classList.toggle('checked', cb.checked);
    });
  });
}

function openOverrideModal(client) {
  ctx.editing = client;
  document.getElementById('nuoTitle').textContent = `Override: ${client.name || '(unnamed)'}`;
  document.getElementById('nuoPhase').value = client.current_nurture_phase || '';
  document.getElementById('nuoPauseUntil').value = client.nurture_paused_until
    ? new Date(client.nurture_paused_until).toISOString().slice(0, 10)
    : '';
  document.getElementById('nuoOptOut').checked = !!client.nurture_opted_out_at;

  const errEl = document.getElementById('nuoError');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  document.querySelectorAll('#nuoTypesGrid input[type=checkbox]').forEach(cb => {
    cb.checked = client.projectTypes.includes(cb.value);
    cb.closest('.nuo-type-check').classList.toggle('checked', cb.checked);
  });

  document.getElementById('nuoOverlay').classList.add('visible');
}

function closeOverrideModal() {
  document.getElementById('nuoOverlay').classList.remove('visible');
  ctx.editing = null;
}

async function saveOverride() {
  if (!ctx.editing) return;
  const client = ctx.editing;
  const errEl = document.getElementById('nuoError');
  const saveBtn = document.getElementById('nuoSave');
  errEl.classList.add('hidden');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const phase = document.getElementById('nuoPhase').value || null;
    const pauseUntil = document.getElementById('nuoPauseUntil').value || null;
    const optOut = document.getElementById('nuoOptOut').checked;
    const selectedTypes = Array.from(
      document.querySelectorAll('#nuoTypesGrid input[type=checkbox]:checked')
    ).map(cb => cb.value);

    // Update clients row — phase change resets phase_entered_at
    const phaseChanging = phase !== client.current_nurture_phase;
    const update = {
      current_nurture_phase: phase,
      nurture_paused_until: pauseUntil ? new Date(pauseUntil).toISOString() : null,
      nurture_opted_out_at: optOut
        ? (client.nurture_opted_out_at || new Date().toISOString())
        : null,
    };
    if (phaseChanging) {
      update.phase_entered_at = phase ? new Date().toISOString() : null;
    }

    const { error: clientErr } = await supabase
      .from('clients')
      .update(update)
      .eq('id', client.id);
    if (clientErr) throw clientErr;

    // Diff project types: delete removed, insert added
    const existing = new Set(client.projectTypes);
    const desired = new Set(selectedTypes);
    const toDelete = [...existing].filter(t => !desired.has(t));
    const toInsert = [...desired].filter(t => !existing.has(t));

    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from('client_project_types')
        .delete()
        .eq('client_id', client.id)
        .in('project_type', toDelete);
      if (delErr) throw delErr;
    }

    if (toInsert.length > 0) {
      const rows = toInsert.map(pt => ({ client_id: client.id, project_type: pt }));
      const { error: insErr } = await supabase
        .from('client_project_types')
        .insert(rows);
      if (insErr) throw insErr;
    }

    closeOverrideModal();
    await loadClients();
    render();
  } catch (err) {
    console.error('[nurture-clients] save failed:', err);
    errEl.textContent = err.message || 'Could not save changes.';
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('nuContent').innerHTML =
    `<div class="nu-error">${escapeHtml(msg)}</div>`;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
