// ═══════════════════════════════════════════════════════════════════════════
// client-dashboard.js
// Client dashboard — shows the authenticated homeowner's proposals.
//
// Phase 1A (markup PDF):
//   - Each proposal card now exposes a "📥 Markup PDF" button that
//     generates a printable, brand-matched PDF the homeowner can mark
//     up by hand and send back to their designer.
//   - Generation is fully client-side via /client/markup-pdf.js (jsPDF
//     loaded from CDN). Image source columns are auto-detected from
//     proposals: site_plan_backdrop_url, hero_image_url,
//     construction_drawing_url.
//   - The download is logged as a 'markup_pdf_downloaded' activity for
//     the designer's pipeline analytics.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';
import {
  requireClient,
  isAdminUser,
  getClientRecord,
  signOut,
  logClientActivity,
} from '/js/auth-util.js';
import { generateMarkupPdf } from './markup-pdf.js';

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
  proposals: [],
};

// ── Bootstrap ──────────────────────────────────────────────────────────────
(async function init() {
  ctx.user = await requireClient();
  if (!ctx.user) return;

  userEmailEl.textContent = ctx.user.email;

  if (isAdminUser(ctx.user)) {
    adminBanner.style.display = 'block';
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
  // Phase 1A — pull the three image fields we need to populate the
  // markup PDF. project_address is also pulled so the footer band can
  // print it without an extra query.
  const { data, error } = await supabase
    .from('client_proposals')
    .select(`
      id, status, sent_at, first_viewed_at, signed_at, created_at,
      proposal:proposals!proposal_id (
        id,
        address,
        project_address,
        site_plan_backdrop_url,
        hero_image_url,
        construction_drawing_url,
        created_at,
        published_proposals (id, slug)
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

  proposalsGrid.querySelectorAll('.proposal-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cpId = btn.dataset.cpId;
      const slug = btn.dataset.slug;
      handleProposalView(cpId, slug);
    });
  });
  proposalsGrid.querySelectorAll('.proposal-pdf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cpId = btn.dataset.cpId;
      handleMarkupPdfDownload(cpId, btn);
    });
  });
}

function renderProposalCard(cp) {
  const p = cp.proposal;
  if (!p) return '';

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
  const hasImagesForPdf = !!(p.site_plan_backdrop_url || p.hero_image_url || p.construction_drawing_url);

  const pdfButton = hasImagesForPdf
    ? `<button class="btn btn-secondary proposal-pdf-btn"
               data-cp-id="${escapeAttr(cp.id)}"
               title="Download a printable PDF you can mark up by hand">
         📥 Markup PDF
       </button>`
    : '';

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
      <div class="proposal-card-actions">
        ${pdfButton}
        ${viewButton}
      </div>
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
  window.location.href = `/p/${slug}`;
}

// ── Markup PDF download (Phase 1A) ─────────────────────────────────────────
async function handleMarkupPdfDownload(cpId, btn) {
  const cp = ctx.proposals.find(x => x.id === cpId);
  if (!cp || !cp.proposal) return;

  const origText = btn.textContent;
  const origDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = '⏳ Generating…';

  try {
    await generateMarkupPdf(
      {
        // Spread only the fields markup-pdf.js needs — keeps the payload small
        project_address: cp.proposal.project_address || cp.proposal.address,
        site_plan_backdrop_url: cp.proposal.site_plan_backdrop_url,
        hero_image_url: cp.proposal.hero_image_url,
        construction_drawing_url: cp.proposal.construction_drawing_url,
      },
      {
        clientName: ctx.client.name || '',
      }
    );

    // Fire-and-forget activity log so designers see download signals
    logClientActivity(
      ctx.client.id,
      'markup_pdf_downloaded',
      { proposal_id: cp.proposal.id },
      cp.proposal.id
    );

    btn.textContent = '✓ Downloaded';
    setTimeout(() => {
      btn.textContent = origText;
      btn.disabled = origDisabled;
    }, 2200);
  } catch (err) {
    console.error('Markup PDF generation failed:', err);
    btn.textContent = '⚠ Try again';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = origText; }, 2500);
  }
}

// ── Sign out ───────────────────────────────────────────────────────────────
signOutBtn.addEventListener('click', async () => {
  await signOut();
});

// ── Slug / address helpers ─────────────────────────────────────────────────
function parseSlugSortKey(slug) {
  if (!slug) return { date: '', version: 0 };
  const match = String(slug).match(/(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?$/);
  if (!match) return { date: '', version: 0 };
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    version: parseInt(match[4] || '1', 10),
  };
}

function getLatestSlug(proposal) {
  const pubs = proposal?.published_proposals;
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  const sorted = [...pubs].sort((a, b) => {
    const ka = parseSlugSortKey(a.slug);
    const kb = parseSlugSortKey(b.slug);
    if (kb.date !== ka.date) return kb.date.localeCompare(ka.date);
    return kb.version - ka.version;
  });
  return sorted[0]?.slug || null;
}

function getDisplayAddress(proposal) {
  if (proposal?.project_address) return proposal.project_address;
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
