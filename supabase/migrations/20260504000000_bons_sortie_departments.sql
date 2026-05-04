-- 20260504000000_bons_sortie_departments.sql
-- Bons de sortie par département.
-- Spec: docs/superpowers/specs/2026-05-04-bons-sortie-departments-design.md
-- Plan: docs/superpowers/plans/2026-05-04-bons-sortie-departments.md
--
-- Migrates flat material_dispatches (pre-wipe shape) → header (bons_sortie) +
-- lines (bons_sortie_lines). Adds m:n article ↔ department tagging with a
-- max-3-per-article trigger. Auto-tags every elec article from past
-- dispatches.
--
-- Pre-flight on 2026-05-04: material_dispatches is empty (round-3 wipe), so
-- the data-move steps are no-ops. Schema migration still runs cleanly.

BEGIN;

-- ============================================================================
-- 1. Schema
-- ============================================================================

-- 1.1 departments
CREATE TABLE departments (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  icon        TEXT,
  color       TEXT DEFAULT '#94a3b8',
  position    INT DEFAULT 0,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_all_departments ON departments FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO departments (id, code, name, icon, color, position)
VALUES (1, 'elec', '⚡ الكهرباء', '⚡', '#fbbf24', 1);

SELECT setval('departments_id_seq', GREATEST((SELECT MAX(id) FROM departments), 1));

-- 1.2 article_departments (m:n)
CREATE TABLE article_departments (
  article_id     BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  department_id  BIGINT NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (article_id, department_id)
);

CREATE INDEX idx_article_departments_dept ON article_departments(department_id);

ALTER TABLE article_departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_all_article_departments ON article_departments FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION enforce_max_3_departments_per_article()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM article_departments WHERE article_id = NEW.article_id) >= 3 THEN
    RAISE EXCEPTION 'Article % already has 3 departments (max)', NEW.article_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_max_3_departments
BEFORE INSERT ON article_departments
FOR EACH ROW EXECUTE FUNCTION enforce_max_3_departments_per_article();

-- 1.3 bons_sortie + lines
CREATE TABLE bons_sortie (
  id             BIGSERIAL PRIMARY KEY,
  bon_number     TEXT UNIQUE NOT NULL,
  department_id  BIGINT NOT NULL REFERENCES departments(id),
  date           DATE NOT NULL DEFAULT CURRENT_DATE,
  destination    TEXT,
  notes          TEXT,
  created_by     UUID REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bons_sortie_department_date ON bons_sortie(department_id, date DESC);

CREATE TABLE bons_sortie_lines (
  id             BIGSERIAL PRIMARY KEY,
  bon_id         BIGINT NOT NULL REFERENCES bons_sortie(id) ON DELETE CASCADE,
  article_id     BIGINT NOT NULL REFERENCES articles(id),
  qty            NUMERIC NOT NULL CHECK (qty > 0),
  snapshot_name  TEXT,
  position       INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bons_sortie_lines_bon_id ON bons_sortie_lines(bon_id);
CREATE INDEX idx_bons_sortie_lines_article_id ON bons_sortie_lines(article_id);

ALTER TABLE bons_sortie ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_all_bons_sortie ON bons_sortie FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE bons_sortie_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_all_bons_sortie_lines ON bons_sortie_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================================
-- 2. RPCs (atomic save / update / delete)
-- ============================================================================

-- 2.1 Save: insert header + lines + decrement stock atomically
CREATE OR REPLACE FUNCTION public.bons_sortie_save(
  p_bon JSONB,
  p_lines JSONB
) RETURNS BIGINT AS $$
DECLARE
  v_bon_id    BIGINT;
  v_line      JSONB;
  v_dept_id   BIGINT;
  v_avail     NUMERIC;
BEGIN
  v_dept_id := (p_bon->>'department_id')::BIGINT;

  INSERT INTO bons_sortie (bon_number, department_id, date, destination, notes, created_by)
  VALUES (
    p_bon->>'bon_number',
    v_dept_id,
    COALESCE((p_bon->>'date')::DATE, CURRENT_DATE),
    NULLIF(p_bon->>'destination', ''),
    NULLIF(p_bon->>'notes', ''),
    auth.uid()
  )
  RETURNING id INTO v_bon_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM article_departments
      WHERE article_id = (v_line->>'article_id')::BIGINT AND department_id = v_dept_id
    ) THEN
      RAISE EXCEPTION 'Article % is not tagged for department %', v_line->>'article_id', v_dept_id;
    END IF;

    SELECT stock INTO v_avail FROM articles WHERE id = (v_line->>'article_id')::BIGINT FOR UPDATE;
    IF v_avail < (v_line->>'qty')::NUMERIC THEN
      RAISE EXCEPTION 'Insufficient stock for article %: avail=% qty=%', v_line->>'article_id', v_avail, v_line->>'qty';
    END IF;

    UPDATE articles SET stock = stock - (v_line->>'qty')::NUMERIC WHERE id = (v_line->>'article_id')::BIGINT;

    INSERT INTO bons_sortie_lines (bon_id, article_id, qty, snapshot_name, position)
    SELECT v_bon_id,
           (v_line->>'article_id')::BIGINT,
           (v_line->>'qty')::NUMERIC,
           a.nom,
           COALESCE((v_line->>'position')::INT, 0)
    FROM articles a WHERE a.id = (v_line->>'article_id')::BIGINT;
  END LOOP;

  RETURN v_bon_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.bons_sortie_save(JSONB, JSONB) TO authenticated;

-- 2.2 Update: restore old line stock, replace lines, re-decrement
CREATE OR REPLACE FUNCTION public.bons_sortie_update(
  p_bon_id BIGINT,
  p_bon JSONB,
  p_lines JSONB
) RETURNS BIGINT AS $$
DECLARE
  v_old_line  RECORD;
  v_new_line  JSONB;
  v_dept_id   BIGINT;
  v_avail     NUMERIC;
BEGIN
  v_dept_id := (SELECT department_id FROM bons_sortie WHERE id = p_bon_id);
  IF v_dept_id IS NULL THEN
    RAISE EXCEPTION 'BS % not found', p_bon_id;
  END IF;

  FOR v_old_line IN SELECT article_id, qty FROM bons_sortie_lines WHERE bon_id = p_bon_id LOOP
    UPDATE articles SET stock = stock + v_old_line.qty WHERE id = v_old_line.article_id;
  END LOOP;

  DELETE FROM bons_sortie_lines WHERE bon_id = p_bon_id;

  UPDATE bons_sortie SET
    date        = COALESCE((p_bon->>'date')::DATE, date),
    destination = NULLIF(p_bon->>'destination', ''),
    notes       = NULLIF(p_bon->>'notes', ''),
    updated_at  = NOW()
  WHERE id = p_bon_id;

  FOR v_new_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM article_departments
      WHERE article_id = (v_new_line->>'article_id')::BIGINT AND department_id = v_dept_id
    ) THEN
      RAISE EXCEPTION 'Article % is not tagged for department %', v_new_line->>'article_id', v_dept_id;
    END IF;

    SELECT stock INTO v_avail FROM articles WHERE id = (v_new_line->>'article_id')::BIGINT FOR UPDATE;
    IF v_avail < (v_new_line->>'qty')::NUMERIC THEN
      RAISE EXCEPTION 'Insufficient stock for article %: avail=% qty=%', v_new_line->>'article_id', v_avail, v_new_line->>'qty';
    END IF;

    UPDATE articles SET stock = stock - (v_new_line->>'qty')::NUMERIC WHERE id = (v_new_line->>'article_id')::BIGINT;

    INSERT INTO bons_sortie_lines (bon_id, article_id, qty, snapshot_name, position)
    SELECT p_bon_id,
           (v_new_line->>'article_id')::BIGINT,
           (v_new_line->>'qty')::NUMERIC,
           a.nom,
           COALESCE((v_new_line->>'position')::INT, 0)
    FROM articles a WHERE a.id = (v_new_line->>'article_id')::BIGINT;
  END LOOP;

  RETURN p_bon_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.bons_sortie_update(BIGINT, JSONB, JSONB) TO authenticated;

-- 2.3 Delete: restore stock, cascade lines
CREATE OR REPLACE FUNCTION public.bons_sortie_delete(p_bon_id BIGINT)
RETURNS VOID AS $$
DECLARE
  v_line RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bons_sortie WHERE id = p_bon_id) THEN
    RAISE EXCEPTION 'BS % not found', p_bon_id;
  END IF;

  FOR v_line IN SELECT article_id, qty FROM bons_sortie_lines WHERE bon_id = p_bon_id LOOP
    UPDATE articles SET stock = stock + v_line.qty WHERE id = v_line.article_id;
  END LOOP;

  DELETE FROM bons_sortie WHERE id = p_bon_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.bons_sortie_delete(BIGINT) TO authenticated;

-- ============================================================================
-- 3. Data migration: material_dispatches → bons_sortie + bons_sortie_lines
-- ============================================================================

-- 3.1 One bons_sortie header per distinct bon_number (no-op if table empty)
INSERT INTO bons_sortie (bon_number, department_id, date, destination, notes, created_by, created_at)
SELECT
  CASE
    WHEN bon_number IS NULL THEN 'BS-ELEC-LEGACY-' || MIN(id)::TEXT
    WHEN bon_number LIKE 'BS-%' THEN 'BS-ELEC-' || SUBSTRING(bon_number FROM 4)
    ELSE 'BS-ELEC-' || bon_number
  END AS new_bon_number,
  1 AS department_id,
  MIN(created_at)::DATE AS date,
  CASE
    WHEN MAX(technician_name) IS NULL OR MAX(technician_name) = '' THEN NULL
    ELSE 'Tech: ' || MAX(technician_name)
  END AS destination,
  NULL AS notes,
  NULL AS created_by,
  MIN(created_at) AS created_at
FROM material_dispatches
GROUP BY bon_number;

-- 3.2 Lines, FK'd to matching header
INSERT INTO bons_sortie_lines (bon_id, article_id, qty, snapshot_name, position, created_at)
SELECT
  bs.id AS bon_id,
  md.article_id,
  md.quantity AS qty,
  a.nom AS snapshot_name,
  ROW_NUMBER() OVER (PARTITION BY md.bon_number ORDER BY md.id) - 1 AS position,
  md.created_at
FROM material_dispatches md
JOIN articles a ON a.id = md.article_id
JOIN bons_sortie bs ON bs.bon_number = (
  CASE
    WHEN md.bon_number IS NULL THEN 'BS-ELEC-LEGACY-' || md.id::TEXT
    WHEN md.bon_number LIKE 'BS-%' THEN 'BS-ELEC-' || SUBSTRING(md.bon_number FROM 4)
    ELSE 'BS-ELEC-' || md.bon_number
  END
);

-- 3.3 Auto-tag every elec article (no-op if no past dispatches)
INSERT INTO article_departments (article_id, department_id)
SELECT DISTINCT article_id, 1 FROM material_dispatches
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 4. Archive (manual DROP later)
-- ============================================================================

ALTER TABLE material_dispatches RENAME TO material_dispatches_archive_2026_05;

COMMIT;
