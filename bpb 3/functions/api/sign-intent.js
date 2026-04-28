/**
 * BPB Phase 1B.7 — /api/sign-intent
 *
 * POST /api/sign-intent
 *   body: {
 *     proposal_id:    string (uuid, required)
 *     slug:           string (optional, the published_proposals.slug viewed)
 *     viewer_name:    string (required, ≤120)
 *     viewer_email:   string (required, valid email, ≤200)
 *     viewer_phone:   string (optional, ≤40)
 *     viewer_message: string (optional, ≤2000)
 *     referrer:       string (optional, ≤500)
 *   }
 *
 * Behavior:
 *   1. Validate input. Reject 400 on bad payload.
 *   2. Insert one row into public.signature_intents via the Supabase REST
 *      API using the service role key (RLS bypass). Returns 500 if the
 *      insert fails — the row is the source of truth, so a failure here
 *      is fatal for the request.
 *   3. (Best effort) Send a notification email to Tim via Resend. Only
 *      runs when both RESEND_API_KEY and RESEND_FROM_EMAIL env vars are
 *      configured. Failures here are logged but do not fail the request,
 *      since the row already exists in Supabase and Tim can follow up
 *      manually.
 *   4. On successful email, PATCH the row's notified_at timestamp.
 *
 * Required env vars (already set on bayside-proposals CF Pages):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env vars for email notifications:
 *   RESEND_API_KEY              — Resend API key
 *   RESEND_FROM_EMAIL           — must be a Resend-verified sender domain
 *                                 (e.g. "Bayside Pavers <proposals@mcmullen.properties>")
 *   SIGN_INTENT_NOTIFY_EMAIL    — destination address;
 *                                 default: tim@mcmullen.properties
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clamp(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  // ─── Parse + validate ──────────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const proposal_id    = clamp(body.proposal_id, 36);
  const slug           = clamp(body.slug, 200);
  const viewer_name    = clamp(body.viewer_name, 120);
  const viewer_email   = clamp(body.viewer_email, 200);
  const viewer_phone   = clamp(body.viewer_phone, 40);
  const viewer_message = clamp(body.viewer_message, 2000);
  const referrer       = clamp(body.referrer, 500);

  if (!UUID_RE.test(proposal_id)) {
    return jsonResponse({ error: 'proposal_id missing or invalid' }, 400);
  }
  if (!viewer_name) {
    return jsonResponse({ error: 'Name is required' }, 400);
  }
  if (!EMAIL_RE.test(viewer_email)) {
    return jsonResponse({ error: 'Valid email is required' }, 400);
  }

  // ─── Insert into Supabase ──────────────────────────────────────────────
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('sign-intent: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
    return jsonResponse({ error: 'Server is misconfigured. Please call Tim directly.' }, 500);
  }

  const sbHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Prefer: 'return=representation',
  };

  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  const userAgent = request.headers.get('User-Agent') || '';

  const insertResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/signature_intents`,
    {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        proposal_id,
        published_slug:  slug || null,
        viewer_name,
        viewer_email,
        viewer_phone:    viewer_phone   || null,
        viewer_message:  viewer_message || null,
        user_agent:      userAgent      || null,
        client_ip:       clientIp       || null,
        referrer:        referrer       || null,
      }),
    }
  );

  if (!insertResp.ok) {
    const errBody = await insertResp.text();
    console.error('signature_intents insert failed:', insertResp.status, errBody);
    return jsonResponse(
      { error: 'Could not save your request. Please call Tim directly at the number on the proposal.' },
      500
    );
  }

  const inserted = await insertResp.json();
  const intentId = (inserted && inserted[0] && inserted[0].id) || null;

  // ─── Best-effort email notification ────────────────────────────────────
  // Both env vars must be set for email to attempt. If either is missing
  // we simply skip — the row in Supabase is the source of truth and Tim
  // can monitor it via dashboard / Supabase Studio.
  if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
    const notifyEmail = env.SIGN_INTENT_NOTIFY_EMAIL || 'tim@mcmullen.properties';

    try {
      // Fetch proposal context so the email is actionable for Tim.
      let propRow = {};
      try {
        const propResp = await fetch(
          `${env.SUPABASE_URL}/rest/v1/proposals?id=eq.${encodeURIComponent(proposal_id)}&select=address,city,bid_total_amount`,
          {
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );
        if (propResp.ok) {
          const rows = await propResp.json();
          if (rows && rows[0]) propRow = rows[0];
        }
      } catch (e) {
        console.error('proposal lookup failed (non-fatal):', e);
      }

      const proposalUrl = slug
        ? `https://bayside-proposals.pages.dev/p/${slug}`
        : '(no slug supplied)';
      const totalStr = propRow.bid_total_amount
        ? '$' + Number(propRow.bid_total_amount).toLocaleString('en-US')
        : '—';
      const addressStr = propRow.address
        ? propRow.address + (propRow.city ? `, ${propRow.city}` : '')
        : '(address unknown)';

      const subject = `🟢 New signature intent — ${addressStr}`;
      const lines = [
        `${viewer_name} just clicked "Ready to sign" on a Bayside proposal page.`,
        '',
        `Property:   ${addressStr}`,
        `Bid total:  ${totalStr}`,
        `Proposal:   ${proposalUrl}`,
        '',
        'Contact:',
        `  Name:  ${viewer_name}`,
        `  Email: ${viewer_email}`,
      ];
      if (viewer_phone) lines.push(`  Phone: ${viewer_phone}`);
      lines.push('');
      if (viewer_message) {
        lines.push("Their message:");
        lines.push(`  ${viewer_message}`);
      } else {
        lines.push('(no message provided)');
      }
      lines.push('');
      lines.push(`intent_id: ${intentId || '(unknown)'}`);
      const text = lines.join('\n');

      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.RESEND_FROM_EMAIL,
          to: [notifyEmail],
          reply_to: viewer_email,
          subject,
          text,
        }),
      });

      if (resendResp.ok && intentId) {
        // Mark the row notified. Failure here is non-fatal.
        await fetch(
          `${env.SUPABASE_URL}/rest/v1/signature_intents?id=eq.${encodeURIComponent(intentId)}`,
          {
            method: 'PATCH',
            headers: sbHeaders,
            body: JSON.stringify({ notified_at: new Date().toISOString() }),
          }
        ).catch((e) => console.error('notified_at PATCH failed:', e));
      } else if (!resendResp.ok) {
        const errText = await resendResp.text();
        console.error('Resend email failed:', resendResp.status, errText);
      }
    } catch (e) {
      console.error('Email notification crashed (non-fatal):', e);
    }
  } else {
    console.log('sign-intent: Resend not configured, skipping email notification.');
  }

  return jsonResponse({ ok: true, intent_id: intentId });
}
