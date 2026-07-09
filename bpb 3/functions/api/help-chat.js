// ═══════════════════════════════════════════════════════════════════════════
// /api/help-chat — SPRINT 4 (Claude-powered knowledge base)
//
// Staff-only in-app help assistant. Assembles the portal capability manual
// from help_manual_sections (Supabase) into Claude's system prompt and
// answers questions about how to use the product.
//
// AUTH: gated by functions/api/_middleware.js at level 'staff' (active
// master or designer JWT required). No client identity is trusted from the
// body.
//
// REQUEST (POST, JSON):
//   { messages: [ { role: 'user'|'assistant', content: string }, ... ] }
//   — the client sends its visible history; capped server-side.
//
// RESPONSE: { ok: true, reply: string }
//
// COST CONTROLS: history capped at 12 turns / 2000 chars each; manual is
// ~2k tokens; max_tokens 700. Model: claude-sonnet-4-6.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY),
//      ANTHROPIC_API_KEY (already configured for parse-bid-pdf /
//      suggest-replies).
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TURNS = 12;
const MAX_CHARS = 2000;
const MODEL = 'claude-sonnet-4-6';
const PRO_MAX_TOKENS = 1400;   // field answers can need step detail
const PORTAL_MAX_TOKENS = 700;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function svcKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Help assistant not configured (missing ANTHROPIC_API_KEY)' }, 500);
  }
  if (!env.SUPABASE_URL || !svcKey(env)) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  // ── Parse + sanitize the conversation ──
  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const mode = body && body.mode === 'pro' ? 'pro' : 'portal';
  const raw = Array.isArray(body && body.messages) ? body.messages : [];
  const messages = raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_TURNS)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'messages must end with a user message' }, 400);
  }

  // ── Load the manual + branding (STAGE 4: caller's company) ──
  const headers = { apikey: svcKey(env), Authorization: `Bearer ${svcKey(env)}` };

  // Resolve the caller's company from the JWT the middleware already
  // validated; fall back to the default settings row.
  let companyFilter = 'id=eq.1';
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (token) {
      const uResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: svcKey(env), Authorization: `Bearer ${token}` },
      });
      if (uResp.ok) {
        const u = await uResp.json();
        if (u && u.id) {
          const pResp = await fetch(
            `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=company_id&limit=1`,
            { headers }
          );
          if (pResp.ok) {
            const rows = await pResp.json();
            if (rows && rows[0] && rows[0].company_id) {
              companyFilter = `company_id=eq.${encodeURIComponent(rows[0].company_id)}`;
            }
          }
        }
      }
    }
  } catch (_) { /* default row */ }

  let manual = '';
  let brand = {};
  try {
    const [manResp, brandResp] = await Promise.all([
      fetch(`${env.SUPABASE_URL}/rest/v1/help_manual_sections?select=title,content&order=sort_order.asc`, { headers }),
      fetch(`${env.SUPABASE_URL}/rest/v1/company_settings?${companyFilter}&select=company_name,product_name,support_email&limit=1`, { headers }),
    ]);
    if (manResp.ok) {
      const sections = await manResp.json();
      manual = (sections || [])
        .map(s => `## ${s.title}\n${s.content.trim()}`)
        .join('\n\n');
    }
    if (brandResp.ok) {
      const rows = await brandResp.json();
      brand = (rows && rows[0]) || {};
    }
  } catch (e) {
    console.error('help-chat: manual load failed', e);
  }
  if (mode === 'portal' && !manual) {
    return json({ error: 'Help content unavailable right now — try again shortly.' }, 503);
  }

  const companyName = brand.company_name || 'the company';
  const productName = brand.product_name || 'the proposal portal';
  const supportLine = brand.support_email
    ? `If something isn't covered by the manual, suggest they contact ${brand.support_email}.`
    : `If something isn't covered by the manual, suggest they contact their company administrator.`;

  let system;
  if (mode === 'pro') {
    system = [
      `You are "Ask a Pro" — the expert hardscape consultant built into ${companyName}'s proposal platform, answering questions from a professional hardscape DESIGNER who may be standing in a client's yard right now.`,
      ``,
      `Your expertise: paver/slab/natural-stone materials and their properties; base preparation, compaction, bedding, edge restraint, and jointing; ICPI/CMHA and ASTM standards; segmental retaining walls and geogrid; drainage, permeable systems, and grading; pool decks, driveways, steps, fire features, turf, and lighting; manufacturer product lines (Belgard, Techo-Bloc, Unilock, MSI, and others).`,
      ``,
      `Rules:`,
      `- Be direct and field-practical. Numbered steps for procedures, real numbers (depths, compaction lifts, slopes, joint widths) with units.`,
      `- For building codes, permits, and setbacks — especially California counties and cities — USE WEB SEARCH to check the current local requirement rather than guessing. Name the jurisdiction and code section when you can, and always add one line advising the designer to confirm with the local building department, since requirements change and vary by parcel.`,
      `- Use web search for anything current: product availability, spec sheets, code updates, recent standards revisions.`,
      `- If a question is truly outside hardscape/construction (e.g. legal contracts, medical), say so briefly and suggest the right kind of professional.`,
      `- Plain text only — no markdown headers or bold; simple numbered/dashed lists are fine. Keep answers tight enough to read on a phone.`,
    ].join('\n');
  } else {
    system = [
      `You are the built-in help assistant for "${companyName} ${productName}", a proposal platform for hardscaping companies. You are talking to a STAFF member (a designer or the company administrator) inside the product.`,
      ``,
      `Answer questions about how to use the product, grounded STRICTLY in the capability manual below. Rules:`,
      `- Be concise and practical: short answers, numbered steps for how-to questions, exact page paths and button labels when the manual provides them.`,
      `- Never invent features, buttons, pages, or behaviors that are not in the manual. If the manual doesn't cover something, say so plainly. ${supportLine}`,
      `- Stay on topic: you only help with this product. Politely decline unrelated requests (general coding help, world knowledge, etc.) and steer back to the portal.`,
      `- Plain text only — no markdown headers or bold; simple numbered/dashed lists are fine.`,
      ``,
      `═══ CAPABILITY MANUAL ═══`,
      manual,
    ].join('\n');
  }

  // ── Ask Claude ──
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: mode === 'pro' ? PRO_MAX_TOKENS : PORTAL_MAX_TOKENS,
        system,
        messages,
        ...(mode === 'pro' ? {
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        } : {}),
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('help-chat: Anthropic error', resp.status, detail.slice(0, 300));
      return json({ error: 'The help assistant is temporarily unavailable.' }, 502);
    }

    const data = await resp.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!reply) return json({ error: 'Empty response from assistant' }, 502);
    return json({ ok: true, reply });
  } catch (e) {
    console.error('help-chat: request failed', e);
    return json({ error: 'The help assistant is temporarily unavailable.' }, 502);
  }
}
