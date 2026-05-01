// ═══════════════════════════════════════════════════════════════════════════
// /api/accept-referral  —  Phase 4.0c (Round 1) + Round 3 (code path)
//
// Public endpoint (no JWT). Two entry paths converge here:
//
//   1. Token path  ({ token, name, email, address, phone? }):
//      Original email-link flow. Body has the scheduling_token from the
//      one-time invite email; the referrals row already exists (status=
//      'sent') and just needs referred_client_id stamped on it.
//
//   2. Code path   ({ code,  name, email, address, phone? }):
//      Round 3 share-link flow. The friend visited /refer/?code=XYZ from
//      a homeowner's permanent share link. The referrals row does NOT
//      yet exist — we look up the referrer by clients.refer_code, then
//      INSERT a fresh referrals row including referred_client_id at
//      creation time.
//
// Shared steps after the path branch:
//   - Validate input (name, email, address, optional phone)
//   - Look up referrer's designer (clients.created_by → profiles)
//   - Normalize address → initial password
//   - Create Supabase Auth user
//   - Insert clients row (referred_by = referrer.id, created_by = designer)
//   - Create / update the referrals row
//   - Build Acuity prefill URL
//   - Email new homeowner welcome + designer notification (best-effort)
//
// Phase 4 closeout (R3): hardcoded PUBLIC_BASE_URL replaces the previous
// `new URL(request.url).origin` derivation. Emails always need to point
// at the real production domain regardless of which origin the function
// was invoked through (preview deploys, *.pages.dev, etc).
// ═══════════════════════════════════════════════════════════════════════════

const PUBLIC_BASE_URL = 'https://portal-baysidepavers.com';

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

    // ─── 1. Parse body ───────────────────────────────────────────────────
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { error: 'Invalid JSON body' });
    }

    const tok       = String(body.token || '').trim();
    const code      = String(body.code  || '').trim();
    const email     = String(body.email   || '').trim().toLowerCase();
    const name      = String(body.name    || '').trim();
    const address   = String(body.address || '').trim();
    const phoneIn   = String(body.phone   || '').trim();
    const phone     = phoneIn || null;

    if (!tok && !code) return json(400, { error: 'Missing referral token or share code' });
    if (tok && code)   return json(400, { error: 'Provide either token or code, not both' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(400, { error: 'Invalid email address' });
    }
    if (!name)    return json(400, { error: 'Your name is required' });
    if (!address) return json(400, { error: 'Property address is required' });

    // ─── 2. Resolve the referrer (and existing referral if token path) ──
    let referral = null;       // populated only on token path
    let referrer = null;       // populated either way

    if (tok) {
      // Token path: fetch the existing referrals row
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
      referral = Array.isArray(referralRows) && referralRows[0];
      if (!referral) {
        return json(404, { error: 'Referral link not found or expired' });
      }
      if (referral.referred_client_id) {
        return json(409, { error: 'This referral link has already been used' });
      }
      if (referral.status !== 'sent' && referral.status !== 'scheduled') {
        return json(409, { error: 'This referral link is no longer active' });
      }

      // Now look up the referrer using referral.referrer_client_id
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
      referrer = Array.isArray(referrerRows) && referrerRows[0];
      if (!referrer) {
        return json(502, { error: 'Referrer record not found' });
      }
    } else {
      // Code path: look up referrer directly by refer_code
      const referrerResp = await fetch(
        SUPABASE_URL + '/rest/v1/clients' +
        '?refer_code=eq.' + encodeURIComponent(code) +
        '&user_id=not.is.null' +
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
      referrer = Array.isArray(referrerRows) && referrerRows[0];
      if (!referrer) {
        return json(404, { error: 'Share link not recognized' });
      }
    }

    const designerUserId = referrer.created_by;

    // ─── 3. Look up designer profile (for email + display name) ─────────
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

    // ─── 4. Normalize address → initial password ────────────────────────
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
        created_by: designerUserId,
        referred_by: referrer.id,
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
      // Best-effort rollback of orphan auth user
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

    // ─── 7. Update existing referral OR insert new one (path-dependent) ─
    if (referral) {
      // Token path: update the row that already exists
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
    } else {
      // Code path: create a fresh referrals row, already linked to the
      // newly-created homeowner. status='sent' so the dashboard pipeline
      // looks identical to a token-flow referral; the friend never sees an
      // invite email because they si
