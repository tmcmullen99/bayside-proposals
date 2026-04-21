-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1.1 — Row Level Security policies for single-user internal mode.
--
-- The anon key needs INSERT/SELECT/UPDATE/DELETE on the proposal-related
-- tables, and SELECT on the catalog tables. This migration enables RLS on
-- each table and adds permissive policies that allow the anon role to do
-- everything the tool needs.
--
-- When this tool ever goes multi-user, replace these "dev_*" policies with
-- real per-user auth rules. For now the security model is "anyone with the
-- pages.dev URL and the anon key can do anything" — appropriate for a Tim-
-- only tool inside a private Cloudflare Pages project.
--
-- Idempotent: safe to re-run. Uses DROP POLICY IF EXISTS before CREATE.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Proposals + all child tables — full read/write for anon
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_all_proposals" ON proposals;
CREATE POLICY "dev_all_proposals" ON proposals
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE proposal_sections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_all_proposal_sections" ON proposal_sections;
CREATE POLICY "dev_all_proposal_sections" ON proposal_sections
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE proposal_materials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_all_proposal_materials" ON proposal_materials;
CREATE POLICY "dev_all_proposal_materials" ON proposal_materials
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE proposal_images ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_all_proposal_images" ON proposal_images;
CREATE POLICY "dev_all_proposal_images" ON proposal_images
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE proposal_sitemaps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_all_proposal_sitemaps" ON proposal_sitemaps;
CREATE POLICY "dev_all_proposal_sitemaps" ON proposal_sitemaps
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

-- ───────────────────────────────────────────────────────────────────────────
-- Third-party catalog — full read/write (the tool adds custom materials)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE third_party_materials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_all_third_party_materials" ON third_party_materials;
CREATE POLICY "dev_all_third_party_materials" ON third_party_materials
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

-- ───────────────────────────────────────────────────────────────────────────
-- Belgard catalog — read-only (seeded elsewhere, tool just queries)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE belgard_materials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_read_belgard_materials" ON belgard_materials;
CREATE POLICY "dev_read_belgard_materials" ON belgard_materials
  FOR SELECT TO anon, authenticated
  USING (true);

ALTER TABLE belgard_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_read_belgard_categories" ON belgard_categories;
CREATE POLICY "dev_read_belgard_categories" ON belgard_categories
  FOR SELECT TO anon, authenticated
  USING (true);

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification — should show 8 rows, one per table
-- ═══════════════════════════════════════════════════════════════════════════
SELECT tablename, policyname, cmd AS operation
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname LIKE 'dev_%'
ORDER BY tablename, policyname;
