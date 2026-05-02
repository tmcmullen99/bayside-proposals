// Sprint 6.4 — Designer Dashboard (Pipeline Command Center)
//
// Replaces the prior flat-table dashboard.js. Renders:
//   - Stat row (open value, closed total, win rate, active count)
//   - Funnel: 5 stages with counts/amounts
//   - Stage cards: clicking a stage filters deals shown below
//   - Deal cards: name, address, amount, engagement, pending pills
//
// Role-aware data scope:
//   - master   : sees ALL proposals (across all designers)
//   - designer : sees only proposals where owner_user_id = current user

import { supabase } from './supabase-client.js';
import { getProposalEngagementBulk, formatRelativeTime } from './engagement-utils.js';

const banner = document.getElementById('ddBanner');
const userName = document.getElementById('ddUserName');
const rolePill = document.getElementById('ddRolePill');
const switchBtn = document.getElementById('ddSwitchBtn');
const switchLabel = document.getElementById('ddSwitchLabel');
const signoutBtn = document.getElementById('ddSignoutBtn');
const newBtn = document.getElementById('ddNewBtn');
const navReports = document.getElementById('ddNavReports');
const navDesigns = document.getElementById('ddNavDesigns');
const statRow = document.getElementById('ddStatRow');
const funnelStages = document.getElementById('ddFunnelStages');
const stageTitle = document.getElementById('ddStageTitle');
const stageMeta = document.getElementById('ddStageMeta');
const stageCards = document.getElementById('ddStageCards');

let currentProfile = null;
let allProposals = [];
let classifiedDeals = [];
let activeStage = 'engaged';

const STAGES = [
  { key: 'draft',   label: 'Draft' },
  { key: 'sent',    label: 'Sent' },
  { key: 'viewed',  label: 'Viewed' },
  { key: 'engaged', label: 'Engaged' },
  { key: 'signed',  label: 'Signed' },
];

(async function bootstrap() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.replace('/account/signin.html');
    return;
  }

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('id, role, display_name, email, is_active')
    .eq('id', session.user.id)
    .maybeSingle();

  if (profErr || !profile) {
    showError('Could not load your profile: ' + (profErr ? profErr.message : 'no profile found'));
    return;
  }
  if (!profile.is_active) {
    showError('Your account is inactive. Contact your admin.');
    return;
  }

  currentProfile = profile;
  renderUserChrome(profile);
  attachEventListeners();
  await loadAndRender();
})();

function renderUserChrome(profile) {
  const name = profile.display_name || profile.email || 'You';
  userName.textContent = name;
  rolePill.textContent = profile.role === 'master' ? 'Master' : 'Designer';
  if (profile.role === 'master') {
    rolePill.classList.add('master');
    switchLabel.textContent = 'Switch to Designer';
  } else {
    switchLabel.textContent = 'Switch to Master';
  }
  document.title = profile.role === 'master'
    ? 'Pipeline (master view) · Bayside Proposal Builder'
    : 'Pipeline · Bayside Proposal Builder';
}

function attachEventListeners() {
  signoutBtn.addEventListener('click', async () => {
    try { await supabase.auth.signOut(); } catch (_) {}
    window.location.replace('/account/signin.html');
  });

  switchBtn.addEventListener('click', async () => {
    const ok = confirm(
      'Account-switching without re-signing-in is coming in the next sprint.\n\n' +
      'For now, clicking OK will sign you out so you can sign in to your ' +
      'other account. Continue?'
    );
    if (!ok) return;
    try { await supabase.auth.signOut(); } catch (_) {}
    window.location.replace('/account/signin.html');
  });

  newBtn.addEventListener('click', createProposal);

  funnelStages.querySelectorAll('.dd-fs').forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveStage(btn.dataset.stage);
    });
  });

  navReports.addEventListener('click', () => {
    alert('Reports view is coming in Sprint 7. For now use Engagement (live activity per proposal) or Pipeline (current funnel).');
  });
  navDesigns.addEventListener('click', () => {
    alert('Designs gallery is coming in a future sprint. It will show 3D renderings and material selections from past completed projects, browseable as inspiration for new clients.');
  });
}

async function loadAndRender() {
  banner.innerHTML = '';

  let q = supabase
    .from('proposals')
    .select('id, client_name, project_address, project_city, project_label, status, bid_total_amount, owner_user_id, updated_at, created_at')
    .order('updated_at', { ascending: false });

  if (currentProfile.role !== 'master') {
    q = q.eq('owner_user_id', currentProfile.id);
  }

  const { data: proposals, error } = await q;
  if (error) {
    showError('Could not load proposals: ' + error.message);
    return;
  }

  allProposals = proposals || [];

  if (allProposals.length === 0) {
    renderEmptyDashboard();
    return;
  }

  const proposalIds = allProposals.map(p => p.id);

  const [engagementMap, pubMap, subMap, redesignMap] = await Promise.all([
    getProposalEngagementBulk(proposalIds),
    fetchPublishedMap(proposalIds),
    fetchPendingSubstitutions(proposalIds),
    fetchPendingRedesigns(proposalIds),
  ]);

  classifiedDeals = allProposals.map(p => {
    const eng = engagementMap.get(p.id);
    const totalEvents = eng ? eng.totalEvents : 0;
    const lastViewMs = eng && eng.lastView ? new Date(eng.lastView).getTime() : 0;
    const hasPub = pubMap.has(p.id);
    const pendingSub = subMap.has(p.id);
    const pendingRedesign = redesignMap.has(p.id);

    let stage;
    if (p.status === 'signed' || p.status === 'completed') {
      stage = 'signed';
    } else if (p.status === 'archived') {
      stage = null;
    } else if (pendingSub || pendingRedesign || totalEvents >= 4) {
      stage = 'engaged';
    } else if (totalEvents > 0) {
      stage = 'viewed';
    } else if (hasPub) {
      stage = 'sent';
    } else {
      stage = 'draft';
    }

    return {
      proposal: p,
      stage,
      engagement: eng || { totalEvents: 0, lastView: null, isLive: false },
      pendingSub,
      pendingRedesign,
      lastActivityMs: lastViewMs,
    };
  }).filter(d => d.stage !== null);

  renderStats();
  renderFunnel();
  renderStageCards();
}

function renderStats() {
  const open = classifiedDeals.filter(d => d.stage !== 'signed').reduce((sum, d) => sum + Number(d.proposal.bid_total_amount || 0), 0);
  const closed = classifiedDeals.filter(d => d.stage === 'signed').reduce((sum, d) => sum + Number(d.proposal.bid_total_amount || 0), 0);
  const signedCount = classifiedDeals.filter(d => d.stage === 'signed').length;
  const totalCount = classifiedDeals.length;
  const winRate = totalCount > 0 ? Math.round((signedCount / totalCount) * 100) : 0;
  const activeCount = classifiedDeals.filter(d => d.stage !== 'signed').length;

  statRow.innerHTML = `
    <div class="dd-stat-card">
      <div class="dd-stat-label">Open value</div>
      <div class="dd-stat-value">${formatUSD(open)}</div>
      <div class="dd-stat-detail">${activeCount} active deal${activeCount === 1 ? '' : 's'}</div>
    </div>
    <div class="dd-stat-card">
      <div class="dd-stat-label">Closed total</div>
      <div class="dd-stat-value">${formatUSD(closed)}</div>
      <div class="dd-stat-detail">${signedCount} signed deal${signedCount === 1 ? '' : 's'}</div>
    </div>
    <div class="dd-stat-card">
      <div class="dd-stat-label">Win rate</div>
      <div class="dd-stat-value">${winRate}%</div>
      <div class="dd-stat-detail">${signedCount} of ${totalCount} total</div>
    </div>
    <div class="dd-stat-card">
      <div class="dd-stat-label">Active deals</div>
      <div class="dd-stat-value">${activeCount}</div>
      <div class="dd-stat-detail">${totalCount - activeCount} closed</div>
    </div>
  `;
}

function renderFunnel() {
  const counts = { draft: 0, sent: 0, viewed: 0, engaged: 0, signed: 0 };
  const amounts = { draft: 0, sent: 0, viewed: 0, engaged: 0, signed: 0 };

  for (const d of classifiedDeals) {
    counts[d.stage]++;
    amounts[d.stage] += Number(d.proposal.bid_total_amount || 0);
  }

  STAGES.forEach(s => {
    const btn = funnelStages.querySelector(`.dd-fs[data-stage="${s.key}"]`);
    if (!btn) return;
    btn.querySelector('.dd-fs-count').textContent = counts[s.key];
    btn.querySelector('.dd-fs-amount').textContent = amounts[s.key] > 0 ? formatUSD(amounts[s.key]) : '$0';
    btn.classList.toggle('active', s.key === activeStage);
  });
}

function renderStageCards() {
  const stageDeals = classifiedDeals.filter(d => d.stage === activeStage).sort(sortDealsForStage);
  const stageDef = STAGES.find(s => s.key === activeStage);
  stageTitle.textContent = stageDef ? stageDef.label : activeStage;

  const totalAmount = stageDeals.reduce((s, d) => s + Number(d.proposal.bid_total_amount || 0), 0);
  const sortDescription = activeStage === 'engaged' || activeStage === 'viewed'
    ? 'sorted by engagement heat'
    : activeStage === 'signed'
      ? 'sorted by amount'
      : 'sorted by last update';
  stageMeta.textContent = `${stageDeals.length} deal${stageDeals.length === 1 ? '' : 's'} · ${formatUSD(totalAmount)} total · ${sortDescription}`;

  if (stageDeals.length === 0) {
    stageCards.innerHTML = `<div class="dd-stage-empty">${emptyMessageFor(activeStage)}</div>`;
    return;
  }

  stageCards.innerHTML = `<div class="dd-stage-cards">${stageDeals.map(renderDealCard).join('')}</div>`;

  stageCards.querySelectorAll('.dd-deal').forEach(el => {
    const id = el.dataset.proposalId;
    el.addEventListener('click', () => {
      window.location.href = `/editor?id=${id}`;
    });
  });
}

function renderDealCard(deal) {
  const p = deal.proposal;
  const displayName = p.client_name || p.project_label || p.project_address || 'Untitled draft';
  const addressBits = [p.project_address, p.project_city].filter(Boolean);
  const addressLine = addressBits.length ? addressBits.join(', ') : '';
  const amount = formatUSD(Number(p.bid_total_amount || 0));
  const eng = deal.engagement;

  let engClass = 'none';
  let engText = 'No views yet';
  if (eng.isLive) {
    engClass = 'hot';
    engText = `🔥 viewing now`;
  } else if (eng.totalEvents >= 8) {
    engClass = 'hot';
    engText = `🔥 ${eng.totalEvents} views`;
  } else if (eng.totalEvents >= 1) {
    engClass = eng.totalEvents >= 4 ? 'warm' : 'cold';
    engText = `${eng.totalEvents} view${eng.totalEvents === 1 ? '' : 's'}`;
  }

  let recency = '';
  if (deal.lastActivityMs > 0) {
    recency = 'last view ' + formatRelativeTime(eng.lastView);
  } else if (deal.stage === 'draft') {
    recency = 'not yet sent';
  } else if (deal.stage === 'sent') {
    recency = 'sent · no views';
  }

  const pills = [];
  if (deal.pendingSub) pills.push('<span class="dd-deal-pill sub">Sub pending</span>');
  if (deal.pendingRedesign) pills.push('<span class="dd-deal-pill redesign">Redesign pending</span>');

  const isHot = deal.stage === 'engaged' && (eng.totalEvents >= 8 || eng.isLive);
  const hotClass = isHot ? ' hot' : '';

  return `
    <button class="dd-deal${hotClass}" data-proposal-id="${escapeAttr(p.id)}">
      <div class="dd-deal-name">${escapeHtml(displayName)}</div>
      <div class="dd-deal-addr">${escapeHtml(addressLine || '—')}</div>
      <div class="dd-deal-mid">
        <div class="dd-deal-amount">${amount}</div>
        <div class="dd-deal-engagement ${engClass}">${engText}</div>
      </div>
      <div class="dd-deal-meta">
        ${pills.join('')}
        ${recency ? `<span>${escapeHtml(recency)}</span>` : ''}
      </div>
    </button>
  `;
}

function sortDealsForStage(a, b) {
  if (activeStage === 'engaged' || activeStage === 'viewed') {
    if (b.engagement.totalEvents !== a.engagement.totalEvents) {
      return b.engagement.totalEvents - a.engagement.totalEvents;
    }
    return b.lastActivityMs - a.lastActivityMs;
  }
  if (activeStage === 'signed') {
    return Number(b.proposal.bid_total_amount || 0) - Number(a.proposal.bid_total_amount || 0);
  }
  const aUpdated = new Date(a.proposal.updated_at || a.proposal.created_at).getTime();
  const bUpdated = new Date(b.proposal.updated_at || b.proposal.created_at).getTime();
  return bUpdated - aUpdated;
}

function emptyMessageFor(stage) {
  switch (stage) {
    case 'draft':   return 'No drafts. Click <strong>+ New proposal</strong> in the sidebar to start one.';
    case 'sent':    return 'No proposals sitting in <em>sent</em>. Sent proposals show up here once published, before the homeowner views them.';
    case 'viewed':  return 'No proposals in <em>viewed</em>. Once a homeowner views a sent proposal but engages lightly (1–3 views), they show up here.';
    case 'engaged': return 'No engaged deals yet. Deals show up here when the homeowner views the page 4+ times, submits a substitution, or requests a redesign.';
    case 'signed':  return 'No signed deals yet.';
    default:        return 'No deals in this stage.';
  }
}

function setActiveStage(stage) {
  activeStage = stage;
  funnelStages.querySelectorAll('.dd-fs').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.stage === stage);
  });
  renderStageCards();
}

function renderEmptyDashboard() {
  const isDesigner = currentProfile.role !== 'master';

  statRow.innerHTML = `
    <div class="dd-stat-card"><div class="dd-stat-label">Open value</div><div class="dd-stat-value">$0</div><div class="dd-stat-detail">0 active deals</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Closed total</div><div class="dd-stat-value">$0</div><div class="dd-stat-detail">0 signed deals</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Win rate</div><div class="dd-stat-value">—</div><div class="dd-stat-detail">no deals yet</div></div>
    <div class="dd-stat-card"><div class="dd-stat-label">Active deals</div><div class="dd-stat-value">0</div><div class="dd-stat-detail">—</div></div>
  `;

  STAGES.forEach(s => {
    const btn = funnelStages.querySelector(`.dd-fs[data-stage="${s.key}"]`);
    if (btn) {
      btn.querySelector('.dd-fs-count').textContent = '0';
      btn.querySelector('.dd-fs-amount').textContent = '$0';
    }
  });

  stageTitle.textContent = isDesigner ? 'Welcome' : 'No proposals';
  stageMeta.textContent = '';
  stageCards.innerHTML = `
    <div class="dd-stage-empty">
      <div style="font-size: 32px; margin-bottom: 12px; opacity: 0.4;">📐</div>
      <div style="font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 8px;">
        ${isDesigner ? "You don't have any proposals yet" : 'No proposals in the system yet'}
      </div>
      <div style="margin-bottom: 18px; max-width: 420px; margin-left: auto; margin-right: auto; line-height: 1.6;">
        ${isDesigner
          ? "Click <strong>+ New proposal</strong> in the sidebar to start your first one. Upload a JobNimbus bid PDF and you'll be on the editor in seconds."
          : "Once designers create proposals, they'll all show up here for you to oversee."}
      </div>
      ${isDesigner ? '<button class="btn primary" id="ddEmptyNewBtn">Create your first proposal →</button>' : ''}
    </div>
  `;
  const emptyBtn = document.getElementById('ddEmptyNewBtn');
  if (emptyBtn) emptyBtn.addEventListener('click', createProposal);
}

async function fetchPublishedMap(proposalIds) {
  const map = new Map();
  if (proposalIds.length === 0) return map;
  const { data, error } = await supabase
    .from('published_proposals')
    .select('proposal_id')
    .in('proposal_id', proposalIds);
  if (error) {
    console.warn('[dashboard] published_proposals fetch failed:', error);
    return map;
  }
  (data || []).forEach(row => map.set(row.proposal_id, true));
  return map;
}

async function fetchPendingSubstitutions(proposalIds) {
  const map = new Map();
  if (proposalIds.length === 0) return map;
  const { data, error } = await supabase
    .from('proposal_substitutions')
    .select('proposal_id')
    .in('proposal_id', proposalIds)
    .eq('status', 'submitted');
  if (error) {
    console.warn('[dashboard] proposal_substitutions fetch failed:', error);
    return map;
  }
  (data || []).forEach(row => map.set(row.proposal_id, true));
  return map;
}

async function fetchPendingRedesigns(proposalIds) {
  const map = new Map();
  if (proposalIds.length === 0) return map;
  const { data, error } = await supabase
    .from('proposal_redesign_requests')
    .select('proposal_id')
    .in('proposal_id', proposalIds)
    .eq('status', 'submitted');
  if (error) {
    console.warn('[dashboard] proposal_redesign_requests fetch failed:', error);
    return map;
  }
  (data || []).forEach(row => map.set(row.proposal_id, true));
  return map;
}

async function createProposal() {
  newBtn.disabled = true;
  const btnText = newBtn.textContent;
  newBtn.textContent = 'Creating…';

  const insertPayload = {
    status: 'draft',
    proposal_type: 'bid',
    project_state: 'CA',
  };
  if (currentProfile && currentProfile.id) {
    insertPayload.owner_user_id = currentProfile.id;
  }

  const { data, error } = await supabase
    .from('proposals')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error) {
    showError('Could not create proposal: ' + error.message);
    newBtn.disabled = false;
    newBtn.textContent = btnText;
    return;
  }

  window.location.href = `/editor?id=${data.id}`;
}

function showError(msg) {
  banner.innerHTML = `<div class="dd-banner error">${escapeHtml(msg)}</div>`;
}

function formatUSD(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0';
  if (n >= 1_000_000) {
    return '$' + (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + 'M';
  }
  if (n >= 100_000) {
    return '$' + Math.round(n / 1000) + 'K';
  }
  if (n >= 10_000) {
    return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}
