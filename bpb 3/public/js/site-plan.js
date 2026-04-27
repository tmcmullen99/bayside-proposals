// ═══════════════════════════════════════════════════════════════════════════
// Site plan section (Phase 1A Step 3).
//
// Renders the existing standalone labeling tool (/admin/site-map.html) inside
// the editor as an iframe scoped to the current proposal. Zero code duplication
// — both the standalone admin URL and this in-editor view render the exact
// same UI from the same source.
//
// The iframe is auth-less (matching all other BPB admin pages); the security
// boundary is the CF Function holding the service role key. See site-map.js
// + functions/api/site-map-*.js for details.
//
// Design choices:
//   • The iframe fills the editor's main pane, minus the section header.
//     `min-height: calc(100vh - 220px)` keeps the canvas roomy on most screens
//     while still letting the topbar + section header stay visible above.
//   • A small "Open fullscreen" link in the top-right opens the same URL in a
//     new tab — useful when Tim wants the whole viewport for a complex trace.
//   • Per Principle 2, no extra UI in this module — it's a thin wrapper. All
//     interaction lives inside the iframe.
// ═══════════════════════════════════════════════════════════════════════════

export function initSitePlan({ proposalId, container, onSave }) {
  // We don't actually receive save events from the iframe (cross-frame messaging
  // would require postMessage wiring on both sides). Save indication still works
  // because the iframe writes directly to the DB via /api/site-map-* — Tim's
  // edits are persisted, just not surfaced through the editor's "Saved" indicator.
  // If we want that integration later, postMessage + a listener here is ~10 lines.

  const iframeUrl = `/admin/site-map.html?proposal_id=${encodeURIComponent(proposalId)}`;

  container.innerHTML = `
    <div class="section-header">
      <span class="eyebrow">Section</span>
      <h2>Site plan</h2>
      <a href="${iframeUrl}" target="_blank" rel="noopener" class="site-plan-fullscreen-link">
        Open fullscreen ↗
      </a>
    </div>
    <div class="site-plan-iframe-wrap">
      <iframe
        src="${iframeUrl}"
        class="site-plan-iframe"
        title="Site plan labeling tool"
        loading="lazy"
      ></iframe>
    </div>
  `;

  // Inject the styles once per page lifetime — guarded so re-rendering this
  // section doesn't keep stacking <style> tags.
  injectStylesOnce();
}

const STYLE_ID = 'site-plan-iframe-styles';
function injectStylesOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .site-plan-iframe-wrap {
      margin-top: 16px;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      overflow: hidden;
      background: #f5f6f8;
    }
    .site-plan-iframe {
      display: block;
      width: 100%;
      height: calc(100vh - 220px);
      min-height: 600px;
      border: 0;
    }
    .site-plan-fullscreen-link {
      float: right;
      font-size: 13px;
      color: #91a1ba;
      text-decoration: none;
      margin-top: 4px;
    }
    .site-plan-fullscreen-link:hover {
      color: #1a1f2e;
      text-decoration: underline;
    }
  `;
  document.head.appendChild(style);
}
