// ═══════════════════════════════════════════════════════════════════════════
// /api/invite-designer  —  Phase 2C
//
// Master-only endpoint. Invites a new team member by:
//   1. Verifying the caller's JWT corresponds to an active master profile.
//   2. Calling Supabase auth.admin invite API (sends magic-link email).
//   3. UPSERTing the profile row to set the requested role + display_name.
//      (A trigger on auth.users insert auto-creates a default 'designer'
//      profile; this UPSERT promotes it to whatever role the master picked.)
//
// The browser side (team-modal.js) sends:
//   POST /api/invite-designer
//   Authorization: Bearer <user_access_token>
//   { email, display_name, role }
//
// Returns:
//   200  { ok: true, user_id, email, display_name, role }
//   400  { error: "..." }   bad input
//   401  { error: "..." }   missing/invalid auth token
//   403  { error: "..." }   caller is not master
//   207  { error, user_id } invite sent but profile UPSERT failed
//   500  { error: "..." }   unexpected server error
// ═══════════════════════════════════════════════════════════════════════════

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL = env.SUPABASE_URL;
    const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { error: 'Server not configured (missing Supabase env vars)' });
    }

    // ─── 1. Verify caller's JWT ──────────────────────────────────────────
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json(401, { error: 'Missing auth token' });

    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'apikey': SERVICE_ROLE,
      },
    });
    if (!userResp.ok) return json(401, { error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) {
      return json(401, { error: 'Invalid auth token (no user)' });
    }

    // ─── 2. Confirm caller is an active master ────────────────────────────
    const profileResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(callerUser.id) +
      '&select=role,is_active',
      {
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
        },
      }
    );
    if (!profileResp.ok) {
      return json(403, { error: 'Could not look up caller profile' });
    }
    const profiles = await profileResp.json();
    const callerProfile = Array.isArray(profiles) && profiles[0];
    if (!callerProfile || callerProfile.role !== 'master' || !callerProfile.is_active) {
      return json(403, { error: 'Master access required' });
    }

    // ─── 3. Validate input ────────────────────────────────────────────────
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { error: 'Invalid JSON body' });
    }

    const email = String(body.email || '').trim().toLowerCase();
    const display_name = String(body.display_name || '').trim();
    const role = String(body.role || 'designer');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(400, { error: 'Invalid email address' });
    }
    if (!display_name) {
      return json(400, { error: 'Display name is required' });
    }
    if (display_name.length > 80) {
      return json(400, { error: 'Display name too long (max 80 chars)' });
    }
    if (role !== 'designer' && role !== 'master') {
      return json(400, { error: "Role must be 'designer' or 'master'" });
    }

    // ─── 4. Send invite via Supabase admin API ────────────────────────────
    const origin = new URL(request.url).origin;
    const inviteResp = await fetch(SUPABASE_URL + '/auth/v1/invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE,
        'Authorization': 'Bearer ' + SERVICE_ROLE,
      },
      body: JSON.stringify({
        email,
        // display_name goes into raw_user_meta_data; the auth.users insert
        // trigger picks it up to seed the auto-created profile.
        data: { display_name },
        // After clicking the invite link, user lands on /login.html with
        // type=invite in the URL hash; our login.html detects this and
        // shows the "set password" UI.
        redirect_to: origin + '/login.html',
      }),
    });

    if (!inviteResp.ok) {
      const errText = await inviteResp.text();
      // Common case: email already exists. Surface that cleanly.
      if (inviteResp.status === 422 || /already.*registered/i.test(errText) || /already.*exists/i.test(errText)) {
        return json(409, { error: 'A user with that email already exists' });
      }
      return json(502, { error: 'Invite API error: ' + errText.slice(0, 240) });
    }

    const inviteData = await inviteResp.json();
    const newUserId = inviteData.id || (inviteData.user && inviteData.user.id);
    if (!newUserId) {
      return json(502, { error: 'Invite API returned no user id' });
    }

    // ─── 5. UPSERT profile to set role + display_name ─────────────────────
    // The handle_new_user trigger has already created a 'designer' row.
    // For designer invites this UPSERT is effectively a no-op; for master
    // invites it promotes the role.
    const upsertResp = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?on_conflict=id',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          id: newUserId,
          email,
          display_name,
          role,
          is_active: true,
        }),
      }
    );

    if (!upsertResp.ok) {
      const errText = await upsertResp.text();
      // Invite was sent but profile finalization failed — return 207 so the
      // UI can surface "user invited, but their role may need fixing".
      return new Response(JSON.stringify({
        error: 'Invite sent but profile setup failed: ' + errText.slice(0, 240),
        user_id: newUserId,
      }), { status: 207, headers: { 'Content-Type': 'application/json' } });
    }

    return json(200, {
      ok: true,
      user_id: newUserId,
      email,
      display_name,
      role,
    });

  } catch (err) {
    return json(500, { error: (err && err.message) || 'Unexpected server error' });
  }
}
