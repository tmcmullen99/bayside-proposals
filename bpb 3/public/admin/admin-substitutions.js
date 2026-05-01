// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-substitutions.js — Phase 4 closeout
//
// Designer view for homeowner material swap submissions. Lists every row
// in proposal_substitutions with full nested item detail (regions, original
// materials, replacement materials), and lets designers mark each one
// applied / reviewed / rejected with an optional designer_response that
// the homeowner sees in the customize overlay.
//
// RLS on proposal_substitutions already restricts SELECT/UPDATE to
// designer/master roles, so direct supabase queries from the client are
// safe. The customize overlay (p-customize.js) writes submissions via the
// homeowner's authenticated session — that side gets a separate policy.
//
// Status state machine:
//   submitted → reviewed → applied
//   submitted → rejected
//   submitted → applied   (skip reviewed)
//   any → superseded      (only via DB / Phase 5+ — not exposed here)
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import { requireDesigner } from '/js/auth-util.js';

const ctx = {
  userId: null,
  submissions: [],
  filter: 'pending', // pending | all | resolved
  expandedIds: new Set(),
};

const els = {
  content: document.getElementById('subContent'),
  status: document.getElementById('subStatus'),
  filter: document.getElementById('subFilter'),
  refreshBtn: document.getElementById('subRefreshBtn'),
  statPending: document.getElementById('subStatPending'),
  statReviewedToday: document.getElementById('subStatReviewedToday'),
  statAppliedWeek: document.getElementById('subStatAppliedWeek'),
  statTotal: document.getElementById('subStatTotal'),
};

// ─── Bootstrap ──────────────────────────────────────────────────────────
(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;
  ctx.userId = auth.user.id;

  els.filter.addEventListener('change', (e) => {
    ctx.filter = e.target.value;
    render();
  });
  els.refreshBtn.addEventListener('click', () => reloadAll());

  await reloadAll();
})();

async function reloadAll() {
  await Promise.all([loadStats(), loadSubmissions()]);
  render();
}

// ─── Data ───────────────────────────────────────────────────────────────
async function loadStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [pending, reviewedToday, appliedWeek, total] = await Promise.all([
    supabase.from('proposal_substitutions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'submitted'),
    supabase.from('proposal_substitutions')
      .select('id', { count: 'exact', head: true })
      .gte('reviewed_at', todayStart.toISOString())
      .neq('status', 'submitted'),
    supabase.from('proposal_substitutions')
      .select('id', { count: 'exact', head: true })
      .gte('reviewed_at', weekAgo.toISOString())
      .eq('status', 'applied'),
    supabase.from('proposal_substitutions')
      .select('id', { count: 'exact', head: true }),
  ]);

  els.statPending.textContent = formatCount(pending.count);
  els.statReviewedToday.textContent = formatCount(reviewedToday.count);
  els.statAppliedWeek.textContent = formatCount(appliedWeek.count);
  els.statTotal.textContent = formatCount(total.count);
}

async function loadSubmissions() {
  // Big nested query: substitution → items → region/proposal_material →
  // (materials | belgard_materials | third_party_materials), and the
  // replacement (materials directly). The supabase JS client resolves
  // the explicit ! aliases against the FK constraint names.
  const { data, error } = await supabase
    .from('proposal_substitutions')
    .select(`
      id, status, homeowner_note, designer_response, reviewed_at,
      created_at, updated_at, published_proposal_id, proposal_id, client_id,
      proposal:proposals!proposal_id(id, address, project_address, project_city),
      client:clients!client_id(id, name, email, phone),
      reviewer:profiles!reviewed_by(id, display_name, email),
      published:published_proposals!published_proposal_id(id, slug, published_at),
      items:proposal_substitution_items(
        id, homeowner_note, replacement_material_id, created_at,
        region_material:proposal_region_materials!proposal_region_material_id(
          id,
          proposal_material:proposal_materials!proposal_material_id(
            id, override_product_name, override_color, application_area, material_source,
            material:materials!material_id(id, manufacturer, product_name, color, swatch_url, primary_image_url),
            belgard_material:belgard_materials!belgard_material_id(id, product_name, color, swatch_url, primary_image_url),
            third_party_material:third_party_materials!third_party_material_id(id, manufacturer, product_name, color, image_url, primary_image_url)
          ),
          region:proposal_regions!region_id(id, name)
        ),
        replacement:materials!replacement_material_id(id, manufacturer, product_name, color, swatch_url, primary_image_url)
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[admin-substitutions] load failed:', error);
    showStatus('error', 'Could not load submissions: ' + error.message);
    ctx.submissions = [];
    return;
  }
  ctx.submissions = data || [];
}

// ─── Render ─────────────────────────────────────────────────────────────
function render() {
  const visible = filterSubmissions(ctx.submissions, ctx.filter);

  if (visible.length === 0) {
    els.content.innerHTML = renderEmpty(ctx.filter, ctx.submissions.length);
    return;
  }

  els.content.innerHTML = `
    <div class="sub-list">
      ${visible.map(renderCard).join('')}
    </div>
  `;
  wireCardHandlers();
}

function filterSubmissions(list, filter) {
  if (filter === 'pending') {
    return list.filter(s => s.status === 'submitted' || s.status === 'reviewed');
  }
  if (filter === 'resolved') {
    return list.filter(s => s.status === 'applied' || s.status === 'rejected' || s.status === 'superseded');
  }
  return list;
}

function renderCard(s) {
  const isExpanded = ctx.expandedIds.has(s.id);
  const isUrgent = s.status === 'submitted';
  const proposalAddress = (s.proposal && (s.proposal.address || s.proposal.project_address)) || 'Untitled proposal';
  const clientName = (s.client && s.client.name) || 'Unknown client';
  const itemCount = (s.items || []).length;

  return `
    <div class="sub-card ${isExpanded ? 'is-expanded' : ''} ${isUrgent ? 'is-urgent' : ''}" data-sub-id="${escapeAttr(s.id)}">
      <div class="sub-card-header">
        <span class="sub-card-status sub-status-${s.status}">${escapeHtml(s.status)}</span>
        <div class="sub-card-headline">
          <div class="sub-card-client">${escapeHtml(clientName)}</div>
          <div class="sub-card-proposal">${escapeHtml(proposalAddress)}</div>
        </div>
        <div class="sub-card-meta">
          ${itemCount} ${itemCount === 1 ? 'item' : 'items'}
          <div class="sub-card-time">${escapeHtml(formatRelative(s.created_at))}</div>
        </div>
        <span class="sub-card-chevron">›</span>
      </div>
      <div class="sub-card-body">
        ${renderProposalRow(s)}
        ${renderItems(s)}
        ${renderHomeownerNote(s)}
        ${renderDesignerResponse(s)}
        ${renderActions(s)}
        ${renderReviewerFooter(s)}
      </div>
    </div>
  `;
}

function renderProposalRow(s) {
  const slug = s.published && s.published.slug;
  const proposalLink = slug
    ? `<a href="/p/${escapeAttr(slug)}" target="_blank" rel="noopener">View proposal /p/${escapeHtml(slug)} ↗</a>`
    : '<span style="color:var(--muted-soft);">No published version</span>';
  const engagementLink = s.proposal && s.proposal.id
    ? `<a href="/admin/engagement.html?id=${escapeAttr(s.proposal.id)}">📊 View engagement</a>`
    : '';
  const clientEmail = s.client && s.client.email
    ? `<span style="font-family:'JetBrains Mono',monospace; color:var(--muted);">${escapeHtml(s.client.email)}</span>`
    : '';

  return `
    <div class="sub-section">
      <div class="sub-meta-row">
        ${proposalLink}
        ${engagementLink}
        ${clientEmail}
      </div>
    </div>
  `;
}

function renderItems(s) {
  const items = s.items || [];
  if (items.length === 0) {
    return '<div class="sub-section"><div class="sub-section-h">Items</div><div style="color:var(--muted-soft); font-size:13px;">No items in this submission.</div></div>';
  }
  return `
    <div class="sub-section">
      <div class="sub-section-h">Requested swaps (${items.length})</div>
      <div class="sub-items">
        ${items.map(renderItem).join('')}
      </div>
    </div>
  `;
}

function renderItem(item) {
  const region = item.region_material && item.region_material.region;
  const regionLabel = (region && region.name) || 'Unlabeled region';
  const original = getOriginalMaterialDisplay(item);
  const replacement = getReplacementDisplay(item);

  const originalHtml = `
    <div class="sub-material">
      ${original.imageUrl
        ? `<img class="sub-material-swatch" src="${escapeAttr(original.imageUrl)}" alt="">`
        : '<div class="sub-material-placeholder"></div>'}
      <div class="sub-material-info">
        <div class="sub-material-name">${escapeHtml(original.name)}</div>
        ${original.color ? `<div class="sub-material-color">${escapeHtml(original.color)}</div>` : ''}
      </div>
    </div>
  `;

  const replacementHtml = replacement
    ? `
      <div class="sub-material">
        ${replacement.imageUrl
          ? `<img class="sub-material-swatch" src="${escapeAttr(replacement.imageUrl)}" alt="">`
          : '<div class="sub-material-placeholder"></div>'}
        <div class="sub-material-info">
          <div class="sub-material-name">${escapeHtml(replacement.name)}</div>
          ${replacement.color ? `<div class="sub-material-color">${escapeHtml(replacement.color)}</div>` : ''}
        </div>
      </div>
    `
    : '<div class="sub-material-remove">Remove this material</div>';

  const itemNote = item.homeowner_note
    ? `<div class="sub-item-note">"${escapeHtml(item.homeowner_note)}"</div>`
    : '';

  return `
    <div class="sub-item">
      <div class="sub-item-region">${escapeHtml(regionLabel)}</div>
      <div class="sub-item-swap">
        ${originalHtml}
        <div class="sub-item-arrow">→</div>
        ${replacementHtml}
      </div>
      ${itemNote}
    </div>
  `;
}

function renderHomeownerNote(s) {
  if (!s.homeowner_note) return '';
  return `
    <div class="sub-section">
      <div class="sub-section-h">Homeowner note</div>
      <div class="sub-note-block">${escapeHtml(s.homeowner_note)}</div>
    </div>
  `;
}

function renderDesignerResponse(s) {
  if (!s.designer_response) return '';
  return `
    <div class="sub-section">
      <div class="sub-section-h">Your response</div>
      <div class="sub-note-block is-response">${escapeHtml(s.designer_response)}</div>
    </div>
  `;
}

function renderActions(s) {
  // Only submitted and reviewed allow further action.
  if (s.status !== 'submitted' && s.status !== 'reviewed') return '';

  const reviewBtn = s.status === 'submitted'
    ? `<button class="sub-action-btn sub-action-review" data-action="review" data-sub-id="${escapeAttr(s.id)}">Mark reviewed</button>`
    : '';

  return `
    <div class="sub-actions">
      <button class="sub-action-btn sub-action-apply" data-action="apply" data-sub-id="${escapeAttr(s.id)}">Mark applied</button>
      ${reviewBtn}
      <button class="sub-action-btn sub-action-reject" data-action="reject" data-sub-id="${escapeAttr(s.id)}">Reject</button>
    </div>
  `;
}

function renderReviewerFooter(s) {
  if (s.status === 'submitted') return '';
  const reviewer = s.reviewer;
  const reviewerName = (reviewer && (reviewer.display_name || reviewer.email)) || 'a designer';
  const when = s.reviewed_at ? formatExact(s.reviewed_at) : '';
  return `
    <div class="sub-reviewed-footer">
      Marked <strong>${escapeHtml(s.status)}</strong> by ${escapeHtml(reviewerName)}${when ? ' on ' + escapeHtml(when) : ''}
    </div>
  `;
}

function renderEmpty(filter, totalCount) {
  if (totalCount === 0) {
    return `
      <div class="sub-empty">
        <div class="sub-empty-title">No substitutions yet</div>
        <div>Homeowner swap requests will appear here when they use the Customize feature on a proposal page.</div>
      </div>
    `;
  }
  const filterLabel = filter === 'pending' ? 'pending' : (filter === 'resolved' ? 'resolved' : 'matching');
  return `
    <div class="sub-empty">
      <div class="sub-empty-title">No ${filterLabel} submissions</div>
      <div>Try a different filter, or check back when homeowners submit new swap requests.</div>
    </div>
  `;
}

// ─── Event wiring ───────────────────────────────────────────────────────
function wireCardHandlers() {
  // Toggle expand on header click
  els.content.querySelectorAll('.sub-card').forEach(card => {
    const subId = card.dataset.subId;
    const header = card.querySelector('.sub-card-header');
    header.addEventListener('click', (e) => {
      // Don't toggle when clicking action buttons or links
      if (e.target.closest('button, a')) return;
      if (ctx.expandedIds.has(subId)) {
        ctx.expandedIds.delete(subId);
      } else {
        ctx.expandedIds.add(subId);
      }
      card.classList.toggle('is-expanded');
    });

    // Action buttons
    card.querySelectorAll('.sub-action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const subId = btn.dataset.subId;
        const submission = ctx.submissions.find(s => s.id === subId);
        if (!submission) return;
        if (action === 'apply')  await handleApply(submission, btn);
        if (action === 'review') await handleReview(submission, btn);
        if (action === 'reject') await handleReject(submission, btn);
      });
    });
  });
}

// ─── Action handlers ────────────────────────────────────────────────────
async function handleApply(submission, btn) {
  const existing = submission.designer_response || '';
  const response = window.prompt(
    'Optional: add a note for the homeowner explaining the change.\n' +
    'Example: "Re-bid coming Friday — new total reflects the swap."\n\n' +
    'Click OK with no text to skip the note.',
    existing
  );
  if (response === null) return; // canceled
  await updateStatus(submission.id, 'applied', response.trim() || null, btn);
}

async function handleReview(submission, btn) {
  if (!confirm('Mark this submission as reviewed? You can still mark it applied or rejected later.')) return;
  await updateStatus(submission.id, 'reviewed', null, btn);
}

async function handleReject(submission, btn) {
  const existing = submission.designer_response || '';
  const response = window.prompt(
    'Required: explain to the homeowner why this swap won\'t be made.\n' +
    'They will see this response in their proposal.',
    existing
  );
  if (response === null) return;
  if (!response.trim()) {
    alert('A reason is required when rejecting a submission.');
    return;
  }
  await updateStatus(submission.id, 'rejected', response.trim(), btn);
}

async function updateStatus(submissionId, status, designerResponse, btn) {
  if (btn) {
    btn.disabled = true;
    var originalText = btn.textContent;
    btn.textContent = 'Saving…';
  }

  const update = {
    status,
    reviewed_by: ctx.userId,
    reviewed_at: new Date().toISOString(),
  };
  // Only overwrite designer_response when an actual value is provided (or
  // explicitly null for "applied" without a note — keeps any prior response
  // if the user re-saves with empty input).
  if (designerResponse !== null && designerResponse !== undefined) {
    update.designer_response = designerResponse;
  } else if (status === 'applied' || status === 'rejected') {
    // applied/rejected with no new note: preserve existing if any
  }

  const { error } = await supabase
    .from('proposal_substitutions')
    .update(update)
    .eq('id', submissionId);

  if (error) {
    showStatus('error', 'Could not update: ' + error.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
    return;
  }

  showStatus('success', `Marked as ${status}.`);
  await reloadAll();
}

// ─── Helpers ────────────────────────────────────────────────────────────
function getOriginalMaterialDisplay(item) {
  const pm = item.region_material && item.region_material.proposal_material;
  if (!pm) return { name: 'Unknown material', color: '', manufacturer: '', imageUrl: null };

  let source = null;
  if (pm.material_source === 'third_party' && pm.third_party_material) {
    source = pm.third_party_material;
  } else if (pm.belgard_material) {
    source = pm.belgard_material;
  } else if (pm.material) {
    source = pm.material;
  } else if (pm.third_party_material) {
    source = pm.third_party_material;
  }

  return {
    name: pm.override_product_name || (source && source.product_name) || 'Unknown product',
    color: pm.override_color || (source && source.color) || '',
    manufacturer: (source && source.manufacturer) || '',
    imageUrl: (source && (source.swatch_url || source.primary_image_url || source.image_url)) || null,
  };
}

function getReplacementDisplay(item) {
  const r = item.replacement;
  if (!r) return null; // null replacement_material_id = remove
  return {
    name: r.product_name || 'Unknown',
    color: r.color || '',
    manufacturer: r.manufacturer || '',
    imageUrl: r.swatch_url || r.primary_image_url || null,
  };
}

function formatCount(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
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
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatExact(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function showStatus(type, msg) {
  els.status.className = 'sub-status is-' + type;
  els.status.textContent = msg;
  els.status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (type === 'success') {
    setTimeout(() => {
      if (els.status.textContent === msg) {
        els.status.className = 'sub-status';
        els.status.textContent = '';
      }
    }, 5000);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
