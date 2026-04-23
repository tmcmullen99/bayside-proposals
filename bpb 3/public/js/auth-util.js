// ═══════════════════════════════════════════════════════════════════════════
// auth-util.js
// Shared authentication helpers for BPB admin + Bayside client platform.
//
// Core functions:
//   getCurrentUser()          → current authenticated user (or null)
//   isAdminUser(user)         → true if user is Tim
//   requireAdmin()            → redirects to login if not authenticated, or
//                               to home if authenticated but not admin
//   requireClient()           → redirects to /client/login if not authenticated
//   sendMagicLink(email, ret) → triggers Supabase magic-link email
//   signOut()                 → clears session, redirects home
//   getClientRecord(user)     → loads the clients row for a logged-in client
//   linkClientOnFirstLogin(u) → on first login, writes auth.uid() into the
//                               pre-existing clients row so future queries
//                               work under RLS
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '/js/supabase-client.js';

const ADMIN_EMAIL = 'tim@mcmullen.properties';

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getCurrentSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export function isAdminUser(user) {
  return user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

/**
 * Guards admin routes. Redirects to /client/login if unauthenticated.
 * If authenticated but not admin, alerts and redirects home.
 * Returns the user object on success, null on failure (after triggering redirect).
 */
export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) {
    const ret = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/client/login.html?admin=1&return=${ret}`;
    return null;
  }
  if (!isAdminUser(user)) {
    alert('Admin access required. Signing you out.');
    await supabase.auth.signOut();
    window.location.href = '/';
    return null;
  }
  return user;
}

/**
 * Guards client routes. Redirects to login if unauthenticated.
 * Unlike requireAdmin, does not reject admins — Tim can preview client pages.
 */
export async function requireClient() {
  const user = await getCurrentUser();
  if (!user) {
    const ret = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/client/login.html?return=${ret}`;
    return null;
  }
  // Link on first login in case we haven't yet
  if (!isAdminUser(user)) {
    await linkClientOnFirstLogin(user);
  }
  return user;
}

/**
 * Sends a magic-link email via Supabase Auth (routed through Resend SMTP
 * if configured at the Supabase project level).
 *
 * @param email       {string} recipient
 * @param redirectPath {string} path the user lands on after clicking the link
 *                              e.g. '/client/dashboard.html' or '/admin/clients.html'
 */
export async function sendMagicLink(email, redirectPath = '/client/dashboard.html') {
  const redirectTo = `${window.location.origin}${redirectPath}`;
  const { data, error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: true,
    },
  });
  return { data, error };
}

/**
 * Signs out the current user and redirects to home.
 */
export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/';
}

/**
 * Loads the client record for the currently authenticated user (by user_id).
 * Returns null if no client record exists for this auth user.
 */
export async function getClientRecord(user) {
  if (!user) return null;
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    console.error('Error loading client record:', error);
    return null;
  }
  return data;
}

/**
 * On a client's first login, their new auth.users.id needs to be written
 * into the clients row that was pre-created by Tim. The RLS policy
 * "Clients link on first login" allows this specific update when:
 *   (1) clients.user_id IS NULL
 *   (2) clients.email matches the authenticated user's email
 *
 * Safe to call on every page load — it's a no-op if user_id is already set
 * or if no clients row exists for this email.
 */
export async function linkClientOnFirstLogin(user) {
  if (!user?.email) return;

  // First check if there's a clients row matching this user's email
  // with a null user_id. We can't SELECT clients where email=X directly
  // (RLS blocks it) unless we're the matching email, so we try the update
  // and let RLS filter.
  const { error } = await supabase
    .from('clients')
    .update({ user_id: user.id })
    .eq('email', user.email.toLowerCase())
    .is('user_id', null);

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows matched (expected for admin users or re-logins)
    console.warn('linkClientOnFirstLogin:', error.message);
  }
}

/**
 * Logs an activity event. Safe to call without awaiting.
 */
export async function logClientActivity(clientId, eventType, metadata = {}, proposalId = null) {
  if (!clientId) return;
  const { error } = await supabase
    .from('client_activity')
    .insert({
      client_id: clientId,
      proposal_id: proposalId,
      event_type: eventType,
      metadata,
    });
  if (error) console.warn('logClientActivity:', error.message);
}
