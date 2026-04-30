// ═══════════════════════════════════════════════════════════════════════════
// GET /p/[slug]
//
// Serves the stored html_snapshot for a published proposal.
//
// Phase 4.1 Sprint B1: injects /p-customize.js before </body> so signed-in
// homeowners see a customization overlay on top of their proposal page.
// The overlay self-deactivates when the viewer isn't a signed-in homeowner
// who owns this proposal — public viewing is identical.
//
// Environment variables (set in CF Pages → Settings → Environment variables):
//   SUPABASE_URL       — e.g. https://gfgbypcnxkschnfsitfb.supabase.co
//   SUPABASE_ANON_KEY  — same anon key used by the front end
// ═══════════════════════════════════════════════════════════════════════════

const CUSTOMIZE_SCRIPT_TAG = '<script src="/p-customize.js" defer></script>';

export async function onRequestGet(context) {
  const { slug } = context.params;
  const env = context.env || {};

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return htmlError(500, 'Server misconfigured',
      'SUPABASE_URL or SUPABASE_ANON_KEY not set on the Pages project.');
  }

  if (!slug || typeof slug !== 'string') {
    return htmlError(400, 'Invalid URL', 'No slug in request.');
  }

  const endpoint = `${SUPABASE_URL}/rest/v1/published_proposals`
    + `?slug=eq.${encodeURIComponent(slug)}`
    + `&select=html_snapshot,title,published_at`
    + `&limit=1`;

  let res;
  try {
    res = await fetch(endpoint, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return htmlError(502, 'Upstream error',
      'Could not reach the proposal database. ' + (err.message || String(err)));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return htmlError(502, 'Upstream error',
      `Supabase returned ${res.status}. ${body}`);
  }

  let rows;
  try {
    rows = await res.json();
  } catch (err) {
    return htmlError(502, 'Upstream error', 'Malformed response from database.');
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return htmlError(404, 'Proposal not found',
      `No published proposal exists at /p/${escapeHtml(slug)}.`);
  }

  const row = rows[0];
  let html = row.html_snapshot;

  if (!html || typeof html !== 'string') {
    return htmlError(500, 'Proposal is empty',
      'This proposal has no stored HTML snapshot.');
  }

  // Phase 4.1 Sprint B1: inject the customization overlay script.
  // Self-deactivates if viewer isn't authorized — safe for public viewing.
  // `defer` ensures snapshot renders without blocking on script download.
  if (html.includes('</body>')) {
    html = html.replace('</body>', `${CUSTOMIZE_SCRIPT_TAG}\n</body>`);
  } else {
    html = html + '\n' + CUSTOMIZE_SCRIPT_TAG;
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────
function htmlError(status, title, detail) {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: #353535; background: #faf8f3;
    min-height: 100vh; margin: 0;
    display: flex; align-items: center; justify-content: center;
    padding: 32px;
  }
  .card {
    max-width: 520px; background: #fff;
    border: 1px solid #e5e5e5; border-radius: 12px;
    padding: 40px; text-align: center;
  }
  .code {
    color: #5d7e69; font-weight: 600;
    font-size: 13px; letter-spacing: 0.12em;
    text-transform: uppercase; margin-bottom: 12px;
  }
  h1 { font-size: 24px; margin: 0 0 12px; font-weight: 600; }
  p { color: #666; line-height: 1.6; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="code">Error ${status}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>`;

  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
