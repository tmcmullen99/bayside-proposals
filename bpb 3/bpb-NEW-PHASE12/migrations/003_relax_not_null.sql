-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1.1 — Relax legacy NOT NULL constraints on proposals
--
-- The proposals table pre-dates the Proposal Builder and was created by an
-- earlier tool (BP Design Proposals) with address and city marked NOT NULL.
-- The Proposal Builder creates draft rows before those fields are known,
-- so the constraints block INSERT.
--
-- Dropping NOT NULL is safe — the old tool still works (it always provided
-- values) and the new tool can now create blank drafts.
--
-- Future cleanup: consolidate the legacy (address, city, state, zip) columns
-- with the newer (project_address, project_city, project_state, project_zip)
-- columns. Defer until both tools can be updated simultaneously.
--
-- Idempotent: ALTER COLUMN DROP NOT NULL is a no-op if already nullable.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE proposals ALTER COLUMN address DROP NOT NULL;
ALTER TABLE proposals ALTER COLUMN city DROP NOT NULL;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification — both columns should now show is_nullable = 'YES'
-- ═══════════════════════════════════════════════════════════════════════════
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'proposals'
  AND column_name IN ('address', 'city', 'state', 'zip',
                       'project_address', 'project_city', 'project_state', 'project_zip')
ORDER BY column_name;
