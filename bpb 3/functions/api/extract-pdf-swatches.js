// ═══════════════════════════════════════════════════════════════════════════
// /api/extract-pdf-swatches — Phase 3B.2 Session 2 (REAL implementation)
//
// Receives a rendered PDF page as base64 PNG, sends it to Claude vision
// with a structured-output prompt, returns parsed JSON describing every
// color swatch on the page including normalized bounding boxes.
//
// Architecture:
//   • Browser does the heavy lifting: fetches PDF via /api/proxy-pdf,
//     uses pdfjs-dist to render target page to canvas → PNG.
//   • This Function is just the bridge to Claude — auth, prompt, parse.
//   • No DB writes this session. Returns JSON for review. Session 3
//     adds cropping + Storage upload + belgard_materials writes.
//
// Request:
//   POST /api/extract-pdf-swatches
//   Authorization: Bearer <user_access_token>
//   {
//     "image_base64": "<base64-encoded PNG>",
//     "mime_type": "image/png",
//     "page_number": 18,
//     "manufacturer": "Belgard",
//     "product_hint": "Catalina Grana"  // optional, helps Claude focus
//   }
//
// Response:
//   200 { ok: true, extracted: { product_name, collection, size_spec,
//          swatches: [...] }, meta: { model, usage } }
//   400 / 401 / 403 / 502 / 500 with JSON error
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4000;

const EXTRACTION_PROMPT = `You are looking at one page from a manufacturer's product catalog (Belgard, Techo-Bloc, Keystone, etc.). Your job is to identify every COLOR SWATCH on the page and return structured JSON describing each one.

A "color swatch" is a small printed image showing what an actual paver/wall block looks like in a specific color. Swatches are usually:
- Rectangular or square tiles
- Arranged in a grid or row
- Each labeled with a color name (e.g. "Sandlewood", "Anthracite", "Sierra Blend") usually directly below or above the tile
- Often marked with a small color number or code (e.g. "01", "06", "08")

DO NOT extract:
- Lifestyle/installation photos (people, houses, full backyard scenes)
- Manufacturer logos
- Cross-section diagrams or technical drawings
- Decorative borders or page furniture
- Application icons (small gray icons indicating pedestrian/vehicular use, fire-rated, etc.)

For each swatch, return:
- color_name: The color name as printed (preserve capitalization, e.g. "Charcoal/Tan", "shale grey", "Sahara")
- color_code: Short code if shown (e.g. "01", "06"). null if not shown.
- description: Short blend description if shown adjacent to the swatch (e.g. "Mix of tan and charcoal"). null if absent.
- bbox: Normalized bounding box of just the SWATCH TILE itself (not including the label text). Coordinates 0-1 relative to image dimensions. The bbox should be TIGHT around the swatch tile — exclude white space, color labels, color codes, and any decorative borders. Top-left origin.
  Schema: { "x": <0-1>, "y": <0-1>, "width": <0-1>, "height": <0-1> }

Also identify page-level context:
- product_name: The main product on this page (e.g. "Catalina Grana", "Holland Stone"). null if the page is a generic color-reference page covering many products.
- collection: Manufacturer's collection name if visible (e.g. "Metropolitan", "Heritage", "Platinum Series"). null if absent.
- size_spec: Size specifications shown on the page (e.g. "12x6, 12x9, 12x12", "60mm"). null if absent.
- page_summary: One sentence summary of what this page shows.

CRITICAL FORMATTING RULES:
- Return ONLY valid JSON. No markdown fences, no prose commentary.
- bbox values must be NUMBERS between 0.0 and 1.0, not strings, not percentages.
- A swatch tile that's 200px wide on a 2000px-wide image has bbox.width = 0.10.
- If you see no swatches on the page, return swatches: [].
- Be honest about uncertainty: if a color label is unreadable, set color_name to null rather than guessing.

Schema:
{
  "page_summary": string,
  "product_name": string|null,
  "collection": string|null,
  "size_spec": string|null,
  "swatches": [
    {
      "color_name": string|null,
      "color_code": string|null,
      "description": string|null,
      "bbox": { "x": number, "y": number, "width": number, "height": number }
    }
  ]
}`;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB after base64 decode

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL = env.SUPABASE_URL;
    const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
    const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { ok: false, error: 'Server not configured (missing Supabase env)' });
    }
    if (!ANTHROPIC_KEY) {
      return json(500, { ok: false, error: 'Server not configured (missing ANTHROPIC_API_KEY)' });
    }

    // ─── Auth: master only ────────────────────────────────────────────────
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json(401, { ok: false, error: 'Missing auth token' });

    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': SERVICE_ROLE },
    });
    if (!userResp.ok) return json(401, { ok: false, error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) {
      return json(401, { ok: false, error: 'Invalid auth token (no user)' });
    }

    const profileResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(callerUser.id) +
      '&select=role,is_active',
      { headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE } }
    );
    if (!profileResp.ok) return json(403, { ok: false, error: 'Could not look up profile' });
    const profiles = await profileResp.json();
    const profile = Array.isArray(profiles) && profiles[0];
    if (!profile || !profile.is_active || profile.role !== 'master') {
      return json(403, { ok: false, error: 'Master role required' });
    }

    // ─── Validate input ───────────────────────────────────────────────────
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { ok: false, error: 'Invalid JSON body' });
    }

    const imageBase64 = String(body.image_base64 || '').trim();
    const mimeType = String(body.mime_type || 'image/png').trim();
    const pageNumber = Number(body.page_number) || null;
    const manufacturer = String(body.manufacturer || '').trim();
    const productHint = String(body.product_hint || '').trim();

    if (!imageBase64) {
      return json(400, { ok: false, error: 'image_base64 is required' });
    }
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
      return json(400, { ok: false, error: 'mime_type must be image/png or image/jpeg' });
    }
    // Rough size check (base64 expands by 4/3, so byte size ≈ b64.length * 3/4)
    const approxBytes = Math.floor(imageBase64.length * 0.75);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return json(400, {
        ok: false,
        error: `Image too large (~${(approxBytes / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Render at lower DPI.`,
      });
    }

    // ─── Build prompt with optional product hint ─────────────────────────
    const contextLines = [];
    if (manufacturer) contextLines.push(`Manufacturer: ${manufacturer}`);
    if (pageNumber)   contextLines.push(`Page number in source PDF: ${pageNumber}`);
    if (productHint)  contextLines.push(`Expected product on this page: ${productHint}`);
    const contextBlock = contextLines.length > 0
      ? `\n\nCONTEXT:\n${contextLines.join('\n')}\n`
      : '';

    // ─── Call Claude vision ──────────────────────────────────────────────
    let claudeResp;
    try {
      claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: imageBase64,
                },
              },
              {
                type: 'text',
                text: EXTRACTION_PROMPT + contextBlock,
              },
            ],
          }],
        }),
      });
    } catch (err) {
      return json(502, {
        ok: false,
        error: 'Network error calling Anthropic API',
        details: err.message,
      });
    }

    const claudeData = await claudeResp.json().catch(() => null);
    if (!claudeResp.ok) {
      return json(502, {
        ok: false,
        error: `Anthropic API returned ${claudeResp.status}`,
        details: claudeData,
      });
    }

    const textBlock = claudeData?.content?.find?.(c => c.type === 'text');
    const textContent = textBlock?.text;
    if (!textContent) {
      return json(500, {
        ok: false,
        error: 'Claude returned no text content',
        raw: claudeData,
      });
    }

    // Strip any accidental markdown fences
    const cleaned = textContent
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let extracted;
    try {
      extracted = JSON.parse(cleaned);
    } catch (err) {
      return json(500, {
        ok: false,
        error: 'Claude returned text that is not valid JSON',
        raw_text: textContent,
        parse_error: err.message,
      });
    }

    // Defensive shape validation
    if (!extracted || typeof extracted !== 'object') {
      return json(500, { ok: false, error: 'Extracted JSON is not an object', raw: extracted });
    }
    if (!Array.isArray(extracted.swatches)) {
      extracted.swatches = [];
    }

    // Filter out swatches with malformed bboxes — they'd break cropping later
    const validSwatches = extracted.swatches.filter(s => {
      if (!s || !s.bbox) return false;
      const b = s.bbox;
      const ok = typeof b.x === 'number' && typeof b.y === 'number'
              && typeof b.width === 'number' && typeof b.height === 'number'
              && b.x >= 0 && b.x <= 1 && b.y >= 0 && b.y <= 1
              && b.width > 0 && b.width <= 1 && b.height > 0 && b.height <= 1
              && (b.x + b.width) <= 1.001 && (b.y + b.height) <= 1.001;
      return ok;
    });

    return json(200, {
      ok: true,
      extracted: {
        page_summary: extracted.page_summary || null,
        product_name: extracted.product_name || null,
        collection: extracted.collection || null,
        size_spec: extracted.size_spec || null,
        swatches: validSwatches,
      },
      dropped_swatches: extracted.swatches.length - validSwatches.length,
      meta: {
        model: claudeData.model,
        usage: claudeData.usage,
        page_number: pageNumber,
        manufacturer: manufacturer || null,
        product_hint: productHint || null,
      },
    });

  } catch (err) {
    return json(500, { ok: false, error: (err && err.message) || 'Unexpected server error' });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
