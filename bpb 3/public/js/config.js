// ═══════════════════════════════════════════════════════════════════════════
// Public Supabase configuration.
// The anon key is designed to be exposed to the frontend — Row Level Security
// policies govern what it can actually do. Service role key stays server-side
// only (in CF Pages Functions via env vars).
// ═══════════════════════════════════════════════════════════════════════════

export const config = {
  SUPABASE_URL: 'https://gfgbypcnxkschnfsitfb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmZ2J5cGNueGtzY2huZnNpdGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MTkzMTUsImV4cCI6MjA5MjI5NTMxNX0.EAwmiNR5OWcaI8Sr36MVn7FuMhYoZvfngse7y0ZOgvA'
};
