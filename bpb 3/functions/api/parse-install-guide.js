// ═══════════════════════════════════════════════════════════════════════════
// Cloudflare Pages Function — POST /api/parse-install-guide
//
// One-time admin operation. Fetches the Belgard master Product Installation
// Guide PDF directly from belgard.com and hands it to Claude Sonnet 4.6 with
// a structured extraction prompt. Claude reads the 110+ page PDF natively
// (PDFs are handled as visual input — one page = one image worth of tokens)
// and returns ~5-8 major sections with ICPI-standard preparation requirements
// as JSON.
//
// The admin page then shows these sections in a review UI and, on approval,
// writes them to installation_guide_sections and links each to relevant rows
// in belgard_categories via the join table.
//
// Cost estimate: ~$0.75-$1.50 per parse (PDFs are expensive vs. text because
// each page is visually rasterized). This is fine — parse is a one-time
// admin operation, not a per-proposal step.
//
// Response shape:
//   {
//     success: true,
//     source_pdf_url: "https://...Product-Installation-Guide_WEB...",
//     sections: [
//       {
//         section_key:   "pavers" | "walls" | "porcelain" | "accessories" | "fire-features",
//         title:         "Paver Installation",
//         page_start:    5,
//         page_end:      20,
//         summary:       "2-3 sentence professional description...",
//         key_points:    ["4-inch minimum base for patios...", ...],
//         source_pdf_url: "https://..."
//       }
//     ],
//     meta: { model, usage, section_count }
//   }
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'claude-sonnet-4-6';
const MASTER_PDF_URL = 'https://www.belgard.com/wp-content/uploads/2025/05/Product-Installation-Guide_WEB_BEL24-D-298050.pdf';

const EXTRACTION_PROMPT = `You are parsing the Belgard Product Installation Guide PDF — the master reference document covering installation of Belgard pavers, walls, porcelain, accessories, and fire features.

The guide is organized into these major categories (visible in the Table of Contents):
  • PAVERS (including installation recommendations, construction guidelines, maintenance)
  • PORCELAIN (porcelain paver installation — treated as its own category since prep differs from concrete pavers)
  • FREESTANDING & RETAINING WALLS (includes Tandem Modular Block, Anchorplex, Diamond Pro, Belair, Weston Stone systems)
  • ACCESSORIES (Anglia Edger, Artforms Panel System, Landings Step)
  • FIRE FEATURES (Fire Pits)

Extract one section per major category (5 total targets: pavers, porcelain, walls, accessories, fire-features).

For each section, return:

- section_key: EXACTLY one of "pavers" | "porcelain" | "walls" | "accessories" | "fire-features"

- title: human-readable section name (e.g., "Paver Installation", "Retaining Wall Construction", "Porcelain Paver Installation", "Accessories Installation", "Fire Pit Assembly")

- page_start: first page number of the section (the category's start page)

- page_end: last page number of the section (the page before the next major category begins, or the final page for the last section)

- summary: 2-3 sentences in professional, client-facing language. Describe what proper installation of this product category entails and why it matters for long-term performance. Should read like proposal copy, not a TOC excerpt. Avoid phrases like "This section covers..." — speak directly about the installation itself.

- key_points: array of 3-5 substantive strings. Each point must be:
    ✓ Specific and quantitative where possible — include numbers (4-inch minimum base, 98% Standard Proctor, 1/8-inch joint width, 2% minimum slope)
    ✓ Written as a professional spec bullet suitable for a client proposal
    ✓ Focused on preparation and installation requirements that affect durability
    ✗ NOT vague ("proper installation", "industry-standard techniques")
    ✗ NOT pure TOC entries ("Site Preparation", "Base Installation")
    ✗ NOT marketing fluff

  Good examples:
    "Minimum 4-inch compacted aggregate base for patios and pedestrian areas, 6-inch for residential driveways, 8-inch for parking lots"
    "Base compacted to 98% Standard Proctor density in 2-4 inch lift increments with vibratory plate or roller compactor"
    "1-inch nominal clean concrete bedding sand conforming to ASTM C33 — masonry sand and stone dust are specifically excluded"
    "Consistent 1/8-inch joint widths filled with polymeric jointing sand to prevent insect and weed intrusion"
    "Minimum 2% surface slope for drainage with rigid edge restraints installed against compacted base"

Return ONLY valid JSON — no markdown fences, no prose commentary — matching this schema:

{
  "sections": [
    {
      "section_key": "pavers",
      "title": "Paver Installation",
      "page_start": 5,
      "page_end": 20,
      "summary": "...",
      "key_points": ["...", "..."]
    }
  ]
}`;

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Main handler
// ───────────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({
      error: 'ANTHROPIC_API_KEY environment variable not configured.'
    }, 500);
  }

  // Call Anthropic API with the PDF URL as a document source. Anthropic
  // fetches the PDF server-side, rasterizes each page, and passes them as
  // visual input to the model. This avoids the CF Worker having to download
  // and base64-encode a 5-10MB PDF into its request body.
  let apiResponse;
  try {
    apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'url', url: MASTER_PDF_URL }
            },
            {
              type: 'text',
              text: EXTRACTION_PROMPT
            }
          ]
        }]
      })
    });
  } catch (err) {
    return jsonResponse({
      error: 'Network error calling Anthropic API',
      details: err.message
    }, 502);
  }

  const apiData = await apiResponse.json().catch(() => null);

  if (!apiResponse.ok) {
    return jsonResponse({
      error: `Anthropic API returned ${apiResponse.status}`,
      details: apiData
    }, 502);
  }

  // Extract text content block
  const textBlock = apiData?.content?.find?.(c => c.type === 'text');
  const textContent = textBlock?.text;

  if (!textContent) {
    return jsonResponse({
      error: 'Claude returned no text content',
      raw_response: apiData
    }, 500);
  }

  // Strip optional markdown fences, parse JSON
  const cleaned = textContent
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({
      error: 'Claude returned text that is not valid JSON',
      raw_response: textContent,
      parse_error: err.message
    }, 500);
  }

  const rawSections = Array.isArray(parsed?.sections) ? parsed.sections : [];

  // Validate + enrich
  const ALLOWED_KEYS = new Set(['pavers', 'walls', 'porcelain', 'accessories', 'fire-features']);

  const sections = rawSections
    .filter(s =>
      s &&
      typeof s.title === 'string' && s.title.trim().length > 0 &&
      ALLOWED_KEYS.has(s.section_key)
    )
    .map(s => ({
      section_key: s.section_key,
      title:       String(s.title).trim(),
      page_start:  Number.isFinite(s.page_start) ? Math.floor(s.page_start) : null,
      page_end:    Number.isFinite(s.page_end)   ? Math.floor(s.page_end)   : null,
      summary:     typeof s.summary === 'string' ? s.summary.trim() : '',
      key_points:  Array.isArray(s.key_points)
                     ? s.key_points.filter(p => typeof p === 'string' && p.trim().length > 0).map(p => p.trim())
                     : [],
      source_pdf_url: MASTER_PDF_URL
    }));

  return jsonResponse({
    success: true,
    source_pdf_url: MASTER_PDF_URL,
    sections,
    meta: {
      model:         apiData.model,
      usage:         apiData.usage,
      section_count: sections.length,
      dropped:       rawSections.length - sections.length
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}
