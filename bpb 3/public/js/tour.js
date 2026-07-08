// ═══════════════════════════════════════════════════════════════════════════
// tour.js — SPRINT 3 (built-in designer tutorial)
//
// Self-contained spotlight tour for the designer dashboard, plus a floating
// "?" Help button (bottom-right) that replays it anytime. No libraries.
//
// Behavior:
//   • initTour({ supabase, profile }) — call once after the dashboard
//     renders. If profile.onboarding_completed_at is NULL, the tour starts
//     automatically ~600ms later (lets the pipeline paint first).
//   • Finishing OR skipping stamps profiles.onboarding_completed_at so it
//     never auto-plays again (per user, cross-device — it's in the DB).
//   • The "?" button is always injected; "Replay the tour" works forever.
//     It also carries a menu slot where the Sprint 4 knowledge-base chat
//     will live.
//
// The tour is branding-aware: the welcome step uses the product name from
// company_settings via branding.js.
// ═══════════════════════════════════════════════════════════════════════════

import { getBranding } from './branding.js';

let _ctx = null;          // { supabase, profile }
let _steps = [];
let _idx = 0;
let _open = false;

// ── Step definitions ────────────────────────────────────────────────────────
// target: CSS selector to spotlight (null = centered card)
function buildSteps(brand) {
  const product = `${brand.company_name} ${brand.product_name}`;
  return [
    {
      target: null,
      title: `Welcome to ${brand.product_name} 👋`,
      body: `This is your pipeline command center — every proposal you create moves through it, from first draft to signed deal. This 60-second tour shows you the full workflow. You can replay it anytime from the <strong>?</strong> button in the corner.`,
    },
    {
      target: '#ddFunnelStages',
      title: 'Your pipeline, in five stages',
      body: `Proposals move automatically: <strong>Draft</strong> while you're building → <strong>Sent</strong> once published → <strong>Viewed</strong> when your client opens it → <strong>Engaged</strong> when they interact heavily (4+ views, a substitution, or a redesign request) → <strong>Signed</strong>. Click any stage to see the deals sitting in it.`,
    },
    {
      target: '#ddStatRow',
      title: 'Your numbers at a glance',
      body: `Open value is everything still in play; closed total and win rate track how you're converting. These update live as clients view and sign.`,
    },
    {
      target: '#ddNewBtn',
      title: 'Creating a proposal starts here',
      body: `Click <strong>+ New proposal</strong> and pick an existing client or add a new one — name, email, and the project address are all you need to get moving. You'll land in the editor immediately.`,
    },
    {
      target: null,
      title: 'Inside the editor',
      body: `The editor is where the magic happens: upload the bid PDF and it's <strong>parsed automatically</strong> into line items, then pick materials from the catalog, add the site plan, and hit <strong>Publish</strong>. Publishing generates a beautiful proposal page with its own private link for your client — no account required for them to view it.`,
    },
    {
      target: 'a[href="/clients.html"]',
      title: 'My Clients — your client workspace',
      body: `Everything client-facing lives here: their contact info and proposals, <strong>chat</strong> (messages are emailed to clients who haven't activated their portal yet, with a sign-in link), and their <strong>substitution and redesign requests</strong> waiting on your response.`,
    },
    {
      target: null,
      title: `You're ready 🎉`,
      body: `That's the loop: create → publish → client engages → you respond → signed. If you ever need a refresher, hit the <strong>?</strong> button bottom-right to replay this tour. Welcome to ${product}.`,
      finishLabel: 'Start building',
    },
  ];
}

// ── Public API ──────────────────────────────────────────────────────────────
export async function initTour(ctx) {
  _ctx = ctx || {};
  injectHelpButton();
  const done = _ctx.profile && _ctx.profile.onboarding_completed_at;
  if (!done) {
    setTimeout(() => { if (!_open) startTour(); }, 600);
  }
}

export async function startTour() {
  if (_open) return;
  const brand = await getBranding().catch(() => ({ company_name: '', product_name: 'the Proposal Builder' }));
  _steps = buildSteps(brand);
  _idx = 0;
  _open = true;
  ensureStyles();
  buildOverlay();
  showStep(0);
}

// ── Persistence ─────────────────────────────────────────────────────────────
async function markCompleted() {
  try {
    if (!_ctx || !_ctx.supabase || !_ctx.profile) return;
    if (_ctx.profile.onboarding_completed_at) return; // already stamped
    const ts = new Date().toISOString();
    const { error } = await _ctx.supabase
      .from('profiles')
      .update({ onboarding_completed_at: ts })
      .eq('id', _ctx.profile.id);
    if (!error) _ctx.profile.onboarding_completed_at = ts;
  } catch (_) { /* non-fatal */ }
}

// ── Overlay / rendering ─────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById('bpb-tour-css')) return;
  const css = document.createElement('style');
  css.id = 'bpb-tour-css';
  css.textContent = `
    #bpbTourShade {
      position: fixed; inset: 0; z-index: 10000;
    }
    #bpbTourRing {
      position: absolute; border-radius: 10px;
      box-shadow: 0 0 0 9999px rgba(16, 20, 28, 0.62), 0 0 0 3px #9c7440;
      transition: all 0.25s ease; pointer-events: none;
    }
    #bpbTourRing.center { box-shadow: 0 0 0 9999px rgba(16, 20, 28, 0.62); }
    #bpbTourCard {
      position: absolute; z-index: 10001; width: 340px; max-width: calc(100vw - 32px);
      background: #fff; border-radius: 14px; padding: 18px 20px 16px;
      box-shadow: 0 18px 50px rgba(0,0,0,0.3);
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      color: #23282f; transition: all 0.25s ease;
    }
    #bpbTourCard .t-count {
      font-family: 'JetBrains Mono', monospace; font-size: 9px; letter-spacing: 0.16em;
      text-transform: uppercase; color: #9c7440; font-weight: 600; margin-bottom: 6px;
    }
    #bpbTourCard .t-title { font-size: 16px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.01em; }
    #bpbTourCard .t-body { font-size: 13.5px; line-height: 1.55; color: #444; }
    #bpbTourCard .t-body strong { color: #23282f; }
    #bpbTourCard .t-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
    #bpbTourCard .t-spacer { flex: 1; }
    #bpbTourCard button {
      font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
      border-radius: 8px; padding: 8px 14px; border: 1px solid #e5e5e5; background: #fff; color: #555;
    }
    #bpbTourCard button:hover { border-color: #9c7440; color: #7d5c31; }
    #bpbTourCard button.t-next { background: #9c7440; border-color: #9c7440; color: #fff; }
    #bpbTourCard button.t-next:hover { background: #7d5c31; }
    #bpbTourCard button.t-skip { border: 0; background: transparent; color: #999; padding: 8px 6px; }
    #bpbTourCard button.t-skip:hover { color: #555; }

    #bpbHelpBtn {
      position: fixed; right: 18px; bottom: 18px; z-index: 9990;
      width: 44px; height: 44px; border-radius: 999px; border: 0;
      background: #33281c; color: #fff; font: 700 18px/1 'Onest', sans-serif;
      cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,0.22);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.12s, background 0.15s;
    }
    #bpbHelpBtn:hover { background: #9c7440; transform: scale(1.06); }
    #bpbHelpMenu {
      position: fixed; right: 18px; bottom: 70px; z-index: 9991;
      background: #fff; border: 1px solid #e5e5e5; border-radius: 12px;
      box-shadow: 0 14px 40px rgba(0,0,0,0.18); overflow: hidden;
      font-family: 'Onest', sans-serif; min-width: 210px;
    }
    #bpbHelpMenu button {
      display: block; width: 100%; text-align: left; border: 0; background: #fff;
      font: 500 13px/1.3 'Onest', sans-serif; color: #23282f;
      padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #f1eee6;
    }
    #bpbHelpMenu button:last-child { border-bottom: 0; }
    #bpbHelpMenu button:hover { background: #f1e7d3; color: #7d5c31; }
    #bpbHelpMenu .soon { color: #9aa0a6; font-size: 11px; margin-left: 6px; }
  `;
  document.head.appendChild(css);
}

function buildOverlay() {
  const shade = document.createElement('div');
  shade.id = 'bpbTourShade';
  shade.innerHTML = `
    <div id="bpbTourRing" class="center"></div>
    <div id="bpbTourCard" role="dialog" aria-modal="true">
      <div class="t-count" id="bpbTourCount"></div>
      <div class="t-title" id="bpbTourTitle"></div>
      <div class="t-body" id="bpbTourBody"></div>
      <div class="t-actions">
        <button class="t-skip" id="bpbTourSkip" type="button">Skip tour</button>
        <div class="t-spacer"></div>
        <button id="bpbTourBack" type="button">Back</button>
        <button class="t-next" id="bpbTourNext" type="button">Next</button>
      </div>
    </div>`;
  document.body.appendChild(shade);

  shade.querySelector('#bpbTourSkip').addEventListener('click', endTour);
  shade.querySelector('#bpbTourBack').addEventListener('click', () => showStep(_idx - 1));
  shade.querySelector('#bpbTourNext').addEventListener('click', () => {
    if (_idx >= _steps.length - 1) endTour();
    else showStep(_idx + 1);
  });
  document.addEventListener('keydown', escHandler);
  window.addEventListener('resize', repositionCurrent);
}

function escHandler(e) { if (e.key === 'Escape' && _open) endTour(); }

async function endTour() {
  _open = false;
  document.removeEventListener('keydown', escHandler);
  window.removeEventListener('resize', repositionCurrent);
  const shade = document.getElementById('bpbTourShade');
  if (shade) shade.remove();
  await markCompleted();
}

function showStep(i) {
  _idx = Math.max(0, Math.min(i, _steps.length - 1));
  const step = _steps[_idx];

  const countEl = document.getElementById('bpbTourCount');
  const titleEl = document.getElementById('bpbTourTitle');
  const bodyEl  = document.getElementById('bpbTourBody');
  const backBtn = document.getElementById('bpbTourBack');
  const nextBtn = document.getElementById('bpbTourNext');
  if (!countEl) return;

  countEl.textContent = `Step ${_idx + 1} of ${_steps.length}`;
  titleEl.textContent = step.title;
  bodyEl.innerHTML = step.body;      // step content is app-authored, not user data
  backBtn.style.visibility = _idx === 0 ? 'hidden' : 'visible';
  nextBtn.textContent = _idx === _steps.length - 1 ? (step.finishLabel || 'Finish') : 'Next';

  const target = step.target ? document.querySelector(step.target) : null;
  if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Give smooth-scroll a beat before measuring
  setTimeout(() => positionFor(target), target ? 260 : 0);
}

function repositionCurrent() {
  if (!_open) return;
  const step = _steps[_idx];
  positionFor(step.target ? document.querySelector(step.target) : null);
}

function positionFor(target) {
  const ring = document.getElementById('bpbTourRing');
  const card = document.getElementById('bpbTourCard');
  if (!ring || !card) return;

  const vw = window.innerWidth, vh = window.innerHeight;

  if (!target) {
    ring.classList.add('center');
    ring.style.top = '50%'; ring.style.left = '50%';
    ring.style.width = '0'; ring.style.height = '0';
    card.style.top = Math.max(24, vh / 2 - card.offsetHeight / 2) + 'px';
    card.style.left = Math.max(16, vw / 2 - card.offsetWidth / 2) + 'px';
    return;
  }

  const r = target.getBoundingClientRect();
  const pad = 6;
  ring.classList.remove('center');
  ring.style.top = (r.top - pad) + 'px';
  ring.style.left = (r.left - pad) + 'px';
  ring.style.width = (r.width + pad * 2) + 'px';
  ring.style.height = (r.height + pad * 2) + 'px';

  // Card placement: below the target if room, else above, else beside.
  const cw = card.offsetWidth || 340, ch = card.offsetHeight || 220;
  let top, left;
  if (r.bottom + ch + 20 < vh) top = r.bottom + 14;
  else if (r.top - ch - 20 > 0) top = r.top - ch - 14;
  else top = Math.max(16, Math.min(vh - ch - 16, r.top));
  left = Math.max(16, Math.min(vw - cw - 16, r.left + r.width / 2 - cw / 2));
  card.style.top = top + 'px';
  card.style.left = left + 'px';
}

// ── Help "?" button + menu ─────────────────────────────────────────────────
function injectHelpButton() {
  if (document.getElementById('bpbHelpBtn')) return;
  ensureStyles();

  const btn = document.createElement('button');
  btn.id = 'bpbHelpBtn';
  btn.type = 'button';
  btn.title = 'Help';
  btn.textContent = '?';
  document.body.appendChild(btn);

  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };

  btn.addEventListener('click', () => {
    if (menu) { closeMenu(); return; }
    menu = document.createElement('div');
    menu.id = 'bpbHelpMenu';
    menu.innerHTML = `
      <button type="button" id="bpbHelpReplay">▶ Replay the tour</button>
      <button type="button" id="bpbHelpChat">💬 Ask anything</button>
    `;
    document.body.appendChild(menu);
    menu.querySelector('#bpbHelpReplay').addEventListener('click', () => { closeMenu(); startTour(); });
    menu.querySelector('#bpbHelpChat').addEventListener('click', () => {
      closeMenu();
      // SPRINT 4: lazy-load the knowledge-base chat widget on first use.
      import('/js/help-chat.js')
        .then(m => m.openHelpChat())
        .catch(err => { console.error('help chat failed to load:', err); });
    });
    // Click-away
    setTimeout(() => document.addEventListener('click', function away(e) {
      if (menu && !menu.contains(e.target) && e.target !== btn) { closeMenu(); document.removeEventListener('click', away); }
    }), 0);
  });
}
