// ═══════════════════════════════════════════════════════════════════════════
// suggest-replies.js — Sprint 11
//
// Cloudflare Pages Function at POST /api/suggest-replies.
// Generates 3 contextual reply suggestions for a designer in the War Room.
//
// Input:  { client_id: <uuid> }
// Auth:   Bearer <designer/master access_token>
// Output: { ok: true, suggestions: [string, string, string] }
//      or { ok: false, error: "human-readable" }
//
// Flow:
//   1. Verify caller is master/designer via auth-util pattern (call
//      Supabase REST with their token, look up their profile)
//   2. Load thread context: last 6 messages + client + active proposal
//      + free revision state + discount window status
//   3. Build a tight prompt and call Anthropic Haiku 4.5
//   4. Parse strict JSON response and return suggestions
//
// Fallback: any failure returns ok=false with a benign error message and
// a static fallback set, so the chips still render something usable.
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const RECENT_MESSAGE_COUNT = 6;
const DISCOUNT_WINDOW_MS = 48 * 60 * 60 * 1000;

const FALLBACK_SUGGESTIONS = [
  "Happy to schedule a quick call to walk you through it — what's a good time?",
  "Great question — let me look into that and get back to you shortly.",
  "I can put together a quick comparison if that would help.",
];

export async function onRequestPost({ request, env }) {
  try {
    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ ok: false, error: 'API key not configured', suggestions: FALLBACK_SUGGESTIONS }, 200);
    }

    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ')) {
      return jsonResponse({ ok: false, error: 'Missing auth' }, 401);
    }
    const accessToken = auth.slice(7);

    const body = await request.json().catch(() => ({}));
    const clientId = body.client_id;
    if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      return jsonResponse({ ok: false, error: 'Invalid client_id' }, 400);
    }

    // Verify caller is staff. profiles RLS: only the user themselves can SELECT
    // their own row (or master sees all). If we get a row back with the right
    // role, we know the caller is staff.
    const profile = await sbFetchSingle(
      `${SUPABASE_URL}/rest/v1/profiles?select=id,role,display_name,is_active&limit=1`,
      accessToken,
    );
    if (!profile || profile.is_active === false || (profile.role !== 'master' && profile.role !== 'designer')) {
      return jsonResponse({ ok: false, error: 'Staff access required' }, 403);
    }

    // Load context (RLS scopes everything to what this caller can see)
    const [client, messages, proposalLinks] = await Promise.all([
      sbFetchSingle(
        `${SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}&select=id,name,email`,
        accessToken,
      ),
      sbFetchList(
        `${SUPABASE_URL}/rest/v1/client_messages?client_id=eq.${clientId}&select=sender_role,body,created_at&order=created_at.desc&limit=${RECENT_MESSAGE_COUNT}`,
        accessToken,
      ),
      sbFetchList(
        `${SUPABASE_URL}/rest/v1/client_proposals?client_id=eq.${clientId}&select=status,sent_at,signed_at,has_used_free_revision,proposal:proposals(id,address,project_address,bid_total_amount,show_signing_discount,published_proposals(slug,published_at,is_canonical))`,
        accessToken,
      ),
    ]);

    if (!client) {
      return jsonResponse({ ok: false, error: 'Client not found or no access' }, 404);
    }

    const promptContext = buildPromptContext({
      designer: profile,
      client,
      messages: (messages || []).reverse(), // chronological for prompt
      proposalLinks: proposalLinks || [],
    });

    const suggestions = await callAnthropic(env.ANTHROPIC_API_KEY, promptContext);

    return jsonResponse({ ok: true, suggestions });

  } catch (err) {
    console.error('[suggest-replies] error:', err);
    return jsonResponse({
      ok: false,
      error: err.message || 'Unknown error',
      suggestions: FALLBACK_SUGGESTIONS,
    }, 200);
  }
}

// ─── Supabase REST helpers ─────────────────────────────────────────────────
async function sbFetchSingle(url, accessToken) {
  const list = await sbFetchList(url, accessToken);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}
async function sbFetchList(url, accessToken) {
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': accessToken,
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Supabase ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ─── Prompt construction ──────────────────────────────────────────────────
function buildPromptContext({ designer, client, messages, proposalLinks }) {
  const designerName = designer.display_name || 'the designer';

  // Pick the most relevant proposal: prefer "sent" not yet signed; fall back
  // to most recently sent
  const sortedProps = [...proposalLinks]
    .filter(cp => cp.proposal)
    .sort((a, b) => (b.sent_at || '').localeCompare(a.sent_at || ''));
  const activeCp = sortedProps.find(cp => cp.status === 'sent') || sortedProps[0] || null;

  let proposalLine = 'No active proposal.';
  let discountNote = '';
  let revisionNote = '';
  if (activeCp && activeCp.proposal) {
    const p = activeCp.proposal;
    const addr = p.address || p.project_address || 'their project';
    const bid = p.bid_total_amount ? `$${Number(p.bid_total_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'unspecified amount';
    const status = activeCp.status || 'in progress';
    proposalLine = `Active proposal: ${addr} (${bid}, ${status}).`;

    if (p.show_signing_discount !== false) {
      const pubs = Array.isArray(p.published_proposals) ? p.published_proposals : [];
      const canonical = pubs.find(pp => pp.is_canonical) || pubs[0];
      if (canonical?.published_at) {
        const elapsed = Date.now() - new Date(canonical.published_at).getTime();
        const remaining = DISCOUNT_WINDOW_MS - elapsed;
        if (remaining > 0) {
          const hours = Math.floor(remaining / 3600000);
          discountNote = `5% signing discount expires in ${hours}h.`;
        }
      }
    }

    if (activeCp.has_used_free_revision) {
      revisionNote = 'Free revision has already been used.';
    } else {
      revisionNote = 'Free revision is still available.';
    }
  }

  const transcript = messages.length === 0
    ? '(No prior messages — this would be the designer\'s first reply.)'
    : messages.map(m => {
        const who = m.sender_role === 'homeowner'
          ? client.name || 'Homeowner'
          : (m.sender_role === 'master' || m.sender_role === 'designer') ? designerName : m.sender_role;
        return `${who}: ${(m.body || '').trim()}`;
      }).join('\n');

  return {
    designerName,
    clientName: client.name || 'the homeowner',
    proposalLine,
    discountNote,
    revisionNote,
    transcript,
  };
}

// ─── Anthropic call ────────────────────────────────────────────────────────
async function callAnthropic(apiKey, ctx) {
  const systemPrompt = [
    `You are helping ${ctx.designerName}, a Bayside Pavers designer, write quick reply suggestions in a chat with a homeowner.`,
    `Bayside Pavers installs hardscape: pavers, porcelain decking, retaining walls, fire features, pool decks. ICPI-certified install.`,
    ``,
    `Context:`,
    `Client: ${ctx.clientName}`,
    `${ctx.proposalLine}`,
    ctx.discountNote ? `${ctx.discountNote}` : '',
    ctx.revisionNote ? `${ctx.revisionNote}` : '',
    ``,
    `Recent conversation (oldest first):`,
    ctx.transcript,
    ``,
    `Generate 3 short reply suggestions ${ctx.designerName} could send next. Each must be:`,
    `- Under 110 characters`,
    `- Written in first person, conversational, no formal greeting`,
    `- Helpful and warm but not pushy`,
    `- Distinct in approach: one friendly/acknowledging, one informative/answer-focused, one action-oriented (offer to call, schedule, send PDF, etc.)`,
    ``,
    `Return ONLY a JSON object with this exact shape, no preamble or markdown:`,
    `{"suggestions":["text 1","text 2","text 3"]}`,
  ].filter(Boolean).join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      messages: [
        { role: 'user', content: systemPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error('No text in Anthropic response');
  }

  // Strip any markdown fences just in case
  const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Model returned malformed JSON');
  }

  const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const cleanedList = list
    .map(s => typeof s === 'string' ? s.trim() : '')
    .filter(s => s.length > 0 && s.length <= 200)
    .slice(0, 3);

  if (cleanedList.length < 3) {
    // Pad to 3 with fallbacks if model under-delivered
    while (cleanedList.length < 3) {
      cleanedList.push(FALLBACK_SUGGESTIONS[cleanedList.length] || FALLBACK_SUGGESTIONS[0]);
    }
  }
  return cleanedList;
}

// ─── HTTP helper ───────────────────────────────────────────────────────────
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
