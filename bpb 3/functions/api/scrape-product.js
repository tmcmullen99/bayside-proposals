// ═══════════════════════════════════════════════════════════════════════════
// Cloudflare Pages Function — Product URL scraper
// ----------------------------------------------------------------------------
// Path when deployed: /api/scrape-product
// Method: POST  |  Body: { "url": "..." }
// Called by:   /admin/materials.html (paste-product-link panel)
//
// Calibrated against Tim's five target catalogs (probed 2026-04-24/25):
//   • trex.com               — static H1 + colour swatch images present
//   • belgard.com            — static H1, og:image, gallery images
//   • techo-bloc.com         — static <title>, colour in URL slug, product
//                              pages 200 (homepage 403 to some UAs)
//   • keystonehardscapes.com — Quikrete-owned brand. Server-side templating
//                              leaks {{title}} placeholders, so we have to
//                              filter those out (see isGarbageText). Category
//                              lives in ?category= query, not URL path.
//   • tru-scapes.com         — H1 + SKU suffix in slug (e.g. -brz, -ss, -gry)
//
// Extraction priority, highest confidence first:
//   1. JSON-LD Product schema (where present)
//   2. Open Graph: og:title, og:description, og:image, og:site_name
//   3. Twitter card: twitter:title, twitter:description, twitter:image
//   4. <h1> (Trex, Belgard, Tru-Scapes surface product name here)
//   5. <meta name="description"> / <title>
//   6. URL-only inference (manufacturer from hostname, category from path,
//      colour from terminal slug segment)
//
// Trex-specific: colour swatch images in static HTML match
//                /is/image/trexcompany/swatch-*  — we collect them into
//                `extra.colors` as a UI hint; they do NOT auto-save to the
//                single-colour form field (Tim picks one).
//
// Failure philosophy: ALWAYS returns HTTP 200 + JSON { ok, extracted, … }.
// Even on fetch failure we return URL-inferred values so the form pre-fills
// something useful (manufacturer, category, cleaned URL).
// ═══════════════════════════════════════════════════════════════════════════

const MANUFACTURER_HOSTNAMES = [
  { match: /(^|\.)trex\.com$/i,                  name: 'Trex' },
  { match: /(^|\.)belgard\.com$/i,               name: 'Belgard' },
  { match: /(^|\.)techo-?bloc\.com$/i,           name: 'Techo-Bloc' },
  { match: /(^|\.)keystonehardscapes?\.com$/i,   name: 'Keystone Hardscapes' },
  { match: /(^|\.)keystonewalls?\.com$/i,        name: 'Keystone Hardscapes' },
  { match: /(^|\.)tru-?scapes\.com$/i,           name: 'Tru-Scapes' },
  { match: /(^|\.)msisurfaces\.com$/i,           name: 'MSI' },
  { match: /(^|\.)unilock\.com$/i,               name: 'Unilock' },
  { match: /(^|\.)basalite\.com$/i,              name: 'Basalite' },
];

const CATEGORY_KEYWORDS = [
  { re: /\bdeck(ing)?\b/i,                         name: 'Decking' },
  { re: /\brailing\b/i,                            name: 'Railing' },
  { re: /\bpavers?\b/i,                            name: 'Pavers' },
  { re: /\bpaver-?slab\b/i,                        name: 'Pavers' },
  { re: /\bpaving(-?stones?)?\b/i,                 name: 'Pavers' },
  { re: /\bslab(s)?\b/i,                           name: 'Pavers' },
  { re: /\bporcelain\b/i,                          name: 'Porcelain' },
  { re: /\bturf\b/i,                               name: 'Turf' },
  { re: /\bartificial-?grass\b/i,                  name: 'Turf' },
  { re: /\bsynthetic-?grass\b/i,                   name: 'Turf' },
  { re: /\bretaining\b/i,                          name: 'Walls' },
  { re: /\bwall(-?block|-?system|s)?\b/i,          name: 'Walls' },
  { re: /\bstructure(s)?\b/i,                      name: 'Walls' },
  { re: /\bcoping\b/i,                             name: 'Coping' },
  { re: /\bedger(s)?\b/i,                          name: 'Edgers' },
  { re: /\bstep(s)?\b/i,                           name: 'Steps' },
  { re: /\bfire[\s_-]?(pit|place|feature)s?\b/i,   name: 'Fire features' },
  { re: /\bkitchens?\b/i,                          name: 'Kitchens' },
  { re: /\blight(ing|s)?\b/i,                      name: 'Lighting' },
  { re: /\bhardscape[\s_-]?lighting\b/i,           name: 'Lighting' },
  { re: /\bfenc(e|ing)\b/i,                        name: 'Fencing' },
];

// Colour inference from URL slug. Only matches known colour sets to avoid
// misfiring on product-name tokens.
const COLOUR_TOKENS = [
  { re: /\bchamplain-?grey\b/i,     name: 'Champlain Grey' },
  { re: /\bgreyed-?nickel\b/i,      name: 'Greyed Nickel' },
  { re: /\bchestnut-?brown\b/i,     name: 'Chestnut Brown' },
  { re: /\bshale-?grey\b/i,         name: 'Shale Grey' },
  { re: /\bbeige-?cream\b/i,        name: 'Beige Cream' },
  { re: /\bonyx-?black\b/i,         name: 'Onyx Black' },
  { re: /\bcaffe-?crema\b/i,        name: 'Caffè Crema' },
  { re: /\bchocolate-?brown\b/i,    name: 'Chocolate Brown' },
  { re: /\bsandlewood\b/i,          name: 'Sandlewood' },
  { re: /\bisland-?mist\b/i,        name: 'Island Mist' },
  { re: /\bsalt-?flat\b/i,          name: 'Salt Flat' },
  { re: /\bhatteras\b/i,            name: 'Hatteras' },
  { re: /\bbiscayne\b/i,            name: 'Biscayne' },
  { re: /\brainier\b/i,             name: 'Rainier' },
  { re: /\bcarmel\b/i,              name: 'Carmel' },
  { re: /\bjasper\b/i,              name: 'Jasper' },
  { re: /-brz\b/i,                  name: 'Bronze' },
  { re: /-ss\b/i,                   name: 'Stainless Steel' },
  { re: /-blk\b/i,                  name: 'Black' },
  { re: /-gry\b/i,                  name: 'Grey' },
  { re: /-wht\b/i,                  name: 'White' },
];

const TRACKING_PARAM_PATTERNS = [
  /^utm_/i, /^gad_/i, /^mc_/i, /^pk_/i, /^_ga$/i,
  /^gclid$/i, /^gclsrc$/i, /^gbraid$/i, /^wbraid$/i,
  /^fbclid$/i, /^msclkid$/i, /^yclid$/i, /^dclid$/i,
  /^mkt_tok$/i, /^ref$/i, /^ref_src$/i, /^ref_url$/i,
  /^source$/i, /^campaign$/i,
];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
export async function onRequestPost(context) {
  const { request } = context;

  let body;
  try { body = await request.json(); }
  catch (err) { return jsonResponse({ ok: false, error: 'invalid_body', detail: err.message }, 400); }

  const rawUrl = (body?.url || '').trim();
  if (!rawUrl) return jsonResponse({ ok: false, error: 'missing_url' }, 400);

  let parsed;
  try { parsed = new URL(rawUrl); }
  catch { return jsonResponse({ ok: false, error: 'invalid_url', detail: 'Could not parse URL' }, 400); }

  if (!/^https?:$/i.test(parsed.protocol)) {
    return jsonResponse({ ok: false, error: 'invalid_url', detail: 'Only http/https supported' }, 400);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') ||
      host === '169.254.169.254' || host === '0.0.0.0') {
    return jsonResponse({ ok: false, error: 'blocked_host' }, 400);
  }

  const fromUrl = inferFromUrl(parsed);

  const started = Date.now();
  let fetchResult;
  try {
    fetchResult = await fetchWithTimeout(parsed.toString(), 15000);
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err.name === 'AbortError' ? 'timeout' : 'fetch_failed',
      detail: err.message || String(err),
      url: parsed.toString(),
      elapsed_ms: Date.now() - started,
      extracted: fromUrl,
      sources: sourcesFor(fromUrl, 'url_fallback'),
      warnings: ['Scrape failed — values below are inferred from the URL only. Fill in product name and other fields manually.'],
    });
  }

  const elapsed_ms = Date.now() - started;

  if (!fetchResult.ok) {
    const warn = (fetchResult.status === 403 || fetchResult.status === 429)
      ? 'The site blocked automated access. Values below are inferred from the URL only.'
      : `The site returned ${fetchResult.status}. Values below are inferred from the URL only.`;
    return jsonResponse({
      ok: false,
      error: 'upstream_error',
      status: fetchResult.status,
      status_text: fetchResult.status_text,
      url: parsed.toString(),
      elapsed_ms,
      extracted: fromUrl,
      sources: sourcesFor(fromUrl, 'url_fallback'),
      warnings: [warn],
    });
  }

  const extracted_from_html = extractFromHtml(fetchResult.html, parsed);
  const merged = mergeExtracted(fromUrl, extracted_from_html, parsed);

  return jsonResponse({
    ok: true,
    url: parsed.toString(),
    status: fetchResult.status,
    elapsed_ms,
    content_length: fetchResult.content_length,
    extracted: merged.values,
    sources: merged.sources,
    warnings: merged.warnings,
    extra: merged.extra,
  });
}

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
// URL → inferred fields
// ---------------------------------------------------------------------------
function inferFromUrl(parsed) {
  const host = parsed.hostname.toLowerCase();

  let manufacturer = null;
  for (const { match, name } of MANUFACTURER_HOSTNAMES) {
    if (match.test(host)) { manufacturer = name; break; }
  }
  if (!manufacturer) {
    const labels = host.replace(/^www\./, '').split('.');
    if (labels.length >= 2) manufacturer = titleCase(labels[labels.length - 2]);
  }

  // Build the haystack from path + query, URL-decoding spaces and similar
  // %-encoded chars so "/projectfamily/Fire%20Pits" matches /\bfire-?pit\b/.
  // We swallow URIError defensively for malformed inputs.
  let decodedPath = parsed.pathname;
  let decodedSearch = parsed.search;
  try { decodedPath   = decodeURIComponent(decodedPath); }   catch {}
  try { decodedSearch = decodeURIComponent(decodedSearch); } catch {}
  const haystack = decodedPath + ' ' + decodedSearch;
  let category = null;
  for (const { re, name } of CATEGORY_KEYWORDS) {
    if (re.test(haystack)) { category = name; break; }
  }

  let color = null;
  for (const { re, name } of COLOUR_TOKENS) {
    if (re.test(decodedPath)) { color = name; break; }
  }

  const cleanUrl = stripTrackingParams(parsed);

  return {
    manufacturer: manufacturer || null,
    product_name: null,
    description:  null,
    category:     category || null,
    color:        color || null,
    image_url:    null,
    catalog_url:  cleanUrl,
  };
}

function stripTrackingParams(parsed) {
  const u = new URL(parsed.toString());
  const toDelete = [];
  for (const key of u.searchParams.keys()) {
    if (TRACKING_PARAM_PATTERNS.some(p => p.test(key))) toDelete.push(key);
  }
  for (const k of toDelete) u.searchParams.delete(k);
  u.hash = '';
  return u.toString();
}

function titleCase(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// HTML fetch
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language':  'en-US,en;q=0.9',
        'Cache-Control':    'no-cache',
        'Pragma':           'no-cache',
        'Sec-Fetch-Dest':   'document',
        'Sec-Fetch-Mode':   'navigate',
        'Sec-Fetch-Site':   'none',
        'Sec-Fetch-User':   '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    const status = resp.status;
    const status_text = resp.statusText || '';

    const reader = resp.body?.getReader();
    if (!reader) {
      const html = await resp.text();
      return { ok: resp.ok, status, status_text, html, content_length: html.length };
    }
    const chunks = [];
    let total = 0;
    const CAP = 800 * 1024;
    while (total < CAP) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { reader.cancel(); } catch {}
    const full = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { full.set(c, off); off += c.byteLength; }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(full);
    return { ok: resp.ok, status, status_text, html, content_length: total };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------
function extractFromHtml(html, parsed) {
  const out = {
    manufacturer: null, product_name: null, description: null,
    category: null, image_url: null, color: null,
  };
  const sources = {};
  const extra = {};

  const jsonLd = extractJsonLdProduct(html);
  if (jsonLd) {
    const n = cleanIfReal(jsonLd.name);
    const d = cleanIfReal(jsonLd.description);
    const b = cleanIfReal(jsonLd.brand);
    if (n) { out.product_name = n; sources.product_name = 'jsonld'; }
    if (d) { out.description  = d; sources.description  = 'jsonld'; }
    if (jsonLd.image) {
      const img = resolveImage(jsonLd.image);
      if (img) { out.image_url = img; sources.image_url = 'jsonld'; }
    }
    if (b) { out.manufacturer = b; sources.manufacturer = 'jsonld_brand'; }
  }

  const og = {
    title:       metaContent(html, /property=["']og:title["']/i),
    description: metaContent(html, /property=["']og:description["']/i),
    image:       metaContent(html, /property=["']og:image["']/i),
    site_name:   metaContent(html, /property=["']og:site_name["']/i),
  };
  if (!out.product_name) {
    const v = cleanIfReal(stripSiteName(og.title, og.site_name));
    if (v) { out.product_name = v; sources.product_name = 'og_title'; }
  }
  if (!out.description) {
    const v = cleanIfReal(og.description);
    if (v) { out.description = v; sources.description = 'og_description'; }
  }
  if (!out.image_url && og.image) { out.image_url = og.image; sources.image_url = 'og_image'; }
  if (!out.manufacturer) {
    const v = cleanIfReal(og.site_name);
    if (v) { out.manufacturer = v; sources.manufacturer = 'og_site_name'; }
  }

  const tw = {
    title:       metaContent(html, /name=["']twitter:title["']/i),
    description: metaContent(html, /name=["']twitter:description["']/i),
    image:       metaContent(html, /name=["']twitter:image["']/i),
  };
  if (!out.product_name) {
    const v = cleanIfReal(tw.title);
    if (v) { out.product_name = v; sources.product_name = 'twitter_title'; }
  }
  if (!out.description) {
    const v = cleanIfReal(tw.description);
    if (v) { out.description = v; sources.description = 'twitter_description'; }
  }
  if (!out.image_url && tw.image) { out.image_url = tw.image; sources.image_url = 'twitter_image'; }

  if (!out.product_name) {
    const h1 = extractFirstH1(html);
    const v = cleanIfReal(h1);
    if (v) { out.product_name = v; sources.product_name = 'h1'; }
  }

  if (!out.description) {
    const md = metaContent(html, /name=["']description["']/i);
    const v = cleanIfReal(md);
    if (v) { out.description = v; sources.description = 'meta_description'; }
  }

  if (!out.product_name) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) {
      const v = cleanIfReal(stripSiteName(t[1], og.site_name));
      if (v) { out.product_name = v; sources.product_name = 'title_tag'; }
    }
  }

  // Trex swatch hint — collect /swatch-*/ image URLs as a UI hint
  if (/(^|\.)trex\.com/i.test(parsed.hostname)) {
    const swatches = extractTrexSwatches(html);
    if (swatches.length > 0) {
      extra.colors = swatches;
      extra.colors_source = 'trex_swatch_images';
    }
  }

  return { values: out, sources, extra };
}

function metaContent(html, propertyPattern) {
  const metaRe = /<meta\b([^>]*?)\/?>/gi;
  let m;
  while ((m = metaRe.exec(html))) {
    const attrs = m[1];
    if (!propertyPattern.test(attrs)) continue;
    const c = attrs.match(/\bcontent=["']([\s\S]*?)["']/i);
    if (c) return decodeEntities(c[1]).trim();
  }
  return null;
}

function extractFirstH1(html) {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return null;
  const stripped = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped ? decodeEntities(stripped) : null;
}

function extractJsonLdProduct(html) {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const prod = findProductInLd(parsed);
    if (prod) return prod;
  }
  return null;
}

function findProductInLd(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const p = findProductInLd(n);
      if (p) return p;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (Array.isArray(node['@graph'])) {
    const p = findProductInLd(node['@graph']);
    if (p) return p;
  }
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.includes('Product')) {
    return {
      name:        node.name || null,
      description: node.description || null,
      image:       node.image || null,
      brand:       node.brand?.name || node.brand || null,
    };
  }
  return null;
}

function resolveImage(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    const first = image.find(x => x);
    return resolveImage(first);
  }
  if (typeof image === 'object') return image.url || image['@id'] || null;
  return null;
}

function extractTrexSwatches(html) {
  // Trex marks swatches consistently with alt="swatch image". The URL pattern
  // varies per colour line (swatch-* for older lines, trex-transcend-*-square
  // for newer), so we match by ALT first and collect unique srcs.
  const out = [];
  const seen = new Set();
  // First pass: any <img> with alt matching "swatch" (case-insensitive)
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(html)) && out.length < 20) {
    const attrs = m[1];
    const altMatch = attrs.match(/\balt=["']([^"']*)["']/i);
    const srcMatch = attrs.match(/\bsrc=["']([^"']*)["']/i);
    if (!srcMatch) continue;
    const src = srcMatch[1];
    // Accept if alt includes "swatch" OR src path segment starts with "/swatch"
    const isSwatchByAlt = altMatch && /\bswatch\b/i.test(altMatch[1]);
    const isSwatchByUrl = /\/swatch[^\/]*$|\/swatch-/i.test(src);
    if (!isSwatchByAlt && !isSwatchByUrl) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    // Try to derive a colour name from the URL slug tail
    const slug = (src.split('/').pop() || '').split('?')[0];
    const nameMatch = slug.match(/-(?:im|bc|rn|cl|ja|ht|sf|sm)-(.+?)(?:-square)?$/i) ||
                      slug.match(/-transcend-lineage-(.+?)(?:-square)?(?:-\d+)?$/i);
    const name = nameMatch
      ? nameMatch[1].split('-').map(titleCase).join(' ')
      : null;
    out.push({ url: src, name });
  }
  return out;
}

function stripSiteName(title, siteName) {
  if (!title) return title;
  let t = cleanText(title);
  if (!siteName) return t;
  const sn = cleanText(siteName);
  const seps = [' | ', ' - ', ' – ', ' : ', ' — ', ' :: '];
  for (const sep of seps) {
    if (t.endsWith(sep + sn))  return t.slice(0, -(sep.length + sn.length)).trim();
    if (t.startsWith(sn + sep)) return t.slice(sn.length + sep.length).trim();
  }
  return t;
}

function cleanText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

/**
 * Returns true if the string looks like an unrendered template placeholder
 * or other meaningless filler. Keystone Hardscapes' server returns literal
 * `{{title}}` in <title> and og:title because their templating engine
 * isn't filling it in for the page; treating that as a real value would
 * pollute the form.
 *
 * Patterns rejected:
 *   - Mustache / Handlebars: {{title}}, {{ page.title }}, etc.
 *   - Liquid / Twig: {%...%} or {{...}}
 *   - Empty after trimming
 *   - Common 404/error tokens
 *   - Strings that are just punctuation / template syntax
 */
function isGarbageText(s) {
  if (!s) return true;
  const t = String(s).trim();
  if (t === '') return true;
  if (/^\{\{[\s\S]*?\}\}$/.test(t)) return true;             // {{title}}
  if (/^\{%[\s\S]*?%\}$/.test(t)) return true;               // {%...%}
  if (/^\$\{[\s\S]*?\}$/.test(t)) return true;               // ${title}
  if (/^(untitled|null|undefined|none|n\/a)$/i.test(t)) return true;
  if (/^(404|page not found|access denied)$/i.test(t)) return true;
  return false;
}

/**
 * Return cleaned text only if it's not garbage. Otherwise null.
 * Use this everywhere we'd previously call cleanText() on extracted content.
 */
function cleanIfReal(s) {
  const t = cleanText(s);
  return isGarbageText(t) ? null : t;
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ');
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------
function mergeExtracted(fromUrl, htmlExtracted, parsed) {
  const { values: html, sources: htmlSources, extra } = htmlExtracted;

  const values = {
    manufacturer: html.manufacturer || fromUrl.manufacturer || null,
    product_name: html.product_name || null,
    description:  html.description  || null,
    category:     fromUrl.category  || null,
    color:        fromUrl.color     || null,
    image_url:    resolveAbsoluteUrl(html.image_url, parsed) || null,
    catalog_url:  fromUrl.catalog_url,
  };

  const sources = {
    manufacturer: htmlSources.manufacturer || (fromUrl.manufacturer ? 'url_hostname' : null),
    product_name: htmlSources.product_name || null,
    description:  htmlSources.description  || null,
    category:     fromUrl.category ? 'url_path' : null,
    color:        fromUrl.color    ? 'url_slug' : null,
    image_url:    htmlSources.image_url || null,
    catalog_url:  'url_cleaned',
  };

  const warnings = [];
  if (!values.product_name) warnings.push('Could not detect the product name — please fill it in.');
  if (!values.image_url)    warnings.push('No hero image found.');
  if (!values.category)     warnings.push('Could not infer a category from the URL — please pick one.');

  if (extra && extra.colors && extra.colors.length > 0 && !values.color) {
    warnings.push(
      `Detected ${extra.colors.length} color swatches on the page — the form saves one color at a time, so pick the one you want.`
    );
  }

  return { values, sources, warnings, extra: extra || {} };
}

function resolveAbsoluteUrl(maybeRelative, baseParsed) {
  if (!maybeRelative) return null;
  try { return new URL(maybeRelative, baseParsed).toString(); }
  catch { return null; }
}

function sourcesFor(values, tag) {
  const out = {};
  for (const k of Object.keys(values)) out[k] = values[k] ? tag : null;
  return out;
}

// ---------------------------------------------------------------------------
// Response helper
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
