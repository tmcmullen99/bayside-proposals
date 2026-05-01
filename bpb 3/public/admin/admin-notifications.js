// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-notifications.js — Phase 5F.3
//
// Designer-facing notification preferences. Shows three preference toggles
// (first-view emails, daily digest, quiet hours) plus a recent send log
// pulled from notification_log.
//
// Preferences live in profiles.notification_prefs (JSONB). Updates use the
// caller's authenticated session so RLS on profiles applies — designers
// can only edit their own row.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';

const DEFAULT_PREFS = {
  first_view: true,
  daily_digest: true,
  quiet_hours_enabled: false,
  quiet_hours_start: 22,
  quiet_hours_end: 7,
};

const ctx = {
  userId: null,
  email: null,
  prefs: { ...DEFAULT_PREFS },
  initialPrefs: { ...DEFAULT_PREFS },
  recentLog: [],
};

const els = {
  content: document.getElementById('ntfContent'),
  status: document.getElementById('ntfStatus'),
};

// ─── Bootstrap ──────────────────────────────────────────────────────────
(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.userId = auth.user.id;
  ctx.email = auth.profile.email;

  await Promise.all([loadPrefs(), loadRecentLog()]);
  render();
})();

async function loadPrefs() {
  const { data, error } = await supabase
    .from('profiles')
    .select('notification_prefs')
    .eq('id', ctx.userId)
    .maybeSingle();
  if (error) {
    showStatus('error', 'Could not load preferences: ' + error.message);
    return;
  }
  ctx.prefs = { ...DEFAULT_PREFS, ...((data && data.notification_prefs) || {}) };
  ctx.initialPrefs = { ...ctx.prefs };
}

async function loadRecentLog() {
  const { data, error } = await supabase
    .from('notification_log')
    .select('id, kind, status, sent_at, error_message, payload, proposal_id')
    .eq('recipient_email', ctx.email)
    .order('sent_at', { ascending: false })
    .limit(20);
  if (error) {
    console.warn('[5F.3] could not load notification_log:', error.message);
    ctx.recentLog = [];
    return;
  }
  ctx.recentLog = data || [];
}

// ─── Render ─────────────────────────────────────────────────────────────
function render() {
  els.content.innerHTML = `
    ${renderPrefsCard()}
    ${renderActivityCard()}
  `;
  wireHandlers();
  refreshQuietPanelVisibility();
  refreshSaveButtonState();
  refreshQuietHoursNow();
}

function renderPrefsCard() {
  return `
    <div class="ntf-card">
      <h2 class="ntf-card-title">Email preferences</h2>
      <p class="ntf-card-desc">Notifications go to <strong>${escapeHtml(ctx.email)}</strong>. Changes take effect immediately on save.</p>

      <div class="ntf-toggle-row">
        <div class="ntf-toggle-info">
          <div class="ntf-toggle-name">First-view emails</div>
          <div class="ntf-toggle-sub">Fires when a new device opens one of your proposals. Rate-limited to one email per proposal per hour, so a homeowner refreshing won't spam your inbox.</div>
        </div>
        <label class="ntf-switch">
          <input type="checkbox" id="ntfFirstView" ${ctx.prefs.first_view ? 'checked' : ''}>
          <span class="ntf-slider"></span>
        </label>
      </div>

      <div class="ntf-toggle-row">
        <div class="ntf-toggle-info">
          <div class="ntf-toggle-name">Daily digest</div>
          <div class="ntf-toggle-sub">Once a day at 8am Pacific, you get a summary of yesterday's activity across all your proposals. Silent on days with no activity.</div>
        </div>
        <label class="ntf-switch">
          <input type="checkbox" id="ntfDailyDigest" ${ctx.prefs.daily_digest ? 'checked' : ''}>
          <span class="ntf-slider"></span>
        </label>
      </div>

      <div class="ntf-toggle-row">
        <div class="ntf-toggle-info">
          <div class="ntf-toggle-name">Quiet hours</div>
          <div class="ntf-toggle-sub">Pause first-view emails overnight. Daily digests aren't affected because they fire at a fixed time.</div>
        </div>
        <label class="ntf-switch">
          <input type="checkbox" id="ntfQuietEnabled" ${ctx.prefs.quiet_hours_enabled ? 'checked' : ''}>
          <span class="ntf-slider"></span>
        </label>
      </div>

      <div class="ntf-quiet ${ctx.prefs.quiet_hours_enabled ? 'is-visible' : ''}" id="ntfQuietPanel">
        <div class="ntf-quiet-row">
          <span>From</span>
          <select class="ntf-quiet-select" id="ntfQuietStart">
            ${renderHourOptions(ctx.prefs.quiet_hours_start)}
          </select>
          <span>to</span>
          <select class="ntf-quiet-select" id="ntfQuietEnd">
            ${renderHourOptions(ctx.prefs.quiet_hours_end)}
          </select>
          <span class="ntf-quiet-tz">America/Los_Angeles</span>
        </div>
        <div class="ntf-quiet-now" id="ntfQuietNow"></div>
      </div>

      <div class="ntf-save-bar">
        <span class="ntf-save-spacer"></span>
        <button type="button" class="ntf-save-btn-ghost" id="ntfRevert" disabled>Revert</button>
        <button type="button" class="ntf-save-btn" id="ntfSave" disabled>Save changes</button>
      </div>
    </div>
  `;
}

function renderActivityCard() {
  const empty = ctx.recentLog.length === 0;
  return `
    <div class="ntf-card">
      <h2 class="ntf-card-title">Recent notification activity</h2>
      <p class="ntf-card-desc">The last 20 send attempts to your address. Skipped sends are recorded too — useful for confirming rate limits and quiet hours did what you expected.</p>
      ${empty
        ? '<div class="ntf-empty">No notification activity yet. The first email will arrive when a homeowner views one of your proposals.</div>'
        : `
          <table class="ntf-log-table">
            <thead>
              <tr>
                <th style="width: 130px;">Sent</th>
                <th style="width: 120px;">Kind</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              ${ctx.recentLog.map(renderLogRow).join('')}
            </tbody>
          </table>
        `}
    </div>
  `;
}

function renderLogRow(row) {
  const statusClass = 'ntf-log-status-' + row.status;
  const statusLabel = row.status.replace(/_/g, ' ');
  const detail = buildLogDetail(row);
  return `
    <tr>
      <td><span class="ntf-log-mono">${escapeHtml(formatRelative(row.sent_at))}</span></td>
      <td><span class="ntf-log-mono">${escapeHtml(row.kind)}</span></td>
      <td><span class="ntf-log-status ${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td>${detail}</td>
    </tr>
  `;
}

function buildLogDetail(row) {
  if (row.status === 'failed' && row.error_message) {
    return `<span style="color:var(--danger-fg); font-size:12px;">${escapeHtml(row.error_message.slice(0, 120))}</span>`;
  }
  if (row.kind === 'daily_digest' && row.payload) {
    const p = row.payload;
    if (p.proposal_count != null) {
      return `<span style="color:var(--muted); font-size:12px;">${p.proposal_count} proposals · ${p.total_events || 0} events</span>`;
    }
  }
  if (row.kind === 'first_view' && row.proposal_id) {
    return `<a href="/admin/engagement.html?id=${escapeAttr(row.proposal_id)}" style="color:var(--green-dark); font-size:12px; text-decoration:none;">View engagement →</a>`;
  }
  return '<span style="color:var(--muted-soft); font-size:12px;">—</span>';
}

function renderHourOptions(selected) {
  let html = '';
  for (let h = 0; h < 24; h++) {
    const label = formatHour12(h);
    html += `<option value="${h}" ${h === selected ? 'selected' : ''}>${label}</option>`;
  }
  return html;
}

function formatHour12(h) {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? (h + 'am') : ((h - 12) + 'pm');
}

// ─── Wiring ─────────────────────────────────────────────────────────────
function wireHandlers() {
  // All inputs feed into the same diff-vs-initial check.
  const inputIds = ['ntfFirstView', 'ntfDailyDigest', 'ntfQuietEnabled', 'ntfQuietStart', 'ntfQuietEnd'];
  inputIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      readPrefsFromForm();
      refreshQuietPanelVisibility();
      refreshSaveButtonState();
      refreshQuietHoursNow();
    });
  });

  document.getElementById('ntfSave').addEventListener('click', handleSave);
  document.getElementById('ntfRevert').addEventListener('click', handleRevert);
}

function readPrefsFromForm() {
  ctx.prefs.first_view = document.getElementById('ntfFirstView').checked;
  ctx.prefs.daily_digest = document.getElementById('ntfDailyDigest').checked;
  ctx.prefs.quiet_hours_enabled = document.getElementById('ntfQuietEnabled').checked;
  ctx.prefs.quiet_hours_start = parseInt(document.getElementById('ntfQuietStart').value, 10);
  ctx.prefs.quiet_hours_end = parseInt(document.getElementById('ntfQuietEnd').value, 10);
}

function refreshQuietPanelVisibility() {
  const panel = document.getElementById('ntfQuietPanel');
  if (!panel) return;
  panel.classList.toggle('is-visible', !!ctx.prefs.quiet_hours_enabled);
}

function refreshQuietHoursNow() {
  const el = document.getElementById('ntfQuietNow');
  if (!el || !ctx.prefs.quiet_hours_enabled) {
    if (el) el.textContent = '';
    return;
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
  });
  const nowLocal = fmt.format(new Date());
  const inQuiet = isInQuietRange(ctx.prefs.quiet_hours_start, ctx.prefs.quiet_hours_end);
  el.textContent = 'Right now in Pacific: ' + nowLocal + ' · ' + (inQuiet ? '🌙 quiet hours active' : '☀️ active hours');
}

function isInQuietRange(startHour, endHour) {
  if (typeof startHour !== 'number' || typeof endHour !== 'number') return false;
  if (startHour === endHour) return false;
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles',
  });
  const parts = fmt.formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === 'hour');
  const hour = hourPart ? parseInt(hourPart.value, 10) : new Date().getUTCHours();
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

function refreshSaveButtonState() {
  const dirty = JSON.stringify(ctx.prefs) !== JSON.stringify(ctx.initialPrefs);
  document.getElementById('ntfSave').disabled = !dirty;
  document.getElementById('ntfRevert').disabled = !dirty;
}

// ─── Save / Revert ──────────────────────────────────────────────────────
async function handleSave() {
  const saveBtn = document.getElementById('ntfSave');
  const revertBtn = document.getElementById('ntfRevert');
  saveBtn.disabled = true;
  revertBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  // Validate quiet hours before send: start === end means "always quiet,"
  // which is almost certainly user error. Block save with a friendly hint.
  if (ctx.prefs.quiet_hours_enabled && ctx.prefs.quiet_hours_start === ctx.prefs.quiet_hours_end) {
    showStatus('error', 'Quiet hours start and end must differ. Set different times or disable quiet hours.');
    saveBtn.disabled = false;
    revertBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({ notification_prefs: ctx.prefs })
    .eq('id', ctx.userId);

  saveBtn.textContent = 'Save changes';

  if (error) {
    showStatus('error', 'Could not save: ' + error.message);
    refreshSaveButtonState();
    return;
  }

  ctx.initialPrefs = { ...ctx.prefs };
  refreshSaveButtonState();
  showStatus('success', 'Preferences saved.');
}

function handleRevert() {
  ctx.prefs = { ...ctx.initialPrefs };
  // Re-render preserves DOM state simplicity at the cost of a flash. Cheap
  // enough at this scale and avoids per-input revert plumbing.
  render();
}

// ─── Helpers ────────────────────────────────────────────────────────────
function showStatus(type, msg) {
  els.status.className = 'ntf-status is-' + type;
  els.status.textContent = msg;
  els.status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (type === 'success') {
    setTimeout(() => {
      if (els.status.textContent === msg) {
        els.status.className = 'ntf-status';
        els.status.textContent = '';
      }
    }, 4000);
  }
}

function formatRelative(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  if (diff < 604_800_000) return Math.floor(diff / 86_400_000) + 'd ago';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
