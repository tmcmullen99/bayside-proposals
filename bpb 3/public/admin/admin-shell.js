// ═══════════════════════════════════════════════════════════════════════════
// /admin/admin-shell.js — Phase 5A + 5B Part 1 + 5C
//
// The master admin shell. Renders:
//   1. The role badge + email in the topbar
//   2. The tab strip (filtered by role)
//   3. The landing-page tile grid (only when on /admin/ itself, not nested
//      pages — those swap in their own content)
//
// 5B Part 1: added Designers tab (master-only) + new 'team' group.
// 5C: added Events tab (designer-accessible) + new 'analytics' group;
//     groundwork for the 5D dashboards that will live in the same group.
//
// Adding a future admin tool:
//   1. Add an entry to TABS below
//   2. Done. The tab appears for users with the right role, and a tile shows
//      up on the landing grid.
// ═══════════════════════════════════════════════════════════════════════════

import { requireDesigner, signOut } from '/js/auth-util.js';

// ───────────────────────────────────────────────────────────────────────────
// Tab registry — single source of truth.
//
// Fields:
//   id           unique key for this tab. Used for the active-state check.
//   label        what shows in the tab + tile.
//   href         the page path. Use trailing / for the landing page.
//   role         'master' = master only. 'designer' = designer + master.
//   group        landing-page tile bucket. 'main' shows first.
//   icon         single emoji or short character. Keep it short.
//   description  shown on the landing tile, not in the tab. One sentence.
//
// Order of appearance in the tab strip and tile grid follows this array's
// order, so put high-traffic tools first within each group.
// ───────────────────────────────────────────────────────────────────────────
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
    hideFromLanding: true, // already on the landing — don't list ourselves
  },

  // Operations — daily client-management work
  {
    id: 'clients',
    label: 'Clients',
    href: '/admin/clients.html',
    role: 'designer',
    group: 'operations',
    icon: '👤',
    description: 'Add, edit, and invite homeowner clients. Assign proposals, manage referrals
