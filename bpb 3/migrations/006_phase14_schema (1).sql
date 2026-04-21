-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1.4 — Schema for versioned published proposals
--
-- Each click of "Publish" creates a NEW row in published_proposals with a
-- unique slug and a full html_snapshot. Old published versions stay live
-- forever at their original URL — nothing is ever overwritten.
--
-- The CF Pages Function at /p/[slug].js looks up the slug here and serves
-- the html_snapshot directly — no client-side JS on the public page.
--
-- Also adds `loom_url` to proposals (wired into the rendered template hero).
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── published_proposals ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS published_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  html_snapshot text NOT NULL,
  title text,
  project_address text,
  total_amount numeric,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS published_proposals_proposal_id_idx
  ON published_proposals(proposal_id);

CREATE INDEX IF NOT EXISTS published_proposals_published_at_idx
  ON published_proposals(published_at DESC);

-- ─── RLS — permissive single-user dev policy (matches proposal_* tables) ───
ALTER TABLE published_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dev_all_published_proposals ON published_proposals;
CREATE POLICY dev_all_published_proposals ON published_proposals
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

-- ─── proposals.loom_url ─────────────────────────────────────────────────────
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS loom_url text;

COMMIT;

-- ─── Verification ───────────────────────────────────────────────────────────
SELECT 'published_proposals' AS tbl, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'published_proposals'
UNION ALL
SELECT 'proposals' AS tbl, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'proposals'
  AND column_name = 'loom_url'
ORDER BY tbl, column_name;
