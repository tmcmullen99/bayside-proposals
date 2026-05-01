// ═══════════════════════════════════════════════════════════════════════════
// /js/proposal-tracker.js — Phase 5C
//
// Anonymous engagement tracker injected by /functions/p/[slug].js into every
// served proposal page. No external dependencies. Generates a session_id,
// auto-fires page_view, observes [data-bpb-track-section] elements for
// section_view, exposes window.bpTrack(eventType, payload) for ad-hoc events,
// batches and posts to /api/track-events every 5s plus a final flush via
// sendBeacon on pagehide.
//
// Privacy:
//   - session_id is an anonymous UUID stored in localStorage; no PII.
//   - client_id is read from localStorage['bpb_client_id'] which the client
//     portal will populate on login (forward-compatible — currently null).
//   - Do Not Track is respected pragmatically: only 'page_view' and
//     'accept_proposal_click' fire if navigator.doNotTrack === '1'.
//
// API contract: POST /api/track-events  body: { events: [...] }
// ═══════════════════════════════════════════════════════════════════════════

const ENDPOINT = '/api/track-events';
const FLUSH_INTERVAL_MS = 5000;
const SESSION_KEY = 'bpb_session_id';
const CLIENT_KEY = 'bpb_client_id';
const DNT_ALLOWLIST = new Set(['page_view', 'accept_proposal_click']);

// document.currentScript is null inside a module, so we look for our marker.
const scriptTag = document.querySelector('script[data-bpb-tracker]');
const META = {
  proposal_id: (scriptTag && scriptTag.dataset.proposalId) || null,
  published_proposal_id: (scriptTag && scriptTag.dataset.publishedId) || null,
  slug: (scriptTag && scriptTag.dataset.slug) || null,
};

const SESSION_ID = getOrCreateSessionId();
const CLIENT_ID = readLocalStorage(CLIENT_KEY) || null;
const DNT = navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes';

// ─── Queue + flush ────────────────────────────────────────────────────────
const queue = [];
let flushing = false;

function track(eventType, payload) {
  if (typeof eventType !== 'string') return;
  if (DNT && !DNT_ALLOWLIST.has(eventType)) return;

  queue.push({
    event_type: eventType,
    proposal_id: META.proposal_id,
    published_proposal_id: META.published_proposal_id,
    slug: META.slug,
    session_id: SESSION_ID,
    client_id: CLIENT_ID,
    occurred_at: new Date().toISOString(),
    viewport_w: window.innerWidth || null,
    viewport_h: window.innerHeight || null,
    user_agent: navigator.userAgent || null,
    referrer: document.referrer || null,
    payload: (payload && typeof payload === 'object' && !Array.isArray(payload))
      ? payload
      : {},
  });
}

async function flush(useBeacon) {
  if (flushing || queue.length === 0) return;
  flushing = true;

  const batch = queue.splice(0, queue.length);
  const body = JSON.stringify({ events: batch });

  try {
    if (useBeacon && navigator.sendBeacon) {
      // Beacon is fire-and-forget; we trust delivery.
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT, blob);
    } else {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true, // survives page unload if a flush is mid-flight
      });
      if (!resp.ok && resp.status >= 500) {
        // Re-queue for the next interval (5xx = transient).
        queue.unshift(...batch);
      }
    }
  } catch (_) {
    // Network error — re-queue (fetch path only; beacon errors are silent).
    if (!useBeacon) queue.unshift(...batch);
  } finally {
    flushing = false;
  }
}

setInterval(() => flush(false), FLUSH_INTERVAL_MS);

// Final flush when the page is hidden — most reliable signal for tab close,
// browser quit, or navigating away. 'pagehide' beats 'beforeunload' because
// it fires on iOS Safari and during back-forward cache transitions.
window.addEventListener('pagehide', () => flush(true));

// ─── Section view observer ──────────────────────────────────────────────
// Once-per-session per element. 50% threshold = section is genuinely visible.
const observed = new WeakSet();
const observer = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !observed.has(entry.target)) {
          observed.add(entry.target);
          const sectionKey = entry.target.dataset.bpbTrackSection;
          if (sectionKey) {
            track('section_view', { section: sectionKey });
          }
        }
      }
    }, { threshold: 0.5 })
  : null;

if (observer) {
  document.querySelectorAll('[data-bpb-track-section]').forEach((el) => {
    observer.observe(el);
  });

  // Also watch for late-added sections (modals, lazy-loaded content).
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches('[data-bpb-track-section]')) {
          observer.observe(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('[data-bpb-track-section]').forEach((el) => {
            observer.observe(el);
          });
        }
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

// ─── Public API ─────────────────────────────────────────────────────────
// Proposal-page handlers (swap modal, accept CTA, share button, etc.) call
// window.bpTrack('event_name', { ...payload }) to fire ad-hoc events.
window.bpTrack = track;

// Auto-fire page_view AFTER exposing the API so any scripts wired on load
// can also fire their own events without race conditions.
track('page_view');

// ─── Utilities ──────────────────────────────────────────────────────────
function getOrCreateSessionId() {
  let id = readLocalStorage(SESSION_KEY);
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : fallbackUuid();
    writeLocalStorage(SESSION_KEY, id);
  }
  return id;
}

function readLocalStorage(key) {
  try { return localStorage.getItem(key); }
  catch (_) { return null; }
}

function writeLocalStorage(key, value) {
  try { localStorage.setItem(key, value); }
  catch (_) { /* private mode / quota — ignore */ }
}

function fallbackUuid() {
  // RFC 4122 v4 with Math.random — only used if crypto.randomUUID is missing
  // (Safari < 15.4 etc.). Sufficient for anonymous session IDs.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
