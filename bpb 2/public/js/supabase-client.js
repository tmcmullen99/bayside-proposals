// Supabase client — initialized once, imported by all pages that need DB access.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { config } from './config.js';

export const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false },
    db: { schema: 'public' }
  }
);
