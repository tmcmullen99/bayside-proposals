// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-shell.js — Sprint 14B
//
// The master admin shell. Renders:
//   1. The role badge + email in the topbar
//   2. The tab strip (filtered by role)
//   3. The landing-page tile grid (only when on /admin/ itself, not nested
//      pages — those swap in their own content)
//
// Sprint 14B: added master-only Nurture templates tab to the 'operations'
// group, immediately after Nurture, for the new template-authoring page.
// (Sprint 14A added Nurture; Sprint 12 added Outreach.)
// Operations tab order: Pipeline → Nurture → Nurture templates (M) →
// Outreach → Clients → Substitutions → Redesigns → Create homeowner → Site map.
//
// Adding a future admin tool:
//   1. Add an entry to TABS below
//   2. Done. The tab appears for users with the right role, and a tile shows
//      up on the landing grid.
// ═══════════════════════════════════════════════════════════════════════════

import { requireDesigner, signOut } from '/js/auth-util.js';

const TABS = [
  // Landing
  {
    id: 'overview',
    label: 'Overview',
    href: '/admin/',
    role: 'designer',
    group: 'main',
    icon: '⌂',
    description: 'Quick access to every admin tool you have permission for.',
    hideFromLanding: true,
  },

  // Operations — Pipeline first; it's the daily command center
  {
    id: 'pipeline',
    label: 'Pipeline',
    href: '/admin/pipeline.html',
    role: 'designer',
    group: 'operations',
    icon: '◉',
    description: 'Every proposal in one place. Computed funnel stage, last activity, pending substitutions and redesigns, with quick links into every other admin view.',
  },
  {
    id: 'nurture',
    label: 'Nurture',
    href: '/admin/nurture-clients.html',
    role: 'designer',
    group: 'operations',
    icon: '🌱',
    description: 'Track every client through the nurture phase pipeline. Auto-transitions on consultation, publish, and signing. Manual override for paused or opted-out clients.',
  },
  {
    id: 'nurture-templates',
    label: 'Nurture templates',
    href: '/admin/nurture-templates.html',
    role: 'master',
    group: 'operations',
    icon: '✉',
    description: 'Author the email content sent at each phase + day-offset of the nurture sequence. Markdown body with merge fields, project-type filtering, day-offset scheduling. Master-only — controls outbound messaging across all designers.',
  },
  {
    id: 'outreach',
    label: 'Outreach',
    href: '/admin/outreach.html',
    role: 'designer',
    group: 'operations',
    icon: '📨',
    description: 'Cold lead pipeline. Drafted-not-sent, sent-never-opened, and engaged-then-ghosted clients. AI-drafted re-engagement messages.',
  },
  {
    id: 'clients',
    label: 'Clients',
    href: '/admin/clients.html',
    role: 'designer',
    group: 'operations',
    icon: '👤',
    description: 'Add, edit, and invite homeowner clients. Assign proposals, manage referrals, send login links.',
  },
  {
    id: 'substitutions',
    label: 'Substitutions',
    href: '/admin/substitutions.html',
    role: 'designer',
    group: 'operations',
    icon: '↺',
    description: 'Review homeowner material swap requests submitted from published proposals. Approve, reject, or mark applied.',
  },
  {
    id: 'client-redesigns',
    label: 'Redesigns',
    href: '/admin/client-redesigns.html',
    role: 'designer',
    group: 'operations',
    icon: '✏',
    description: 'Review client design change requests — markups, photos of paper markup, and notes for changes beyond material swaps.',
  },
  {
    id: 'create-homeowner',
    label: 'Create homeowner',
    href: '/admin/create-homeowner-account.html',
    role: 'designer',
    group: 'operations',
    icon: '+',
    description: 'Provision a homeowner account at the design appointment so the client can log in immediately.',
  },
  {
    id: 'site-map',
    label: 'Site map',
    href: '/admin/site-map.html',
    role: 'designer',
    group: 'operations',
    icon: '⊞',
    description: 'Edit interactive site-map regions and material assignments for a published proposal.',
  },

  // Catalog
  {
    id: 'materials',
    label: 'Materials',
    href: '/admin/materials.html',
    role: 'designer',
    group: 'catalog',
    icon: '◧',
    description: 'Browse, edit, or add materials in the central catalog. Used for swap candidates on every proposal.',
  },
  {
    id: 'swatches-bulk',
    label: 'Swatches (bulk)',
    href: '/admin/material-swatches-bulk.html',
    role: 'designer',
    group: 'catalog',
    icon: '▣',
    description: 'Drop many swatches at once. Auto-matches to materials by filename.',
  },
  {
    id: 'swatches-single',
    label: 'Swatches (per material)',
    href: '/admin/material-swatches.html',
    role: 'designer',
    group: 'catalog',
    icon: '▢',
    description: 'Upload or replace the swatch on one specific material variant.',
  },
  {
    id: 'catalog-pdfs',
    label: 'Catalog PDFs',
    href: '/admin/catalog-pdfs.html',
    role: 'designer',
    group: 'catalog',
    icon: '⎙',
    description: 'Manage manufacturer install PDFs and link them to catalog categories.',
  },
  {
    id: 'material-images',
    label: 'Material images (Belgard)',
    href: '/admin/material-images.html',
    role: 'master',
    group: 'catalog',
    icon: '🖼',
    description: 'Scrape Belgard product pages for primary images. Master-only — alters catalog imagery in bulk.',
  },
  {
    id: 'belgard-sync',
    label: 'Belgard sync',
    href: '/admin/belgard-sync.html',
    role: 'master',
    group: 'catalog',
    icon: '⟳',
    description: 'Refresh the Belgard materials catalog from the manufacturer. Master-only — high blast radius.',
  },

  // Team
  {
    id: 'designers',
    label: 'Designers',
    href: '/admin/designers.html',
    role: 'master',
    group: 'team',
    icon: '⚒',
    description: 'List, edit, deactivate, and invite designer/master accounts. Promote or demote roles.',
  },

  // Analytics
  {
    id: 'events',
    label: 'Events',
    href: '/admin/events.html',
    role: 'designer',
    group: 'analytics',
    icon: '⚡',
    description: 'Recent homeowner engagement events captured from published proposals. Sanity-check view; dashboards are coming in 5D.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    href: '/admin/notifications.html',
    role: 'designer',
    group: 'analytics',
    icon: '🔔',
    description: 'Get pinged when homeowners view your proposals. Manage first-view emails, daily digest, and quiet hours.',
  },

  // Tools
  {
    id: 'install-guide',
    label: 'Install guide',
    href: '/admin/install-guide-parse.html',
    role: 'master',
    group: 'tools',
    icon: '📐',
    description: 'Parse the Bayside install-guide PDF into structured sections. Master-only.',
  },
  {
    id: 'jobnimbus',
    label: 'JobNimbus probe',
    href: '/admin/jobnimbus-probe.html',
    role: 'master',
    group: 'tools',
    icon: '◇',
    description: 'Diagnostic console for the JobNimbus API. Master-only.',
  },
  {
    id: 'republish-bulk',
    label: 'Bulk republish',
    href: '/admin/republish-bulk.html',
    role: 'master',
    group: 'tools',
    icon: '↻',
    description: 'Republish published bids to bake new swatches and catalog updates into fresh snapshots.',
  },
];

const GROUPS = [
  { id: 'operations', label: 'Operations',         desc: 'Day-to-day client management.' },
  { id: 'catalog',    label: 'Material catalog',   desc: 'The library of materials, swatches, and install PDFs that powers every proposal.' },
  { id: 'team',       label: 'Team',               desc: 'Staff account management. Master-only.' },
  { id: 'analytics',  label: 'Analytics',          desc: 'Engagement and conversion data from published proposals.' },
  { id: 'tools',      label: 'Tools & maintenance',desc: 'Less-frequent utilities. Most are master-only.' },
];

(async function init() {
  const auth = await requireDesigner();
  if (!auth) return;

  const { user, profile } = auth;
  const isMaster = profile.role === 'master';

  renderTopbar(user, profile, isMaster);
  renderTabs(isMaster);
  renderLanding(profile, isMaster);

  document.getElementById('ashSignOutBtn').addEventListener('click', signOut);
})();

function renderTopbar(user, profile, isMaster) {
  const badge = document.getElementById('ashRoleBadge');
  badge.textContent = isMaster ? 'Master' : 'Designer';
  badge.classList.remove('is-loading');
  badge.classList.add(isMaster ? 'is-master' : 'is-designer');

  const emailEl = document.getElementById('ashUserEmail');
  emailEl.textContent = profile.email || user.email || '';
}

function renderTabs(isMaster) {
  const wrap = document.getElementById('ashTabs');
  if (!wrap) return;

  const visible = TABS.filter(t => isMaster || t.role === 'designer');

  const here = window.location.pathname.replace(/\/$/, '/');
  const activeId = (visible.find(t => normalizePath(t.href) === normalizePath(here)) || {}).id;

  const inner = document.createElement('div');
  inner.className = 'ash-tabs-inner';

  visible.forEach(t => {
    const a = document.createElement('a');
    a.className = 'ash-tab' + (t.id === activeId ? ' is-active' : '');
    a.href = t.href;
    a.innerHTML = `
      <span class="ash-tab-icon">${escapeHtml(t.icon || '')}</span>
      <span>${escapeHtml(t.label)}</span>
      ${t.role === 'master' ? '<span class="ash-tab-master-flag">M</span>' : ''}
    `;
    inner.appendChild(a);
  });

  wrap.innerHTML = '';
  wrap.appendChild(inner);
}

function normalizePath(p) {
  if (!p) return '';
  let s = p.split('?')[0].split('#')[0];
  if (s === '/admin/index.html') s = '/admin/';
  s = s.replace(/\/index\.html$/, '/');
  return s;
}

function renderLanding(profile, isMaster) {
  const landing = document.getElementById('ashLanding');
  if (!landing) return;

  const here = normalizePath(window.location.pathname);
  if (here !== '/admin/') {
    landing.style.display = 'none';
    return;
  }

  const eyebrow = document.getElementById('ashIntroEyebrow');
  const title = document.getElementById('ashIntroTitle');
  const lede = document.getElementById('ashIntroLede');

  const greeting = profile.display_name ? profile.display_name.split(' ')[0] : 'there';
  eyebrow.textContent = isMaster ? 'Master · Admin home' : 'Designer · Admin home';
  title.textContent = `Welcome, ${greeting}.`;
  lede.textContent = isMaster
    ? 'Everything in BPB. Tools tagged with M are master-only — they affect the catalog, infrastructure, or other designers\' work.'
    : 'Tools you use day-to-day. A few admin utilities aren\'t shown here because they\'re reserved for master access.';

  const groupsWrap = document.getElementById('ashTileGroups');
  groupsWrap.innerHTML = '';

  GROUPS.forEach(g => {
    const tabsInGroup = TABS.filter(t =>
      t.group === g.id
      && !t.hideFromLanding
      && (isMaster || t.role === 'designer')
    );
    if (tabsInGroup.length === 0) return;

    const groupEl = document.createElement('section');
    groupEl.className = 'ash-tile-group';
    groupEl.innerHTML = `
      <div class="ash-tile-group-header">
        <h2 class="ash-tile-group-title">${escapeHtml(g.label)}</h2>
        <span class="ash-tile-group-meta">${tabsInGroup.length} tool${tabsInGroup.length === 1 ? '' : 's'}</span>
      </div>
      <div class="ash-tile-grid">
        ${tabsInGroup.map(t => renderTile(t)).join('')}
      </div>
    `;
    groupsWrap.appendChild(groupEl);
  });
}

function renderTile(t) {
  const masterFlag = t.role === 'master'
    ? '<span class="ash-tile-master-flag">Master</span>'
    : '';
  const tileClass = 'ash-tile' + (t.role === 'master' ? ' is-master-only' : '');
  return `
    <a class="${tileClass}" href="${escapeAttr(t.href)}">
      <div class="ash-tile-row">
        <span class="ash-tile-icon">${escapeHtml(t.icon || '·')}</span>
        <span class="ash-tile-label">${escapeHtml(t.label)}</span>
        ${masterFlag}
      </div>
      <div class="ash-tile-desc">${escapeHtml(t.description || '')}</div>
    </a>
  `;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(str) { return escapeHtml(str); }
