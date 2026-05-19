/**
 * BPB Sprint 5 — /api/send-chat-message
 * The Silent Failure Killer · Piece 1
 *
 * Designer chat-send with auto-email fallback. Drop-in replacement for
 * direct client_messages inserts from the admin chat UI.
 *
 * Behavior
 *   1. ALWAYS inserts a row into client_messages.
 *   2. If clients.account_setup_at IS NULL (the client has never signed in),
 *      ALSO fires a Resend email with the message body + a magic-link CTA.
 *      This prevents Yorktown-style silent failures where the designer's
 *      in-app message is invisible behind an account the client never
 *      created.
 *
 * Body (JSON)
 *   {
 *     client_id:      uuid    (required) — target client
 *     sender_user_id: uuid    (required) — auth.users id of the sender
 *     body:           text    (required, max 5000 chars)
 *     sender_role:    "master" | "designer"  (default "master")
 *   }
 *
 * Env vars (Cloudflare Pages)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL
 *
 * Response
 *   { ok, message_id, email_sent, client_has_account, fallback_path }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const PORTAL_BASE = 'https://portal-baysidepavers.com';
const TIM_REPLY_TO = 'tim@mcmullen.properties';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function clamp(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const client_id      = clamp(body.client_id, 36);
  const sender_user_id = clamp(body.sender_user_id, 36);
  const messageBody    = clamp(body.body, 5000);
  const sender_role    = clamp(body.sender_role, 20) || 'master';

  if (!UUID_RE.test(client_id))      return jsonResponse({ error: 'client_id is required and must be a UUID' }, 400);
  if (!UUID_RE.test(sender_user_id)) return jsonResponse({ error: 'sender_user_id is required and must be a UUID' }, 400);
  if (!messageBody)                  return jsonResponse({ error: 'body is required' }, 400);
  if (!['master', 'designer'].includes(sender_role)) {
    return jsonResponse({ error: 'sender_role must be "master" or "designer"' }, 400);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('send-chat-message: SUPABASE config missing');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  const sbHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Prefer: 'return=representation',
  };

  // ──────────────────────────────────────────────────────────────────
  // 1. Look up the client (need name, email, account_setup_at, user_id)
  // ──────────────────────────────────────────────────────────────────
  const clientResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(client_id)}&deleted_at=is.null&select=id,name,email,account_setup_at,user_id`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!clientResp.ok) {
    const errText = await clientResp.text();
    console.error('Client lookup failed:', clientResp.status, errText);
    return jsonResponse({ error: 'Could not look up client' }, 500);
  }
  const clientRows = await clientResp.json();
  if (!clientRows || !clientRows[0]) {
    return jsonResponse({ error: 'Client not found' }, 404);
  }
  const client = clientRows[0];

  // ──────────────────────────────────────────────────────────────────
  // 2. Insert the chat message (service role bypasses RLS)
  // ──────────────────────────────────────────────────────────────────
  const msgResp = await fetch(`${env.SUPABASE_URL}/rest/v1/client_messages`, {
    method: 'POST',
    headers: sbHeaders,
    body: JSON.stringify({
      client_id,
      sender_user_id,
      sender_role,
      body: messageBody,
    }),
  });

  if (!msgResp.ok) {
    const errText = await msgResp.text();
    console.error('client_messages insert failed:', msgResp.status, errText);
    return jsonResponse({ error: 'Could not save message', detail: errText }, 500);
  }

  const inserted = await msgResp.json();
  const message_id = (inserted && inserted[0] && inserted[0].id) || null;

  // ──────────────────────────────────────────────────────────────────
  // 3. Email fallback for clients who haven't activated their account
  // ──────────────────────────────────────────────────────────────────
  let email_sent = false;
  let fallback_path = 'none';

  if (!client.account_setup_at) {
    fallback_path = 'email';
    if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
      try {
        const magicLink = await generateMagicLink(env, client);
        if (magicLink) {
          email_sent = await sendChatMessageEmail(env, client, messageBody, magicLink);
        }
      } catch (e) {
        console.error('Chat email fallback failed (non-fatal):', e);
      }
    } else {
      console.log('send-chat-message: Resend not fully configured, email skipped.');
    }
  }

  return jsonResponse({
    ok: true,
    message_id,
    email_sent,
    client_has_account: !!client.account_setup_at,
    fallback_path,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Magic-link generation
//
// If the client has a Supabase user_id, use type=magiclink. Otherwise use
// type=invite to create the user. If 'invite' is rejected because the user
// already exists in auth.users, recurse once with the user_id forced.
// ──────────────────────────────────────────────────────────────────────────

async function generateMagicLink(env, client) {
  const redirectTo = `${PORTAL_BASE}/client/dashboard.html`;
  const linkType = client.user_id ? 'magiclink' : 'invite';

  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: linkType,
      email: client.email,
      options: { redirectTo },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    if (linkType === 'invite' && /already|exists|registered/i.test(errText)) {
      return generateMagicLink(env, { ...client, user_id: 'forced' });
    }
    console.error(`generate_link (${linkType}) failed:`, resp.status, errText);
    return null;
  }

  const data = await resp.json();
  return (data && data.properties && data.properties.action_link) || data.action_link || null;
}

// ──────────────────────────────────────────────────────────────────────────
// Email composition — branded chat-message fallback
// ──────────────────────────────────────────────────────────────────────────

async function sendChatMessageEmail(env, client, messageBody, magicLink) {
  const firstName = ((client.name || '').trim().split(/\s+/)[0]) || 'there';
  const subject = `💬 New message from Tim · Bayside Pavers`;

  // Render the message body with line breaks preserved as <br>.
  const messageHtml = esc(messageBody).replace(/\r?\n/g, '<br>');

  const text = [
    `Hi ${firstName},`,
    ``,
    `Tim from Bayside Pavers just sent you a message:`,
    ``,
    `  ${messageBody.split('\n').join('\n  ')}`,
    ``,
    `To reply and see your full proposal, sign in to your Bayside Portal account:`,
    `${magicLink}`,
    ``,
    `Or just reply to this email — your reply goes straight to Tim.`,
    ``,
    `— Bayside Portal`,
  ].join('\n');

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter','Onest',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#0e1218;background:#fff;">
  <div style="border-bottom:3px solid #5d7e69;padding-bottom:14px;margin-bottom:22px;">
    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#5d7e69;font-weight:700;margin-bottom:6px;">NEW MESSAGE · BAYSIDE PORTAL</div>
    <h1 style="font-size:22px;margin:0;color:#0e1218;line-height:1.3;font-weight:600;">Hi ${esc(firstName)} — Tim sent you a note.</h1>
  </div>

  <div style="background:#faf8f3;border-left:3px solid #5d7e69;padding:16px 18px;margin-bottom:24px;border-radius:4px;">
    <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#5d7e69;font-weight:700;margin-bottom:8px;">FROM TIM</div>
    <div style="font-size:15px;color:#0e1218;line-height:1.55;">${messageHtml}</div>
  </div>

  <div style="margin:24px 0 16px;text-align:center;">
    <a href="${esc(magicLink)}" style="display:inline-block;background:#5d7e69;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">View &amp; reply in Bayside Portal →</a>
  </div>

  <div style="background:#f7f8f5;border-radius:8px;padding:16px 18px;margin:24px 0;font-size:13px;color:#4a5450;line-height:1.55;">
    The button above signs you in automatically — no password needed. Once you're in, you can see all proposal details, request material changes, or lock in the project when you're ready.
    <br><br>
    <strong style="color:#0e1218;">Don't want to log in?</strong> Just reply to this email. Your reply goes directly to Tim.
  </div>

  <div style="border-top:1px solid #eee;padding-top:14px;color:#999;font-size:11px;line-height:1.5;text-align:center;">
    Bayside Portal · McMullen Properties
  </div>
</div>`.trim();

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:     env.RESEND_FROM_EMAIL,
        to:       [client.email],
        reply_to: TIM_REPLY_TO,
        subject,
        text,
        html,
      }),
    });
    if (resp.ok) return true;
    const errText = await resp.text();
    console.error('Resend chat-message email failed:', resp.status, errText);
    return false;
  } catch (e) {
    console.error('Resend exception (chat-message):', e);
    return false;
  }
}
