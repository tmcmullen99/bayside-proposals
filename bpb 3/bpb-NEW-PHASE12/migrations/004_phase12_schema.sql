-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1.2 — Schema additions for bid PDF parser
--
-- Ensures the columns Phase 1.2 writes to actually exist. Uses
-- ADD COLUMN IF NOT EXISTS so it's safe to run even if Phase 1.0's migration
-- already added some of these (some were added, some may have been skipped
-- during the earlier folder-confusion phase).
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Proposals — client info, bid totals, raw parsed JSON for debugging
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_name text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_email text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_phone text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS project_address text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS project_city text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS project_state text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS project_zip text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS project_label text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS bayside_estimate_number text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS bid_subtotal numeric(10,2);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS bid_discount_amount numeric(10,2);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS bid_total_amount numeric(10,2);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS parsed_bid_data jsonb;

-- Proposal sections — structured scope from bid
ALTER TABLE proposal_sections ADD COLUMN IF NOT EXISTS section_type text DEFAULT 'bid_section';
ALTER TABLE proposal_sections ADD COLUMN IF NOT EXISTS total_amount numeric(10,2);
ALTER TABLE proposal_sections ADD COLUMN IF NOT EXISTS line_items jsonb;
ALTER TABLE proposal_sections ADD COLUMN IF NOT EXISTS display_order int DEFAULT 0;

COMMIT;

-- Verification — should show all 17 rows with is_nullable='YES'
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'proposals' AND column_name IN (
      'client_name','client_email','client_phone','project_address','project_city',
      'project_state','project_zip','project_label','bayside_estimate_number',
      'bid_subtotal','bid_discount_amount','bid_total_amount','parsed_bid_data'
    ))
    OR (table_name = 'proposal_sections' AND column_name IN (
      'section_type','total_amount','line_items','display_order'
    ))
  )
ORDER BY table_name, column_name;
