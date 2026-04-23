// ═══════════════════════════════════════════════════════════════════════════
// client-dashboard.js
// Client dashboard — shows the authenticated homeowner's proposals.
//
// Flow:
//   1. requireClient() — redirect to login if unauthenticated
//   2. Load client record (linked to auth.uid())
//   3. Load client_proposals → proposals join
//   4. Render cards with status badges
//   5. On card click: mark proposal as 'viewed' (if not already), log activity,
//      then navigate to the public /p/{slug} page
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import {
  requireClient,
  isAdminUser,
  getClientRecord,
  signOut,
  logClientActivity,
} from '/js/auth-util.js';

// DOM
const loadingState = document.getElementById('loadingState');
const contentState = document.getElementById('contentState');
const adminBanner = document.getElementById('adminBanner');
const userEmailEl = document.getElementById('userEmail');
const welcomeTitle = document.getElementById('welcomeTitle');
const welcomeSubtitle = document.getElementById('welcomeSubtitle');
const proposalsGrid = document.getElementById('proposalsGrid');
const proposalsCount = document.getElementById('proposalsCount');
const signOutBtn = document.getElementById('signOutBtn');

// State
const ctx = {
  user: null,
  client: null,
  proposals: [], // array of { ...client_proposal, proposal: {...} }
};

// ── Bootstrap ──────────────────────────────────────────────────────────────
(async function init() {
  ctx.user = await requireClient();
  if (!ctx.user) return; // redirect happened

  userEmailEl.textContent = ctx.user.email;

  if (isAdminUser(ctx.user)) {
    adminBanner.style.display = 'block';
    // For admin preview, load Tim's sandbox — or show a simulation.
    // For Phase A simplicity, show an informational view.
    welcomeTitle.textContent = 'Admin preview';
    welcomeSubtitle.innerHTML =
      `You don't have a client record yet. To test this view, add yourself as a client at <a href="/admin/clients.html">admin/clients</a>.`;
    loadingState.style.display = 'none';
    contentState.style.display = 'block';
    proposalsCount.textContent = '0 proposals';
    proposalsGrid.innerHTML = renderEmptyState();
    return;
  }

  ctx.client = await getClientRecord(ctx.user);

  if (!ctx.client) {
    // User is authenticated but no clients row exists for this email. This
    // shouldn't normally happen — Tim would have to invite them first. Show
    // a helpful message rather than an empty dashboard.
    loadingState.style.display = 'none';
    contentState.style.display = 'block';
    welcomeTitle.textContent = 'Hi there';
    welcomeSubtitle.innerHTML =
      `We don't have a client account set up for <strong>${escapeHtml(ctx.user.email)}</strong> yet. If Tim invited you, check that you're signing in with the same email he used. Otherwise, email <a href="mailto:tim@mcmullen.properties">tim@mcmullen.properties</a>.`;
    proposalsGrid.innerHTML = '';
    proposalsCount.textContent = '';
    return;
  }

  await loadProposals();
  renderDashboard();
  loadingState.style.display = 'none';
  contentState.style.display = 'block';
})();

async function loadProposals() {
  const { data, error } = await supabase
    .from('client_proposals')
    .select(`
      id, status, sent_at, first_viewed_at, signed_at, created_at,
      proposal:proposals!proposal_id (
        id,
        address,
        created_at,
        published_proposals (id, slug, created_at)
      )
    `)
    .eq('client_id', ctx.client.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error loading proposals:', error);
    ctx.proposals = [];
    return;
  }
  ctx.proposals = data || [];
}

function renderDashboard() {
  const firstName = (ctx.client.name || '').split(/\s+/)[0] || 'there';
  welcomeTitle.textContent = `Welcome, ${firstName}`;
  welcomeSubtitle.textContent = ctx.proposals.length === 0
    ? "You don't have any proposals yet. Tim will send you one when it's ready."
    : `Here's the latest on your project${ctx.proposals.length > 1 ? 's' : ''} with Bayside Pavers.`;

  proposalsCount.textContent = `${ctx.proposals.length} proposal${ctx.proposals.length === 1 ? '' : 's'}`;

  if (ctx.proposals.length === 0) {
    proposalsGrid.innerHTML = renderEmptyState();
    return;
  }

  proposalsGrid.innerHTML = ctx.proposals.map(cp => renderProposalCard(cp)).join('');

  // Wire up click handlers
  proposalsGrid.querySelectorAll('.proposal-view-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const cpId = btn.dataset.cpId;
      const slug = btn.dataset.slug;
      handleProposalView(cpId, slug);
    });
  });
}

function renderProposalCard(cp) {
  const p = cp.proposal;
  if (!p) return ''; // proposal was deleted

  const statusLabel = {
    draft: 'Draft',
    sent: 'Sent',
    viewed: 'Viewed',
    signed: 'Signed',
    in_progress: 'In Progress',
    complete: 'Complete',
  }[cp.status] || cp.status;

  const sentDate = cp.sent_at
    ? new Date(cp.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Not sent yet';

  const slug = getLatestSlug(p);
  const viewButton = slug
    ? `<button class="btn proposal-view-btn"
               data-cp-id="${escapeAttr(cp.id)}"
               data-slug="${escapeAttr(slug)}">
         View proposal →
       </button>`
    : `<button class="btn" disabled style="opacity:0.5;cursor:not-allowed;">
         Not available yet
       </button>`;

  return `
    <div class="proposal-card">
      <div class="proposal-card-info">
        <div class="proposal-card-address">${escapeHtml(getDisplayAddress(p))}</div>
        <div class="proposal-card-meta">
          <span class="status-badge ${cp.status}">${escapeHtml(statusLabel)}</span>
          <span>Sent ${escapeHtml(sentDate)}</span>
        </div>
      </div>
      ${viewButton}
    </div>
  `;
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <h3>No proposals yet</h3>
      <p>When Tim creates a proposal for you, it'll appear here.</p>
    </div>
  `;
}

// ── Proposal view action ───────────────────────────────────────────────────
async function handleProposalView(cpId, slug) {
  // Mark as viewed (if not already) + log activity, fire-and-forget
  const cp = ctx.proposals.find(x => x.id === cpId);
  if (cp && !cp.first_viewed_at) {
    const now = new Date().toISOString();
    supabase
      .from('client_proposals')
      .update({
        first_viewed_at: now,
        status: cp.status === 'sent' ? 'viewed' : cp.status,
      })
      .eq('id', cpId)
      .then(({ error }) => {
        if (error) console.warn('Could not mark viewed:', error.message);
      });
  }

  logClientActivity(ctx.client.id, 'proposal_viewed', { slug }, cp?.proposal?.id);

  // Navigate to the public proposal page
  window.location.href = `/p/${slug}`;
}

// ── Sign out ───────────────────────────────────────────────────────────────
signOutBtn.addEventListener('click', async () => {
  await signOut();
});

// ── Slug / address helpers ─────────────────────────────────────────────────
function getLatestSlug(proposal) {
  const pubs = proposal?.published_proposals;
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  const sorted = [...pubs].sort((a, b) =>
    new Date(b.created_at || 0) - new Date(a.created_at || 0)
  );
  return sorted[0]?.slug || null;
}

function getDisplayAddress(proposal) {
  if (proposal?.address) return proposal.address;
  const slug = getLatestSlug(proposal);
  if (slug) {
    const stripped = slug.replace(/-\d{4}-\d{2}-\d{2}(-\d+)?$/, '');
    if (stripped) {
      return stripped
        .split('-')
        .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
        .join(' ');
    }
  }
  return 'Untitled proposal';
}

// ── Utils ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}
