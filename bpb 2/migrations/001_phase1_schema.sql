-- ═══════════════════════════════════════════════════════════════════════════
-- Bayside Proposal Builder — Phase 1 schema migration
-- ═══════════════════════════════════════════════════════════════════════════
-- Extends the four existing (empty) tables, adds two new tables, seeds the
-- first third-party materials. Idempotent: safe to re-run. Run once in the
-- Supabase SQL Editor, bayside-pavers project.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- proposals — add all columns the editor needs
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS client_email text,
  ADD COLUMN IF NOT EXISTS client_phone text,
  ADD COLUMN IF NOT EXISTS project_address text,
  ADD COLUMN IF NOT EXISTS project_city text,
  ADD COLUMN IF NOT EXISTS project_state text DEFAULT 'CA',
  ADD COLUMN IF NOT EXISTS project_zip text,
  ADD COLUMN IF NOT EXISTS proposal_type text,
  ADD COLUMN IF NOT EXISTS bid_total_amount numeric(12, 2),
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS bayside_estimate_number text,
  ADD COLUMN IF NOT EXISTS loom_video_url text,
  ADD COLUMN IF NOT EXISTS raw_bid_pdf_url text,
  ADD COLUMN IF NOT EXISTS generated_pdf_url text,
  ADD COLUMN IF NOT EXISTS generated_html_slug text,
  ADD COLUMN IF NOT EXISTS parsed_bid_data jsonb,
  ADD COLUMN IF NOT EXISTS last_edited_by text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposals_type_check') THEN
    ALTER TABLE proposals ADD CONSTRAINT proposals_type_check
      CHECK (proposal_type IS NULL OR proposal_type IN ('bid', 'design_retainer', 'preview'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposals_status_check') THEN
    ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
      CHECK (status IN ('draft', 'sent', 'signed', 'completed', 'archived'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_updated_at ON proposals(updated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- proposal_sections — add description, line items, subtotal
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE proposal_sections
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS line_items jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS subtotal numeric(12, 2);

-- ───────────────────────────────────────────────────────────────────────────
-- proposal_materials — discriminated junction (belgard OR third_party)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE proposal_materials
  ADD COLUMN IF NOT EXISTS material_source text NOT NULL DEFAULT 'belgard',
  ADD COLUMN IF NOT EXISTS belgard_material_id uuid,
  ADD COLUMN IF NOT EXISTS third_party_material_id uuid,
  ADD COLUMN IF NOT EXISTS display_order int,
  ADD COLUMN IF NOT EXISTS application_area text,
  ADD COLUMN IF NOT EXISTS custom_notes text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_materials_source_check') THEN
    ALTER TABLE proposal_materials ADD CONSTRAINT proposal_materials_source_check
      CHECK (material_source IN ('belgard', 'third_party'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_belgard_material') THEN
    ALTER TABLE proposal_materials ADD CONSTRAINT fk_belgard_material
      FOREIGN KEY (belgard_material_id) REFERENCES belgard_materials(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- proposal_images — type classification and display metadata
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE proposal_images
  ADD COLUMN IF NOT EXISTS image_type text,
  ADD COLUMN IF NOT EXISTS display_order int,
  ADD COLUMN IF NOT EXISTS caption text,
  ADD COLUMN IF NOT EXISTS is_wide boolean DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_images_type_check') THEN
    ALTER TABLE proposal_images ADD CONSTRAINT proposal_images_type_check
      CHECK (image_type IS NULL OR image_type IN (
        'hero', 'aerial', 'property_condition', 'render_3d', 'material_swatch', 'site_plan_source'
      ));
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- New table: third_party_materials (Trex, Tru-Scapes, etc.)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS third_party_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer text NOT NULL,
  category text NOT NULL CHECK (category IN ('decking', 'lighting', 'fencing', 'furniture', 'other')),
  product_name text NOT NULL,
  color text,
  description text,
  image_url text,
  catalog_url text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_third_party_manufacturer ON third_party_materials(manufacturer);
CREATE INDEX IF NOT EXISTS idx_third_party_category ON third_party_materials(category);
CREATE UNIQUE INDEX IF NOT EXISTS third_party_mfr_product_unique ON third_party_materials(manufacturer, product_name);

-- Now add the cross-table FK on proposal_materials
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_third_party_material') THEN
    ALTER TABLE proposal_materials ADD CONSTRAINT fk_third_party_material
      FOREIGN KEY (third_party_material_id) REFERENCES third_party_materials(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- New table: proposal_sitemaps (Cam To Plan extraction results)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proposal_sitemaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  label text,
  source_png_url text NOT NULL,
  extracted_json jsonb,
  svg_render text,
  perimeter_feet numeric(10, 2),
  area_sqft numeric(12, 2),
  confidence text CHECK (confidence IN ('high', 'medium', 'low')),
  extraction_notes text,
  human_verified boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sitemaps_proposal ON proposal_sitemaps(proposal_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Seed: third-party materials already in use on the Edgerton page
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO third_party_materials (manufacturer, category, product_name, description, catalog_url, image_url)
VALUES
  ('Trex', 'decking', 'Transcend Lineage',
   'Premium composite decking with enhanced grain and color variation.',
   'https://cdn.prod.website-files.com/65a1ca4354f63bd7376b5027/69da60945931b223dc5305d7_Trex%202025%20Catelog.pdf',
   'https://cdn.prod.website-files.com/65a1ca4354f63bd7376b5027/69d997f5039082c449c3e5bf_Screenshot%202026-04-10%20at%205.38.10%E2%80%AFPM.png'),
  ('Tru-Scapes', 'lighting', 'Low-Voltage Landscape Lighting',
   'Path, step, wall-cap, and spot fixtures. Weather-rated outdoor system integrated with paver and wall runs.',
   'https://cdn.prod.website-files.com/65a1ca4354f63bd7376b5027/69c359f91265ac278f2c281c_Tru-Scapes-2024_compressed.pdf',
   'https://cdn.prod.website-files.com/65a1ca4354f63bd7376b5027/69e6d3bbea9ff81f4c1a7d2d_Screenshot%202026-04-20%20at%206.32.40%E2%80%AFPM.png')
ON CONFLICT (manufacturer, product_name) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- updated_at trigger for proposals (auto-touch on any UPDATE)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS proposals_touch ON proposals;
CREATE TRIGGER proposals_touch BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  (SELECT COUNT(*) FROM proposals)              AS proposals,
  (SELECT COUNT(*) FROM proposal_sections)      AS sections,
  (SELECT COUNT(*) FROM proposal_materials)     AS materials_junction,
  (SELECT COUNT(*) FROM proposal_images)        AS images,
  (SELECT COUNT(*) FROM third_party_materials)  AS third_party,
  (SELECT COUNT(*) FROM proposal_sitemaps)      AS sitemaps;
-- Expected after first run: third_party=2, everything else=0.
