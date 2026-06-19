// ═══════════════════════════════════════════════════════════════════════════
// Public Supabase configuration.
// The anon key is designed to be exposed to the frontend — Row Level Security
// policies govern what it can actually do. Service role key stays server-side
// only (in CF Pages Functions via env vars).
// ═══════════════════════════════════════════════════════════════════════════

export const config = {
  SUPABASE_URL: 'https://gfgbypcnxkschnfsitfb.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Ko4LNw2VjhZVFmwJ-i2qtA_XeGgBcew'
};
