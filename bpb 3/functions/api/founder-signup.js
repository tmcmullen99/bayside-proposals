// ═══════════════════════════════════════════════════════════════════════════
// /api/founder-signup — invite-code signup, NO credit card.
//
// For the founding team (sales, testers): provisions a full workspace via
// provision_company() and immediately sets it ACTIVE (comped — no trial
// cap, no Stripe). Gated by an invite code so it can live in production
// without becoming a free-tier backdoor.
//
// POST { invite_code, company_name, owner_name, email, password }
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY),
//      FOUNDER_INVITE_CODE (optional; default below)
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CODE = 'FLETCH-FOUNDER-2026';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const svcKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.SUPABASE_URL || !svcKey(env)) return json({ error: 'Server misconfigured' }, 500);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

  const code = String(body.invite_code || '').trim();
  const expected = (env.FOUNDER_INVITE_CODE || DEFAULT_CODE).trim();
  if (!code || code.toUpperCase() !== expected.toUpperCase()) {
    return json({ error: 'That invite code is not valid.' }, 403);
  }

  const companyName = String(body.company_name || '').trim();
  const ownerName   = String(body.owner_name || '').trim();
  const email       = String(body.email || '').trim().toLowerCase();
  const password    = String(body.password || '');
  if (companyName.length < 2)  return json({ error: 'Workspace name is required.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid email is required.' }, 400);
  if (password.length < 8)     return json({ error: 'Password must be at least 8 characters.' }, 400);

  const headers = {
    apikey: svcKey(env),
    Authorization: `Bearer ${svcKey(env)}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  // unique slug
  let slug = slugify(companyName);
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/companies?slug=like.${encodeURIComponent(slug + '%')}&select=slug`, { headers });
    if (r.ok) {
      const taken = new Set((await r.json()).map(c => c.slug));
      if (taken.has(slug)) { let i = 2; while (taken.has(`${slug}-${i}`) && i < 100) i++; slug = `${slug}-${i}`; }
    }
  } catch (_) {}

  // create auth user
  let userId = null;
  {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST', headers,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: ownerName || null } }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (out && (out.msg || out.message || '')) + '';
      if (/already|exists|registered/i.test(msg)) {
        return json({ error: 'That email already has an account here — use a fresh email for your founder workspace.' }, 409);
      }
      console.error('founder-signup: createUser failed', r.status, msg);
      return json({ error: 'Could not create the account. Try again.' }, 502);
    }
    userId = out.id || (out.user && out.user.id);
    if (!userId) return json({ error: 'Could not create the account. Try again.' }, 502);
  }

  // provision + comp to active (full access, no trial cap)
  const rpc = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/provision_company`, {
    method: 'POST', headers,
    body: JSON.stringify({
      p_company_name: companyName, p_slug: slug, p_owner_user_id: userId,
      p_owner_email: email, p_owner_name: ownerName || null, p_plan: 'individual',
    }),
  });
  const companyId = await rpc.json().catch(() => null);
  if (!rpc.ok || !companyId || typeof companyId !== 'string') {
    console.error('founder-signup: provisioning failed', rpc.status, JSON.stringify(companyId));
    return json({ error: 'Could not provision the workspace. Try again.' }, 502);
  }
  await fetch(`${env.SUPABASE_URL}/rest/v1/companies?id=eq.${encodeURIComponent(companyId)}`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'active', plan: 'individual' }),
  });

  console.log('founder-signup: provisioned', companyId, 'for', email);
  return json({ ok: true });
}
