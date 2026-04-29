// ═══════════════════════════════════════════════════════════════════════════
// /api/accept-referral  —  Phase 4.0c
//
// Public endpoint (no JWT). Called from /refer/?t={token} when the referee
// submits their info on the landing page. Creates a Supabase Auth user +
// linked clients row, with auto-assignment to the referrer's designer per
// Tim's spec ("designers own their referrals" — clients.created_by mirrors
// referrer.created_by).
//
// Steps:
//   1. Validate the scheduling_token is real and status='sent'.
//   2. Validate input (name, email, optional phone, address).
//   3. Look up referrer's clients row to grab their assigned designer
//      (created_by) — that's who gets the new homeowner.
//   4. Create Supabase Auth user with the address-as-password convention.
//   5. Insert clients row: created_by=referrer.created_by, referred_by=
//      referrer.id, must_change_password=true.
//   6. Update referrals row with referred_client_id (status stays 'sent'
//      until they actually appear at the design appointment — Round 2 will
//      handle the appointment lifecycle).
//   7. Email the new homeowner welcome+credentials (same template as
//      create-homeowner-account.js).
//   8. Email the assigned designer: "New referral signed up — here's who
//      they are, who referred them, schedule incoming via Acuity."
//   9. Return success + the Acuity URL with their info pre-filled, so the
//      browser can redirect them straight into scheduling.
// ═══════════════════════════════════════════════════════════════════════════

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL    = env.SUPABASE_URL;
    const SERVICE_ROLE    = env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY  = env.RESEND_API_KEY;
    const RESEND_FROM     = env.RESEND_FROM || 'Tim McMullen <tim@mcmullen.properties>';
    const ACUITY_BASE     = 'https://baysidepaversfreeconsultation.as.me/';

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { error: 'Server not configured' });
    }

    // ─── 1. Validate input ───────────────────────────────────────────────
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { error: 'Invalid JSON body' });
    }

    const tok       = String(body.token   || '').trim();
    const email     = String(body.email   || '').trim().toLowerCase();
    const name      = String(body.name    || '').trim();
    const address   = String(body.address || '').trim();
    const phoneIn   = String(body.phone   || '').trim();
    const phone     = phoneIn || null;

    if (!tok) return json(400, { error: 'Missing referral token' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(400, { error: 'Invalid email address' });
    }
    if (!name)    return json(400, { error: 'Your name is required' });
    if (!address) return json(400, { error: 'Property address is required' });

    // ─── 2. Look up the referral by token ───────────────────────────────
    const referralResp = await fetch(
      SUPABASE_URL + '/rest/v1/referrals' +
      '?scheduling_token=eq.' + encodeURIComponent(tok) +
      '&select=id,status,referrer_client_id,referred_client_id',
      {
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
        },
      }
    );
    if (!referralResp.ok) {
      return json(502, { error: 'Could not look up referral' });
    }
    const referralRows = await referralResp.json();
    const referral = Array.isArray(referralRows) && referralRows[0];
    if (!referral) {
      return json(404, { error: 'Referral link not found or expired' });
    }
    if (referral.referred_client_id) {
      return json(409, { error: 'This referral link has already been used' });
    }
    if (referral.status !== 'sent' && referral.status !== 'scheduled') {
      return json(409, { error: 'This referral link is no longer active' });
    }

    // ─── 3. Look up referrer + their assigned designer ─────────────────
    const referrerResp = await fetch(
      SUPABASE_URL + '/rest/v1/clients?id=eq.' + encodeURIComponent(referral.referrer_client_id) +
      '&select=id,name,email,created_by',
      {
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
        },
      }
    );
    if (!referrerResp.ok) {
      return json(502, { error: 'Could not look up referrer' });
    }
    const referrerRows = await referrerResp.json();
    const referrer = Array.isArray(referrerRows) && referrerRows[0];
    if (!referrer) {
      return json(502, { error: 'Referrer record not found' });
    }
    const designerUserId = referrer.created_by; // auto-assignment target

    // Look up the designer's profile (for email + display name).
    let designerProfile = null;
    if (designerUserId) {
      const dpResp = await fetch(
        SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(designerUserId) +
        '&select=id,display_name,email,is_active',
        {
          headers: {
            'apikey': SERVICE_ROLE,
            'Authorization': 'Bearer ' + SERVICE_ROLE,
          },
        }
      );
      if (dpResp.ok) {
        const dpRows = await dpResp.json();
        designerProfile = Array.isArray(dpRows) && dpRows[0];
      }
    }

    // ─── 4. Normalize address → initial password (same rule as 4.0a) ──
    const initialPassword = address.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (initialPassword.length < 8) {
      return json(400, {
        error: 'Address normalizes to "' + initialPassword + '" (too short for a password). ' +
               'Please use the full street address including unit number.'
      });
    }

    // ─── 5. Create Supabase Auth user ────────────────────────────────────
    const authCreateResp = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE,
        'Authorization': 'Bearer ' + SERVICE_ROLE,
      },
      body: JSON.stringify({
        email,
        password: initialPassword,
        email_confirm: true,
        user_metadata: {
          full_name: name,
          account_type: 'homeowner',
          referred_by_client_id: referrer.id,
        },
      }),
    });

    if (!authCreateResp.ok) {
      const errText = await authCreateResp.text();
      if (authCreateResp.status === 422 ||
          /already.*registered/i.test(errText) ||
          /already.*exists/i.test(errText)) {
        return json(409, {
          error: 'An account already exists for this email. Sign in at /account/signin.html instead.'
        });
      }
      return json(502, { error: 'Auth admin API error: ' + errText.slice(0, 240) });
    }

    const authCreateData = await authCreateResp.json();
    const newUserId = authCreateData.id || (authCreateData.user && authCreateData.user.id);
    if (!newUserId) {
      return json(502, { error: 'Auth API returned no user id' });
    }

    // ─── 6. Insert clients row with auto-assignment ─────────────────────
    const clientResp = await fetch(SUPABASE_URL + '/rest/v1/clients', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE,
        'Authorization': 'Bearer ' + SERVICE_ROLE,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        user_id: newUserId,
        created_by: designerUserId, // auto-assigned to referrer's designer
        referred_by: referrer.id,    // link to referrer's clients row
        name,
        email,
        phone,
        address,
        account_setup_at: new Date().toISOString(),
        must_change_password: true,
      }),
    });

    if (!clientResp.ok) {
      const errText = await clientResp.text();
      // Best-effort rollback of orphan auth user.
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + newUserId, {
        method: 'DELETE',
        headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE },
      }).catch(() => {});

      if (/duplicate|unique/i.test(errText)) {
        return json(409, { error: 'A client with this email already exists' });
      }
      return json(502, { error: 'Client row insert failed: ' + errText.slice(0, 240) });
    }
    const clientRows = await clientResp.json();
    const newClient  = Array.isArray(clientRows) ? clientRows[0] : clientRows;

    // ─── 7. Update referrals row with referred_client_id ────────────────
    await fetch(
      SUPABASE_URL + '/rest/v1/referrals?id=eq.' + encodeURIComponent(referral.id),
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
        },
        body: JSON.stringify({ referred_client_id: newClient.id }),
      }
    ).catch(() => {});

    // ─── 8. Build Acuity prefill URL ────────────────────────────────────
    const firstSpace = name.indexOf(' ');
    const firstName  = firstSpace > 0 ? name.slice(0, firstSpace) : name;
    const lastName   = firstSpace > 0 ? name.slice(firstSpace + 1) : '';

    const acuityParams = new URLSearchParams();
    acuityParams.set('firstName', firstName);
    if (lastName) acuityParams.set('lastName', lastName);
    acuityParams.set('email', email);
    if (phone) acuityParams.set('phone', phone);
    const acuityUrl = ACUITY_BASE + '?' + acuityParams.toString();

    // ─── 9. Send the welcome email + designer notification (best-effort) ─
    const origin = new URL(request.url).origin;
    const signinUrl = origin + '/account/signin.html';
    const designerName = (designerProfile && designerProfile.display_name) || 'your Bayside designer';
    const refeeFirstName = firstName || 'there';

    let homeownerEmailSent = false;
    let designerEmailSent  = false;
    let emailError = null;

    if (RESEND_API_KEY) {
      // (a) Homeowner welcome with credentials
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_API_KEY,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    RESEND_FROM,
            to:      [email],
            subject: 'Your Bayside Pavers account is ready',
            html:    buildHomeownerWelcomeHtml({ name: refeeFirstName, email, initialPassword, signinUrl, designerName }),
            text:    buildHomeownerWelcomeText({ name: refeeFirstName, email, initialPassword, signinUrl, designerName }),
          }),
        });
        homeownerEmailSent = r.ok;
        if (!r.ok) emailError = 'Homeowner email failed: ' + (await r.text()).slice(0, 240);
      } catch (err) {
        emailError = 'Homeowner email error: ' + ((err && err.message) || 'unknown');
      }

      // (b) Designer notification with new referral details + Acuity URL
      if (designerProfile && designerProfile.email) {
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + RESEND_API_KEY,
              'Content-Type':  'application/json',
            },
            body: JSON.stringify({
              from:    RESEND_FROM,
              to:      [designerProfile.email],
              subject: 'New referral signed up: ' + name + ' (from ' + referrer.name + ')',
              html:    buildDesignerNotifyHtml({ designerName: designerProfile.display_name || 'there', refereeName: name, referrerName: referrer.name, refereeEmail: email, refereePhone: phone, address, acuityUrl }),
              text:    buildDesignerNotifyText({ designerName: designerProfile.display_name || 'there', refereeName: name, referrerName: referrer.name, refereeEmail: email, refereePhone: phone, address, acuityUrl }),
            }),
          });
          designerEmailSent = r.ok;
          if (!r.ok && !emailError) emailError = 'Designer email failed: ' + (await r.text()).slice(0, 240);
        } catch (err) {
          if (!emailError) emailError = 'Designer email error: ' + ((err && err.message) || 'unknown');
        }
      }
    } else {
      emailError = 'RESEND_API_KEY not configured';
    }

    return json(200, {
      ok: true,
      client_id:        newClient.id,
      acuity_url:       acuityUrl,
      signin_url:       signinUrl,
      initial_password: initialPassword,
      designer_name:    designerName,
      homeowner_email_sent: homeownerEmailSent,
      designer_email_sent:  designerEmailSent,
      email_error:       emailError,
    });

  } catch (err) {
    return json(500, { error: (err && err.message) || 'Unexpected server error' });
  }
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

// ───────────────────────────────────────────────────────────────────────────
// Email bodies
// ───────────────────────────────────────────────────────────────────────────

function buildHomeownerWelcomeHtml({ name, email, initialPassword, signinUrl, designerName }) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="background:#5d7e69;padding:32px 40px;text-align:center;">' +
'<h1 style="margin:0;color:#fff;font-size:24px;font-weight:600;letter-spacing:-0.01em;">Welcome to Bayside Pavers</h1>' +
'</td></tr>' +
'<tr><td style="padding:36px 40px 24px;">' +
'<p style="margin:0 0 18px;font-size:16px;line-height:1.6;">Hi ' + escapeHtml(name) + ',</p>' +
'<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#58595b;">Your Bayside Pavers account is set up. ' + escapeHtml(designerName) + ' is your assigned designer — they will reach out to confirm your scheduled appointment.</p>' +
'<div style="background:#f7f7f4;border-radius:6px;padding:20px 24px;margin:24px 0;">' +
'<p style="margin:0 0 8px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#58595b;font-weight:600;">Your sign-in</p>' +
'<p style="margin:0 0 6px;font-size:14px;"><strong>Email:</strong> ' + escapeHtml(email) + '</p>' +
'<p style="margin:0;font-size:14px;"><strong>Password:</strong> <code style="background:#dad7c5;padding:2px 8px;border-radius:3px;font-family:SF Mono,Menlo,monospace;font-size:13px;">' + escapeHtml(initialPassword) + '</code></p>' +
'</div>' +
'<p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#58595b;">That password is your property address (lowercased, no spaces). We will prompt you to set your own when you sign in.</p>' +
'<div style="text-align:center;margin:32px 0 8px;">' +
'<a href="' + escapeHtml(signinUrl) + '" style="display:inline-block;background:#5d7e69;color:#fff;text-decoration:none;padding:14px 32px;border-radius:4px;font-size:15px;font-weight:600;">Sign in to your account</a>' +
'</div></td></tr>' +
'<tr><td style="padding:24px 40px;background:#f7f7f4;border-top:1px solid #e4e4df;text-align:center;">' +
'<p style="margin:0;font-size:12px;color:#70726f;">Bayside Pavers · Creating backyards people love</p>' +
'</td></tr></table></td></tr></table></body></html>';
}

function buildHomeownerWelcomeText({ name, email, initialPassword, signinUrl, designerName }) {
  return [
    'Hi ' + name + ',',
    '',
    'Your Bayside Pavers account is set up. ' + designerName + ' is your assigned designer.',
    '',
    'Your sign-in:',
    '  Email:    ' + email,
    '  Password: ' + initialPassword,
    '',
    'That password is your property address (lowercased, no spaces).',
    'We will prompt you to set your own when you sign in.',
    '',
    'Sign in: ' + signinUrl,
    '',
    '— Bayside Pavers',
  ].join('\n');
}

function buildDesignerNotifyHtml({ designerName, refereeName, referrerName, refereeEmail, refereePhone, address, acuityUrl }) {
  const phoneRow = refereePhone
    ? '<p style="margin:6px 0;font-size:14px;"><strong>Phone:</strong> ' + escapeHtml(refereePhone) + '</p>'
    : '';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="background:#5d7e69;padding:24px 40px;">' +
'<h1 style="margin:0;color:#fff;font-size:18px;font-weight:600;">New referral signed up</h1>' +
'</td></tr>' +
'<tr><td style="padding:28px 40px;">' +
'<p style="margin:0 0 18px;font-size:15px;color:#58595b;">Hi ' + escapeHtml(designerName) + ', a new referral just created their Bayside account. They are heading to Acuity now to schedule.</p>' +
'<div style="background:#f7f7f4;border-radius:6px;padding:18px 22px;margin:18px 0;">' +
'<p style="margin:0 0 12px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#58595b;font-weight:600;">New homeowner</p>' +
'<p style="margin:6px 0;font-size:14px;"><strong>Name:</strong> ' + escapeHtml(refereeName) + '</p>' +
'<p style="margin:6px 0;font-size:14px;"><strong>Email:</strong> ' + escapeHtml(refereeEmail) + '</p>' +
phoneRow +
'<p style="margin:6px 0;font-size:14px;"><strong>Address:</strong> ' + escapeHtml(address) + '</p>' +
'</div>' +
'<div style="background:#dad7c5;border-radius:6px;padding:14px 18px;margin:18px 0;">' +
'<p style="margin:0;font-size:13px;color:#1f2125;"><strong>Referred by:</strong> ' + escapeHtml(referrerName) + '</p>' +
'<p style="margin:8px 0 0;font-size:12px;color:#58595b;">When ' + escapeHtml((refereeName||'').split(/[\s,&]+/)[0] || 'this client') + '\'s design appointment completes, ' + escapeHtml((referrerName||'').split(/[\s,&]+/)[0] || 'the referrer') + ' will earn $500 toward their next project.</p>' +
'</div>' +
'<p style="margin:18px 0 8px;font-size:13px;color:#58595b;">They were redirected to Acuity to schedule. You will get a separate confirmation from Acuity once they book a slot.</p>' +
'</td></tr>' +
'<tr><td style="padding:18px 40px;background:#f7f7f4;border-top:1px solid #e4e4df;text-align:center;">' +
'<p style="margin:0;font-size:11px;color:#70726f;">Bayside Pavers · Internal notification</p>' +
'</td></tr></table></td></tr></table></body></html>';
}

function buildDesignerNotifyText({ designerName, refereeName, referrerName, refereeEmail, refereePhone, address, acuityUrl }) {
  return [
    'Hi ' + designerName + ',',
    '',
    'A new referral just created their Bayside account. They are heading to Acuity now to schedule.',
    '',
    'NEW HOMEOWNER:',
    '  Name:    ' + refereeName,
    '  Email:   ' + refereeEmail,
    (refereePhone ? '  Phone:   ' + refereePhone : null),
    '  Address: ' + address,
    '',
    'REFERRED BY: ' + referrerName,
    'When this design appointment completes, ' + referrerName + ' earns $500 toward their next project.',
    '',
    'You will get a separate confirmation from Acuity once they book a slot.',
    '',
    '— Bayside Pavers · Internal notification',
  ].filter(Boolean).join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
