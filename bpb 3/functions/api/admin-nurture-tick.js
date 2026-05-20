/**
 * BPB Sprint 12C + 17 — /api/admin-nurture-tick
 *
 * Scheduled task that scans for clients due a nurture email and sends them.
 * Sprint 17 update: templates are now read from the nurture_email_templates table
 * so the /admin/nurture.html page can edit them without redeploys.
 *
 * Auth: requires header `x-bayside-cron-secret` matching env BAYSIDE_CRON_SECRET.
 *
 * Placeholders supported in templates (substituted at send time):
 *   {first_name}, {project_address}, {bid_amount_paren}, {proposal_url}, {unsubscribe_url}
 *
 * Query param `?dry_run=true` returns what WOULD be sent without sending.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-bayside-cron-secret',
  'Cache-Control': 'no-store',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  // ── Auth
  const provided = request.headers.get('x-bayside-cron-secret');
  if (!env.BAYSIDE_CRON_SECRET || provided !== env.BAYSIDE_CRON_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'SUPABASE config missing' }, 500);
  }
  if (!env.RESEND_API_KEY) {
    return jsonResponse({ error: 'RESEND_API_KEY missing' }, 500);
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dry_run') === 'true';
  const baseUrl = (env.PORTAL_BASE_URL || 'https://portal-baysidepavers.com').replace(/\/$/, '');
  const fromEmail = env.RESEND_FROM_EMAIL || 'Bayside Pavers <tim@mcmullen.properties>';

  // ── 1. Load templates from DB (Sprint 17 — was hardcoded in Sprint 12C)
  const tmplResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/nurture_email_templates?select=sequence_step,subject,paragraphs&order=sequence_step.asc`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!tmplResp.ok) {
    return jsonResponse({ error: 'Template load failed', detail: await tmplResp.text() }, 500);
  }
  const templates = await tmplResp.json();
  const templatesByStep = {};
  for (const t of templates) templatesByStep[t.sequence_step] = t;

  // ── 2. Fetch candidates
  const rpcResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/admin_nurture_candidates`,
    {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }
  );
  if (!rpcResp.ok) {
    return jsonResponse({ error: 'Candidates RPC failed', detail: await rpcResp.text() }, 500);
  }
  const candidates = await rpcResp.json();

  if (candidates.length === 0) {
    return jsonResponse({
      success: true, dry_run: dryRun, candidates: 0, sent: 0, failed: 0, results: [],
      message: 'No nurture emails due right now.',
    });
  }

  // ── 3. For each candidate, render + send + log
  const results = [];
  for (const c of candidates) {
    const tmpl = templatesByStep[c.next_step];
    if (!tmpl) {
      results.push({
        client_id: c.client_id, client_name: c.client_name, client_email: c.client_email,
        proposal_id: c.proposal_id, next_step: c.next_step,
        status: 'skipped', error: `No template for step ${c.next_step}`,
      });
      continue;
    }

    const ctx = {
      first_name: firstName(c.client_name),
      project_address: c.project_address,
      bid_total_amount: c.bid_total_amount,
      proposal_url: `${baseUrl}/p/${encodeURIComponent(c.canonical_slug)}`,
      unsubscribe_url: `${baseUrl}/api/nurture-unsubscribe?id=${encodeURIComponent(c.client_id)}`,
    };

    const subject = substitute(tmpl.subject, ctx);
    const paragraphs = (tmpl.paragraphs || []).map((p) => substitute(p, ctx));
    const text = buildText(paragraphs, ctx);
    const html = buildHtml(paragraphs, ctx);

    if (dryRun) {
      results.push({
        client_id: c.client_id, client_name: c.client_name, client_email: c.client_email,
        proposal_id: c.proposal_id, next_step: c.next_step,
        subject, status: 'would_send',
      });
      continue;
    }

    let sendResult, sendError;
    try {
      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromEmail,
          to: [c.client_email],
          subject, html, text,
          reply_to: 'tim@mcmullen.properties',
          headers: {
            'List-Unsubscribe': `<${ctx.unsubscribe_url}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }),
      });
      const resendData = await resendResp.json();
      if (!resendResp.ok) sendError = resendData.message || `Resend ${resendResp.status}`;
      else sendResult = resendData;
    } catch (e) {
      sendError = e.message || String(e);
    }

    const status = sendError ? 'failed' : 'sent';
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/nurture_email_sends`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          client_id: c.client_id,
          proposal_id: c.proposal_id,
          sequence_step: c.next_step,
          template_key: `step_${c.next_step}`,
          subject,
          body_preview: text.slice(0, 200),
          recipient_email: c.client_email,
          status,
          resend_id: sendResult ? sendResult.id : null,
          error_message: sendError || null,
        }),
      }
    ).catch((e) => console.error('send log insert failed (non-fatal):', e));

    results.push({
      client_id: c.client_id, client_name: c.client_name, client_email: c.client_email,
      proposal_id: c.proposal_id, next_step: c.next_step,
      subject, status,
      resend_id: sendResult ? sendResult.id : null,
      error: sendError || null,
    });
  }

  return jsonResponse({
    success: true, dry_run: dryRun,
    candidates: candidates.length,
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (kept in sync with admin-nurture-admin.js)
// ─────────────────────────────────────────────────────────────────────

function firstName(fullName) {
  if (!fullName) return 'there';
  return String(fullName).trim().split(/\s+/)[0];
}

function substitute(s, ctx) {
  const bidParen = ctx.bid_total_amount
    ? ` ($${Number(ctx.bid_total_amount).toLocaleString('en-US', { maximumFractionDigits: 0 })})`
    : '';
  return String(s ?? '')
    .replace(/\{first_name\}/g,      ctx.first_name || 'there')
    .replace(/\{project_address\}/g, ctx.project_address || 'your project')
    .replace(/\{bid_amount_paren\}/g, bidParen)
    .replace(/\{proposal_url\}/g,    ctx.proposal_url || '')
    .replace(/\{unsubscribe_url\}/g, ctx.unsubscribe_url || '');
}

function buildText(paragraphs, ctx) {
  const sig = '— Tim McMullen\nBayside Pavers\ntim@mcmullen.properties';
  return paragraphs.join('\n\n') + `\n\n${sig}\n\n---\nIf you'd prefer no more check-ins, click here to opt out: ${ctx.unsubscribe_url}`;
}

function buildHtml(paragraphs, ctx) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = paragraphs.map((p) => {
    if (p.includes('•')) {
      const lines = p.split('\n').filter(Boolean);
      const intro = lines.find((l) => !l.startsWith('•'));
      const bullets = lines.filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, ''));
      const introHtml = intro ? `<p style="margin:0 0 8px;color:#353535;font-size:15px;line-height:1.6;">${esc(intro)}</p>` : '';
      const ul = `<ul style="margin:0 0 16px;padding-left:22px;color:#353535;font-size:15px;line-height:1.6;">${bullets.map((b) => `<li style="margin-bottom:4px;">${esc(b)}</li>`).join('')}</ul>`;
      return introHtml + ul;
    }
    if (p.trim() === ctx.proposal_url) {
      return `<p style="margin:16px 0;"><a href="${esc(ctx.proposal_url)}" style="display:inline-block;background:#5d7e69;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">View your proposal →</a></p>`;
    }
    const linked = esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#4a6654;text-decoration:underline;">$1</a>');
    return `<p style="margin:0 0 16px;color:#353535;font-size:15px;line-height:1.6;white-space:pre-wrap;">${linked}</p>`;
  }).join('');
  const sig = `<p style="margin:22px 0 0;color:#353535;font-size:15px;line-height:1.6;white-space:pre-wrap;">— Tim McMullen\nBayside Pavers\ntim@mcmullen.properties</p>`;
  const footer = `<hr style="border:0;border-top:1px solid #e8e8e3;margin:24px 0 16px;"><p style="margin:0;color:#999;font-size:12px;line-height:1.5;">You're getting this because we recently sent you a proposal. If you'd prefer no more check-ins, <a href="${esc(ctx.unsubscribe_url)}" style="color:#777;">click here to opt out</a>.</p>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fafafa;"><tr><td align="center" style="padding:24px 16px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;background:#fff;border:1px solid #e8e8e3;border-radius:10px;"><tr><td style="padding:28px 32px;">${body}${sig}${footer}</td></tr></table></td></tr></table></body></html>`;
}
