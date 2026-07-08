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
  const raw = Array.isArray(body && body.messages) ? body.messages : [];
  const messages = raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_TURNS)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'messages must end with a user message' }, 400);
  }

  // ── Load the manual + branding ──
  const headers = { apikey: svcKey(env), Authorization: `Bearer ${svcKey(env)}` };
  let manual = '';
  let brand = {};
  try {
    const [manResp, brandResp] = await Promise.all([
      fetch(`${env.SUPABASE_URL}/rest/v1/help_manual_sections?select=title,content&order=sort_order.asc`, { headers }),
      fetch(`${env.SUPABASE_URL}/rest/v1/company_settings?id=eq.1&select=company_name,product_name,support_email&limit=1`, { headers }),
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
  if (!manual) {
    return json({ error: 'Help content unavailable right now — try again shortly.' }, 503);
  }

  const companyName = brand.company_name || 'the company';
  const productName = brand.product_name || 'the proposal portal';
  const supportLine = brand.support_email
    ? `If something isn't covered by the manual, suggest they contact ${brand.support_email}.`
    : `If something isn't covered by the manual, suggest they contact their company administrator.`;

  const system = [
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
        max_tokens: 700,
        system,
        messages,
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
