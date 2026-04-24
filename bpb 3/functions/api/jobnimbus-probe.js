// ============================================================================
// Cloudflare Pages Function — JobNimbus API probe proxy
// ----------------------------------------------------------------------------
// Path when deployed: /api/jobnimbus-probe
// Methods: POST (probe request), OPTIONS (CORS preflight)
// Used by: /admin/jobnimbus-probe.html  (Sprint 4, Step 1)
//
// Purpose:
//   JobNimbus API (https://app.jobnimbus.com/api1/) does not send CORS
//   headers, so the browser cannot call it directly. This Function runs
//   server-side on Cloudflare's edge and forwards the call with the
//   caller-supplied Bearer token.
//
//   The API key is passed in the POST body (NOT stored in env vars) so this
//   Function works even while the Sprint 3B CF env var UI bug is unresolved.
//   The admin page caches the key in sessionStorage only (cleared on tab
//   close) — it is never persisted to disk or CF config.
//
// Request body (JSON):
//   {
//     "apiKey":   "<JobNimbus Admin API key>",   // required
//     "endpoint": "products",                    // required, no leading slash needed
//     "size":     20,                            // optional, default 20
//     "method":   "GET"                          // optional, default GET
//   }
//
// Response (JSON, always 200 from this Function so the caller can inspect):
//   {
//     "ok":          true | false,               // upstream response.ok
//     "status":      200,                        // upstream HTTP status
//     "statusText":  "OK",
//     "url":         "https://app.jobnimbus.com/api1/products?size=20",
//     "elapsedMs":   412,
//     "contentType": "application/json; charset=utf-8",
//     "parseError":  null,                       // set if JSON.parse failed
//     "payload":     { ... }                     // parsed JSON, or raw text if not JSON
//   }
// ============================================================================

const JOBNIMBUS_BASE = 'https://app.jobnimbus.com/api1/';

export async function onRequestPost(context) {
  const { request } = context;

  // ---- Parse request body ---------------------------------------------------
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse(
      { error: 'Invalid JSON body', detail: err.message },
      400
    );
  }

  const {
    apiKey,
    endpoint,
    size = 20,
    method = 'GET',
  } = body || {};

  // ---- Validate -------------------------------------------------------------
  if (!apiKey || typeof apiKey !== 'string') {
    return jsonResponse({ error: 'Missing or invalid apiKey' }, 400);
  }
  if (!endpoint || typeof endpoint !== 'string') {
    return jsonResponse({ error: 'Missing or invalid endpoint' }, 400);
  }

  // ---- Normalize endpoint ---------------------------------------------------
  // Accept any of: "products", "/products", "https://app.jobnimbus.com/api1/products"
  let clean = endpoint.trim();
  clean = clean.replace(/^https?:\/\/app\.jobnimbus\.com\/api1\//i, '');
  clean = clean.replace(/^\/+/, '');

  // Build target URL. Preserve any query string the caller supplied, then add
  // size= only if it isn't already there.
  let target;
  try {
    target = new URL(JOBNIMBUS_BASE + clean);
  } catch (err) {
    return jsonResponse(
      { error: 'Could not build target URL', detail: err.message, endpoint: clean },
      400
    );
  }
  if (!target.searchParams.has('size')) {
    target.searchParams.set('size', String(size));
  }

  // ---- Call JobNimbus -------------------------------------------------------
  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: method.toUpperCase(),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
    });
  } catch (err) {
    return jsonResponse(
      {
        error:  'Network error calling JobNimbus',
        detail: err.message,
        url:    target.toString(),
      },
      502
    );
  }

  const elapsedMs   = Date.now() - started;
  const contentType = upstream.headers.get('content-type') || '';

  // ---- Parse response -------------------------------------------------------
  const rawText = await upstream.text();
  let payload    = rawText;
  let parseError = null;

  const looksJson =
    contentType.toLowerCase().includes('application/json') ||
    rawText.trim().startsWith('{') ||
    rawText.trim().startsWith('[');

  if (looksJson) {
    try {
      payload = JSON.parse(rawText);
    } catch (err) {
      parseError = err.message;
      payload    = rawText;
    }
  }

  return jsonResponse({
    ok:         upstream.ok,
    status:     upstream.status,
    statusText: upstream.statusText,
    url:        target.toString(),
    elapsedMs,
    contentType,
    parseError,
    payload,
  }, 200);
}

// CORS preflight — same-origin requests from /admin/jobnimbus-probe.html don't
// strictly need this, but it's cheap insurance if the page is ever opened
// from a different origin for testing.
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age':       '86400',
    },
  });
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type':                 'application/json',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
