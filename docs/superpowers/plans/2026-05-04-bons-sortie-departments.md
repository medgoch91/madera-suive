# Bons de sortie par département — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a department-scoped bon-de-sortie hub (`#sorties`) with article-tagging and a CRUD-managed department list, migrating the existing flat `material_dispatches` table into a header+lines model.

**Architecture:** New tables `departments`, `article_departments` (m:n, max 3), `bons_sortie`, `bons_sortie_lines` plus three RPCs (save/update/delete). One UI hub with dynamic per-dept tabs (matching the catalog hub pattern). Existing elec dispatches migrate transparently into the new model with `BS-ELEC-…` numbering.

**Tech Stack:** Single-file vanilla JS SPA (`index.html`), Supabase Postgres + RPCs + RLS, html2canvas for photo-share, Telegram Bot API for notifs. No client-side test framework — verification is manual smoke + SQL queries.

**Spec:** `docs/superpowers/specs/2026-05-04-bons-sortie-departments-design.md`

**Working dir:** `/Users/amine/Downloads/suivi-app` (production repo, daily-use app — commit per task, deploy per milestone).

---

## Table of contents

- Milestone 0: Pre-flight schema check
- Milestone 1: Database migration (single SQL file)
- Milestone 2: Client state + departments CRUD
- Milestone 3: Article tagging UI
- Milestone 4: Hub `#sorties` skeleton
- Milestone 5: BS creation flow
- Milestone 6: BS history + edit/delete/photo-share
- Milestone 7: Telegram notifs
- Milestone 8: Strip dispatches from `#elec-dist`
- Milestone 9: SW cache + smoke + deploy

---

# Milestone 0: Pre-flight schema check

Goal: confirm exact shape of `material_dispatches` before writing the migration. Already established from `index.html:13416`:

```js
var edDispatches=[];   // [{id, technician_name, article_id, quantity, bon_number, created_at}]
```

### Task 0.1: Confirm column types in Supabase

**Files:**
- Inspect: live Supabase project `tpjrzgubttpqtxieioxe`

- [ ] **Step 1: Connect to Supabase SQL editor and run**

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'material_dispatches'
ORDER BY ordinal_position;
```

Expected output: 6 rows: `id` (bigint), `technician_name` (text), `article_id` (bigint), `quantity` (numeric or int), `bon_number` (text, nullable), `created_at` (timestamptz).

- [ ] **Step 2: Confirm row count and bon_number distribution**

```sql
SELECT
  COUNT(*) AS total_rows,
  COUNT(DISTINCT bon_number) AS distinct_bons,
  COUNT(*) FILTER (WHERE bon_number IS NULL) AS null_bons,
  COUNT(DISTINCT article_id) AS distinct_articles
FROM material_dispatches;
```

Record these numbers — they are the truth-set for post-migration verification (Task 1.10).

- [ ] **Step 3: Snapshot the row counts in the plan**

Edit this file in-place under "Recorded baseline" below. No commit needed yet — these are notes for the migration verification.

#### Recorded baseline (fill in)

```
total_rows:        ____
distinct_bons:     ____
null_bons:         ____
distinct_articles: ____
```

---

# Milestone 1: Database migration (single SQL file)

Goal: ship one migration file that creates schema + RPCs + RLS + data move + verification, all in a single `BEGIN; … COMMIT;` block.

### Task 1.1: Create the migration file skeleton

**Files:**
- Create: `supabase/migrations/20260504000000_bons_sortie_departments.sql`

- [ ] **Step 1: Create file with header**

```sql
-- 20260504000000_bons_sortie_departments.sql
-- Bons de sortie par département — Spec: docs/superpowers/specs/2026-05-04-bons-sortie-departments-design.md
-- Migrates flat material_dispatches → header (bons_sortie) + lines (bons_sortie_lines).
-- Adds m:n article ↔ department tagging. Auto-tags elec articles from past dispatches.

BEGIN;

-- ============================================================================
-- 1. Schema
-- ============================================================================

-- (sections below filled in by subsequent tasks)

COMMIT;
```

- [ ] **Step 2: Commit the skeleton**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "wip(sortie): start bons_sortie migration skeleton"
```

### Task 1.2: Add `departments` table + seed elec

- [ ] **Step 1: Append to the migration file**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "feat(sortie): add departments table + seed elec"
```

### Task 1.3: Add `article_departments` join with max-3 trigger

- [ ] **Step 1: Append**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "feat(sortie): add article_departments m:n + max-3 trigger"
```

### Task 1.4: Add `bons_sortie` + `bons_sortie_lines`

- [ ] **Step 1: Append**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "feat(sortie): add bons_sortie + bons_sortie_lines tables"
```

### Task 1.5: Add `bons_sortie_save` RPC

- [ ] **Step 1: Append**

```sql
-- 1.4 RPC: atomic save (insert header + lines + decrement stock)
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "feat(sortie): bons_sortie_save RPC (atomic insert + stock decrement)"
```

### Task 1.6: Add `bons_sortie_update` RPC (delta stock)

- [ ] **Step 1: Append**

```sql
-- 1.5 RPC: atomic update (replace lines, apply stock delta)
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

  -- Restore stock from existing lines
  FOR v_old_line IN SELECT article_id, qty FROM bons_sortie_lines WHERE bon_id = p_bon_id LOOP
    UPDATE articles SET stock = stock + v_old_line.qty WHERE id = v_old_line.article_id;
  END LOOP;

  DELETE FROM bons_sortie_lines WHERE bon_id = p_bon_id;

  -- Update header (only mutable fields)
  UPDATE bons_sortie SET
    date        = COALESCE((p_bon->>'date')::DATE, date),
    destination = NULLIF(p_bon->>'destination', ''),
    notes       = NULLIF(p_bon->>'notes', ''),
    updated_at  = NOW()
  WHERE id = p_bon_id;

  -- Re-insert lines + re-decrement stock with same checks as save
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "feat(sortie): bons_sortie_update RPC (restore + re-apply with delta)"
```

### Task 1.7: Add `bons_sortie_delete` RPC

- [ ] **Step 1: Append**

```sql
-- 1.6 RPC: delete and restore stock
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "feat(sortie): bons_sortie_delete RPC (restore stock + cascade lines)"
```

### Task 1.8: Migrate existing `material_dispatches` data

- [ ] **Step 1: Append data-move SQL**

```sql
-- ============================================================================
-- 2. Data migration: material_dispatches → bons_sortie + bons_sortie_lines
-- ============================================================================

-- 2.1 Create one bons_sortie header per distinct bon_number
-- - bon_number rewritten to BS-ELEC-… preserving the date/seq portion when present
-- - rows with NULL bon_number get BS-ELEC-LEGACY-{md.id}
-- - destination preserves the legacy technician_name (Tech: <name>) so info isn't lost
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

-- 2.2 Create lines, FK'd to the matching bons_sortie row
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

-- 2.3 Auto-tag every elec article with department=1
INSERT INTO article_departments (article_id, department_id)
SELECT DISTINCT article_id, 1 FROM material_dispatches
ON CONFLICT DO NOTHING;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "feat(sortie): migrate material_dispatches into bons_sortie + auto-tag elec"
```

### Task 1.9: Archive old table + close transaction

- [ ] **Step 1: Append**

```sql
-- ============================================================================
-- 3. Archive (manual DROP after 2-4 weeks of stability)
-- ============================================================================

ALTER TABLE material_dispatches RENAME TO material_dispatches_archive_2026_05;

-- (no DROP — keep for safety; drop manually once verified stable)
```

Make sure the file ends with `COMMIT;` (already in the skeleton — verify).

- [ ] **Step 2: Verify the file looks complete**

```bash
tail -3 supabase/migrations/20260504000000_bons_sortie_departments.sql
```

Expected: last line is `COMMIT;`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260504000000_bons_sortie_departments.sql
git commit -m "feat(sortie): archive material_dispatches (rename, no drop)"
```

### Task 1.10: Apply migration + run verification queries

**Files:**
- Apply: `supabase/migrations/20260504000000_bons_sortie_departments.sql`

- [ ] **Step 1: Apply via Supabase SQL editor (paste entire file content, run)**

Expected: no error, transaction commits.

- [ ] **Step 2: Run row-count verification**

```sql
SELECT
  (SELECT COUNT(*) FROM material_dispatches_archive_2026_05) AS old_total_rows,
  (SELECT COUNT(DISTINCT bon_number) FROM material_dispatches_archive_2026_05) AS old_distinct_bons,
  (SELECT COUNT(*) FROM bons_sortie WHERE department_id = 1) AS new_headers,
  (SELECT COUNT(*) FROM bons_sortie_lines bsl JOIN bons_sortie bs ON bsl.bon_id = bs.id WHERE bs.department_id = 1) AS new_lines,
  (SELECT COUNT(DISTINCT article_id) FROM material_dispatches_archive_2026_05) AS old_distinct_articles,
  (SELECT COUNT(*) FROM article_departments WHERE department_id = 1) AS auto_tagged_articles;
```

Expected: `new_headers ≥ old_distinct_bons` (NULL bon_numbers split into individual headers); `new_lines = old_total_rows`; `auto_tagged_articles = old_distinct_articles`.

- [ ] **Step 3: Run sanity SELECT on a sample**

```sql
SELECT bs.bon_number, bs.date, bs.destination, COUNT(bsl.id) AS line_count
FROM bons_sortie bs
LEFT JOIN bons_sortie_lines bsl ON bsl.bon_id = bs.id
WHERE bs.department_id = 1
GROUP BY bs.id, bs.bon_number, bs.date, bs.destination
ORDER BY bs.created_at DESC
LIMIT 10;
```

Expected: rows show `BS-ELEC-…` numbering and reasonable line_counts.

- [ ] **Step 4: If anything is off, run the rollback in `spec §8.2` and investigate. Otherwise mark migration green and proceed to Milestone 2.**

---

# Milestone 2: Client state + departments CRUD

Goal: load the new tables on app boot, render a department CRUD modal, and let the user create/edit/archive/reorder departments.

### Task 2.1: Add client-side state arrays + loaders

**Files:**
- Modify: `index.html` near the existing `var edDispatches=[]` declaration (~line 13416) — add to the same state-declaration zone OR group with other top-level data caches (search for `var articles=[]`).

- [ ] **Step 1: Add state declarations**

Insert near the top of the data-state block (search the file for `var articles=` and place adjacent):

```js
// Bons de sortie par département (added 2026-05-04)
var departments=[];          // [{id, code, name, icon, color, position, active}]
var articleDepartments=[];   // [{article_id, department_id}]
var sortiesBons=[];          // [{id, bon_number, department_id, date, destination, notes, created_at}]
var sortiesLines=[];         // [{id, bon_id, article_id, qty, snapshot_name, position}]
```

- [ ] **Step 2: Add loaders inside the existing `loadAllData` (search for the function and append three awaits at the end)**

```js
// inside loadAllData, after existing loads:
try {
  var dRes = await sbFetch('departments','GET',null,'select=*&active=eq.true&order=position,id');
  if (Array.isArray(dRes)) departments = dRes;
} catch(e) { console.warn('[sortie] departments load failed', e); }

try {
  var adRes = await sbFetch('article_departments','GET',null,'select=article_id,department_id&limit=10000');
  if (Array.isArray(adRes)) articleDepartments = adRes;
} catch(e) { console.warn('[sortie] article_departments load failed', e); }

try {
  var bsRes = await sbFetch('bons_sortie','GET',null,'select=*&order=created_at.desc&limit=500');
  if (Array.isArray(bsRes)) sortiesBons = bsRes;
} catch(e) { console.warn('[sortie] bons_sortie load failed', e); }

try {
  var bslRes = await sbFetch('bons_sortie_lines','GET',null,'select=*&limit=10000');
  if (Array.isArray(bslRes)) sortiesLines = bslRes;
} catch(e) { console.warn('[sortie] bons_sortie_lines load failed', e); }
```

- [ ] **Step 3: Verify in browser console**

Hard-reload the app; in DevTools console run:

```js
console.log({deps:departments.length, ad:articleDepartments.length, bs:sortiesBons.length, bsl:sortiesLines.length});
```

Expected: `{deps: 1, ad: N, bs: M, bsl: K}` where N/M/K match the migration verification numbers.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(sortie): add client state + loaders for departments + bons_sortie"
```

### Task 2.2: Add departments CRUD modal HTML + render

**Files:**
- Modify: `index.html` — add a new modal block alongside other modal definitions (search for `id="modal-` to locate the modal zone).

- [ ] **Step 1: Add modal HTML**

```html
<div class="modal" id="modal-departments" style="display:none;" onclick="if(event.target===this)closeModalDepartments()">
  <div class="modal-box" style="max-width:720px;">
    <div class="modal-head">
      <h3>📤 إدارة الأقسام (Départements)</h3>
      <button class="btn-icon" onclick="closeModalDepartments()">✖️</button>
    </div>
    <div id="depts-modal-body"></div>
  </div>
</div>
```

- [ ] **Step 2: Add render functions in JS**

Append to the JS section (near `renderArticles`):

```js
function openDepartments(){
  var m=document.getElementById('modal-departments');
  if(!m)return;
  m.style.display='flex';
  renderDepartmentsModal('list');
}
function closeModalDepartments(){
  var m=document.getElementById('modal-departments');
  if(m)m.style.display='none';
}
function renderDepartmentsModal(mode, deptId){
  var body=document.getElementById('depts-modal-body');
  if(!body)return;
  if(mode==='list'){
    var rows=(departments||[]).slice().sort(function(a,b){return (a.position||0)-(b.position||0);}).map(function(d){
      var artCount=(articleDepartments||[]).filter(function(x){return x.department_id===d.id;}).length;
      var bsCount=(sortiesBons||[]).filter(function(x){return x.department_id===d.id;}).length;
      return '<tr>'+
        '<td>'+(d.icon||'')+'</td>'+
        '<td><b>'+escapeHtml(d.name)+'</b><br><small>'+escapeHtml(d.code)+'</small></td>'+
        '<td><span style="display:inline-block;width:18px;height:18px;border-radius:4px;background:'+(d.color||'#94a3b8')+'"></span></td>'+
        '<td>'+artCount+' سلعة</td>'+
        '<td>'+bsCount+' بون</td>'+
        '<td>'+
          '<button class="btn-icon" onclick="renderDepartmentsModal(\'edit\','+d.id+')">✏️</button>'+
          '<button class="btn-icon" onclick="archiveDepartment('+d.id+')">🗑️</button>'+
        '</td>'+
      '</tr>';
    }).join('');
    body.innerHTML =
      '<table class="data-table"><thead><tr><th></th><th>الإسم</th><th>اللون</th><th>السلع</th><th>البونات</th><th></th></tr></thead><tbody>'+
      (rows||'<tr><td colspan="6">ما كاين حتى قسم</td></tr>')+
      '</tbody></table>'+
      '<div style="margin-top:12px;text-align:center;">'+
        '<button class="btn-primary" onclick="renderDepartmentsModal(\'edit\',0)">➕ قسم جديد</button>'+
      '</div>';
  } else {
    var d=(departments||[]).find(function(x){return x.id===deptId;}) || {code:'',name:'',icon:'',color:'#94a3b8',position:(departments.length+1)};
    var isNew = !deptId;
    body.innerHTML =
      '<div style="display:grid;gap:10px;">'+
      '<label>Code <input id="dept-form-code" value="'+escapeHtml(d.code)+'" '+(isNew?'':'disabled')+' placeholder="elec, plom, peint…"></label>'+
      '<label>الإسم <input id="dept-form-name" value="'+escapeHtml(d.name)+'" placeholder="⚡ الكهرباء"></label>'+
      '<label>الأيقونة <input id="dept-form-icon" value="'+escapeHtml(d.icon||'')+'" maxlength="2"></label>'+
      '<label>اللون <input id="dept-form-color" type="color" value="'+(d.color||'#94a3b8')+'"></label>'+
      '<label>الترتيب <input id="dept-form-position" type="number" value="'+(d.position||0)+'"></label>'+
      '<div style="display:flex;gap:10px;justify-content:flex-end;">'+
        '<button class="btn-secondary" onclick="renderDepartmentsModal(\'list\')">⬅️ رجوع</button>'+
        '<button class="btn-primary" onclick="saveDepartment('+(deptId||0)+')">💾 حفظ</button>'+
      '</div></div>';
  }
}
```

- [ ] **Step 3: Verify modal opens**

Reload, open DevTools, run `openDepartments()`. Modal should show one row (Élec) and "➕ قسم جديد" button.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(sortie): departments CRUD modal (list + edit views)"
```

### Task 2.3: Wire save / archive department actions

- [ ] **Step 1: Add save + archive functions**

```js
async function saveDepartment(id){
  var code=document.getElementById('dept-form-code').value.trim().toLowerCase();
  var name=document.getElementById('dept-form-name').value.trim();
  var icon=document.getElementById('dept-form-icon').value.trim();
  var color=document.getElementById('dept-form-color').value;
  var position=Number(document.getElementById('dept-form-position').value)||0;

  if(!code || !name){ try{toast('⚠️ Code w الإسم خاص يكونو','warning');}catch(e){} return; }
  if(!/^[a-z0-9_-]+$/.test(code)){ try{toast('⚠️ Code: ghir [a-z0-9_-]','warning');}catch(e){} return; }

  try{
    if(id){
      var res=await sbFetch('departments?id=eq.'+id,'PATCH',{name:name,icon:icon,color:color,position:position});
      if(Array.isArray(res)&&res[0]) Object.assign((departments.find(function(x){return x.id===id;})||{}),res[0]);
    } else {
      var ins=await sbFetch('departments','POST',{code:code,name:name,icon:icon,color:color,position:position,active:true});
      if(Array.isArray(ins)&&ins[0]) departments.push(ins[0]);
    }
    try{toast('✅ تم الحفظ','success');}catch(e){}
    renderDepartmentsModal('list');
    if(typeof renderSorties==='function') renderSorties();
  }catch(e){
    try{toast('❌ '+(e.message||'فشل الحفظ'),'error');}catch(err){}
  }
}

async function archiveDepartment(id){
  if(id===1){ try{toast('⛔ ما يمكنش تأرشف Élec','warning');}catch(e){} return; }
  if(!confirm('Archiver had l-قسم؟ (l-البونات li 3ndo kayb9aw f l-history)')) return;
  try{
    var res=await sbFetch('departments?id=eq.'+id,'PATCH',{active:false});
    departments=departments.filter(function(x){return x.id!==id;});
    renderDepartmentsModal('list');
    if(typeof renderSorties==='function') renderSorties();
    try{toast('✅ تم الأرشفة','success');}catch(e){}
  }catch(e){
    try{toast('❌ فشل','error');}catch(err){}
  }
}
```

- [ ] **Step 2: Smoke test**

Reload, open `openDepartments()`, click ➕ قسم جديد, fill: code=`plom`, name=`🔧 السباكة`, icon=`🔧`, color=`#06b6d4`, position=`2`. Click 💾 حفظ. Verify row appears in list. Refresh page → `departments.length === 2`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(sortie): save/archive department actions wired to RLS-authenticated CRUD"
```

---

# Milestone 3: Article tagging UI

Goal: in the existing article modal, let the user tag the article with up to 3 departments via a multi-select chip control.

### Task 3.1: Add chip section in article modal

**Files:**
- Modify: `index.html` — find the article-edit modal render (search for `function renderArticleEdit` or similar — the modal triggered when user opens an article).

- [ ] **Step 1: Add a render helper**

```js
function _articleDeptChipsHTML(articleId){
  var ids=(articleDepartments||[]).filter(function(x){return x.article_id===articleId;}).map(function(x){return x.department_id;});
  var chips=ids.map(function(did){
    var d=(departments||[]).find(function(x){return x.id===did;});
    if(!d) return '';
    return '<span class="chip" style="background:'+(d.color||'#94a3b8')+'22;border-color:'+(d.color||'#94a3b8')+';">'+
      (d.icon||'')+' '+escapeHtml(d.name)+
      ' <button onclick="articleRemoveDept('+articleId+','+did+')">×</button>'+
      '</span>';
  }).join(' ');
  var canAdd=ids.length<3;
  var availableDepts=(departments||[]).filter(function(d){return ids.indexOf(d.id)<0;});
  var addControl=canAdd && availableDepts.length
    ? '<select onchange="if(this.value)articleAddDept('+articleId+',Number(this.value))"><option value="">+ ajouter</option>'+
      availableDepts.map(function(d){return '<option value="'+d.id+'">'+escapeHtml((d.icon||'')+' '+d.name)+'</option>';}).join('')+
      '</select>'
    : (ids.length>=3 ? '<small>Max 3 إدارات</small>' : '');
  return '<div class="dept-chips">'+
    '<label>📤 الإدارات</label>'+
    '<div class="chips-row">'+(chips||'<small>ما كاين حتى قسم</small>')+' '+addControl+'</div>'+
    '</div>';
}
```

- [ ] **Step 2: Inject into article modal render**

In the article edit modal HTML builder (find where `🏷️ الخصائص` is rendered), append after the existing fields:

```js
// inside the modal content build:
html += _articleDeptChipsHTML(article.id);
```

- [ ] **Step 3: Add styles** (search for `.chip {` — if missing, add to CSS)

```css
.dept-chips{margin-top:14px;}
.dept-chips label{display:block;margin-bottom:6px;font-weight:600;}
.chips-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.chip{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border);border-radius:999px;font-size:12px;}
.chip button{background:none;border:none;cursor:pointer;font-size:14px;line-height:1;color:inherit;}
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(sortie): article modal — multi-select chips for departments"
```

### Task 3.2: Wire add / remove dept actions on articles

- [ ] **Step 1: Add functions**

```js
async function articleAddDept(articleId, deptId){
  if(!articleId || !deptId) return;
  var existing=(articleDepartments||[]).filter(function(x){return x.article_id===articleId;}).length;
  if(existing>=3){ try{toast('⚠️ Max 3 إدارات','warning');}catch(e){} return; }
  try{
    await sbFetch('article_departments','POST',{article_id:articleId,department_id:deptId});
    articleDepartments.push({article_id:articleId,department_id:deptId});
    if(typeof refreshArticleModal==='function') refreshArticleModal(articleId);
    try{toast('✅ تم الإضافة','success');}catch(e){}
  }catch(e){
    try{toast('❌ '+(e.message||'فشل'),'error');}catch(err){}
  }
}
async function articleRemoveDept(articleId, deptId){
  try{
    await sbFetch('article_departments?article_id=eq.'+articleId+'&department_id=eq.'+deptId,'DELETE');
    articleDepartments=articleDepartments.filter(function(x){return !(x.article_id===articleId && x.department_id===deptId);});
    if(typeof refreshArticleModal==='function') refreshArticleModal(articleId);
    try{toast('✅ تم الحذف','success');}catch(e){}
  }catch(e){
    try{toast('❌ فشل','error');}catch(err){}
  }
}
```

If `refreshArticleModal` doesn't exist, replace those calls with the actual modal-rerender function used in the existing code.

- [ ] **Step 2: Smoke test**

Open any article modal, see the chips section. Add `🔧 السباكة`. Verify it persists across reload. Try to add a 4th — toast warns. Remove one — chip disappears.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(sortie): wire article ↔ department add/remove with max-3 enforcement"
```

---

# Milestone 4: Hub `#sorties` skeleton

Goal: add the sidebar entry, route, top tabs, and sub-tab navigation. No business logic yet — just the shell.

### Task 4.1: Add sidebar entry + route

**Files:**
- Modify: `index.html` — sidebar nav block (search for the `📦 فورنيسور و السلعة` entry to find the zone).

- [ ] **Step 1: Add sidebar entry**

```html
<a class="nav-item" data-route="sorties" onclick="goPage('sorties')">📤 الخوارج</a>
```

Place it right after the catalog hub entry.

- [ ] **Step 2: Register the page**

Find `pageTitles=` and add:

```js
'sorties':'📤 الخوارج',
```

Find `const renders={…}` and add:

```js
'sorties':renderSorties,
```

Find the page container block and add:

```html
<div class="page" id="page-sorties"></div>
```

- [ ] **Step 3: Stub `renderSorties`**

```js
var sortiesActiveDept=1;          // department_id of the active tab
var sortiesActiveSubtab='new';    // 'new' | 'history'

function renderSorties(){
  var page=document.getElementById('page-sorties');
  if(!page) return;
  page.innerHTML='<div class="page-head"><h1>📤 الخوارج</h1></div><div id="sorties-tabs"></div><div id="sorties-content"></div>';
  renderSortiesTabs();
  renderSortiesContent();
}
function renderSortiesTabs(){ /* in 4.2 */ }
function renderSortiesContent(){ /* in 4.3 */ }
```

- [ ] **Step 4: Smoke**

Reload, click sidebar entry, page should show "📤 الخوارج" header (empty body for now).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(sortie): #sorties hub route + sidebar entry stub"
```

### Task 4.2: Build dynamic top tabs from `departments[]`

- [ ] **Step 1: Implement `renderSortiesTabs`**

```js
function renderSortiesTabs(){
  var container=document.getElementById('sorties-tabs');
  if(!container) return;
  var depts=(departments||[]).slice().sort(function(a,b){return (a.position||0)-(b.position||0);});
  var tabs=depts.map(function(d){
    var active=d.id===sortiesActiveDept ? 'active' : '';
    return '<button class="tab-btn '+active+'" style="border-bottom-color:'+(d.color||'#94a3b8')+'" onclick="setSortiesDept('+d.id+')">'+
      (d.icon||'')+' '+escapeHtml(d.name)+
      '</button>';
  }).join('');
  var addBtn='<button class="tab-btn" onclick="openDepartments()">⚙️</button>';
  container.innerHTML='<div class="tabs-row">'+tabs+addBtn+'</div>';
}
function setSortiesDept(id){
  sortiesActiveDept=id;
  renderSortiesTabs();
  renderSortiesContent();
}
```

- [ ] **Step 2: Add CSS if missing**

```css
.tabs-row{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:12px 0;flex-wrap:wrap;}
.tab-btn{background:none;border:none;border-bottom:3px solid transparent;padding:10px 14px;cursor:pointer;font-weight:600;color:var(--text2);}
.tab-btn.active{color:var(--text);border-bottom-width:3px;}
```

- [ ] **Step 3: Smoke**

Reload, click `📤 الخوارج`. Tabs row should show `⚡ الكهرباء` (active) + `⚙️`. Add a new dept via the gear → tabs auto-rerender (call `renderSortiesTabs()` after `saveDepartment` — already wired via `renderSorties` call).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(sortie): dynamic department tabs in hub"
```

### Task 4.3: Sub-tabs (`بون جديد` / `السجل`)

- [ ] **Step 1: Implement `renderSortiesContent`**

```js
function renderSortiesContent(){
  var container=document.getElementById('sorties-content');
  if(!container) return;
  var subTabs=
    '<div class="tabs-row">'+
      '<button class="tab-btn '+(sortiesActiveSubtab==='new'?'active':'')+'" onclick="setSortiesSubtab(\'new\')">📋 بون جديد</button>'+
      '<button class="tab-btn '+(sortiesActiveSubtab==='history'?'active':'')+'" onclick="setSortiesSubtab(\'history\')">📜 السجل</button>'+
    '</div>';
  var content = sortiesActiveSubtab==='new' ? renderSortiesNewTab() : renderSortiesHistoryTab();
  container.innerHTML=subTabs+'<div class="sortie-pane">'+content+'</div>';
}
function setSortiesSubtab(s){ sortiesActiveSubtab=s; renderSortiesContent(); }
function renderSortiesNewTab(){ return '<p>📋 بون جديد placeholder (Milestone 5)</p>'; }
function renderSortiesHistoryTab(){ return '<p>📜 السجل placeholder (Milestone 6)</p>'; }
```

- [ ] **Step 2: Smoke**

Tabs switch between placeholders.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(sortie): sub-tabs (new/history) skeleton"
```

---

# Milestone 5: BS creation flow

Goal: rebuild the dispatch creation UX inside the new hub, scoped to the active dept and using the new RPC.

### Task 5.1: BS state + line management

- [ ] **Step 1: Add state**

```js
var bsoLines=[];          // [{articleId:0, qty:0}]
var bsoDestination='';
var bsoNotes='';
var bsoArtSearch='';
const BSO_MIN_ROWS = 4;

function bsoBlankLine(){ return {articleId:0, qty:0}; }
function bsoPadLines(){ while(bsoLines.length<BSO_MIN_ROWS) bsoLines.push(bsoBlankLine()); }
function bsoResetState(){ bsoLines=[]; bsoPadLines(); bsoDestination=''; bsoNotes=''; bsoArtSearch=''; }
```

Call `bsoResetState()` from `setSortiesSubtab('new')` and `setSortiesDept(...)` to reset between switches.

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(sortie): BS draft state + line padding"
```

### Task 5.2: Article picker filtered by current dept

- [ ] **Step 1: Helper**

```js
function bsoArticlesForActiveDept(){
  var ids=(articleDepartments||[]).filter(function(x){return x.department_id===sortiesActiveDept;}).map(function(x){return x.article_id;});
  return (articles||[]).filter(function(a){
    if(ids.indexOf(a.id)<0) return false;
    if(bsoArtSearch && (a.nom||'').toLowerCase().indexOf(bsoArtSearch)<0 && (a.ref||'').toLowerCase().indexOf(bsoArtSearch)<0) return false;
    return true;
  });
}
function bsoAvailForRow(rowIdx, articleId){
  var aid=Number(articleId||0);
  if(!aid) return 0;
  var s=getArtStock(aid);
  var stk=(s==null?0:Number(s));
  var planned=0;
  for(var i=0;i<bsoLines.length;i++){
    if(i===rowIdx) continue;
    if(Number(bsoLines[i].articleId)===aid) planned+=Number(bsoLines[i].qty||0);
  }
  return Math.max(0, stk - planned);
}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(sortie): article picker filtered by active department"
```

### Task 5.3: Render the BS creation form

- [ ] **Step 1: Replace `renderSortiesNewTab` placeholder**

```js
function renderSortiesNewTab(){
  bsoPadLines();
  var dept=(departments||[]).find(function(x){return x.id===sortiesActiveDept;}) || {name:'',code:''};
  var arts=bsoArticlesForActiveDept();

  var lineRows=bsoLines.map(function(l, i){
    var aid=Number(l.articleId||0); var q=Number(l.qty||0);
    var avail=bsoAvailForRow(i, aid);
    var artOpts='<option value="0">—</option>'+arts.map(function(a){
      var sel=(a.id===aid)?'selected':'';
      return '<option value="'+a.id+'" '+sel+'>'+escapeHtml(a.nom)+'</option>';
    }).join('');
    return '<tr>'+
      '<td>'+(i+1)+'</td>'+
      '<td><select onchange="bsoUpdateLine('+i+',\'articleId\',this.value)">'+artOpts+'</select></td>'+
      '<td><input type="number" min="0" value="'+q+'" onchange="bsoUpdateLine('+i+',\'qty\',this.value)"></td>'+
      '<td>'+(aid?(avail+' متبقي'):'—')+'</td>'+
      '<td><button class="btn-icon" onclick="bsoRemoveLine('+i+')">🗑️</button></td>'+
    '</tr>';
  }).join('');

  return ''+
    '<div class="bso-head">'+
      '<h3>📋 بون جديد — '+escapeHtml(dept.name)+'</h3>'+
      '<input id="bso-destination" placeholder="📍 الوجهة (chantier/projet — optional)" value="'+escapeHtml(bsoDestination)+'" oninput="bsoDestination=this.value">'+
    '</div>'+
    '<div class="bso-search"><input placeholder="🔍 بحث سلعة" value="'+escapeHtml(bsoArtSearch)+'" oninput="bsoArtSearch=this.value.toLowerCase();renderSortiesContent()"></div>'+
    '<table class="data-table"><thead><tr><th>#</th><th>السلعة</th><th>الكمية</th><th>المتوفر</th><th></th></tr></thead><tbody>'+
      (lineRows||'')+
    '</tbody></table>'+
    '<div style="margin-top:8px;"><button class="btn-secondary" onclick="bsoAddLine()">➕ ligne</button></div>'+
    '<div style="margin-top:12px;"><textarea id="bso-notes" placeholder="📝 ملاحظات" oninput="bsoNotes=this.value">'+escapeHtml(bsoNotes)+'</textarea></div>'+
    '<div style="margin-top:14px;text-align:center;"><button class="btn-primary" onclick="bsoSave()">💾 حفظ البون</button></div>';
}
function bsoUpdateLine(i, field, val){
  if(!bsoLines[i])return;
  if(field==='articleId') bsoLines[i].articleId=Number(val||0);
  if(field==='qty') bsoLines[i].qty=Math.max(0, Math.floor(Number(val||0)));
  renderSortiesContent();
}
function bsoAddLine(){ bsoLines.push(bsoBlankLine()); renderSortiesContent(); }
function bsoRemoveLine(i){ bsoLines.splice(i,1); bsoPadLines(); renderSortiesContent(); }
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(sortie): render BS creation form (lines + destination + notes)"
```

### Task 5.4: bon_number generator + save

- [ ] **Step 1: Add helpers**

```js
function bsoGenBonNumber(deptId){
  var d=(departments||[]).find(function(x){return x.id===deptId;});
  var code=(d&&d.code?d.code:'X').toUpperCase();
  var dt=new Date();
  var ymd=dt.getFullYear()+String(dt.getMonth()+1).padStart(2,'0')+String(dt.getDate()).padStart(2,'0');
  var prefix='BS-'+code+'-'+ymd+'-';
  var max=0;
  (sortiesBons||[]).forEach(function(b){
    if(b.department_id===deptId && b.bon_number && b.bon_number.indexOf(prefix)===0){
      var n=Number(b.bon_number.slice(prefix.length));
      if(n>max) max=n;
    }
  });
  return prefix+String(max+1).padStart(3,'0');
}

function bsoValidateStock(){
  var bad=[];
  for(var i=0;i<bsoLines.length;i++){
    var l=bsoLines[i]; var aid=Number(l.articleId||0); var q=Number(l.qty||0);
    if(!aid || !q) continue;
    var avail=bsoAvailForRow(i, aid);
    if(q>avail){
      var a=(articles||[]).find(function(x){return x.id===aid;});
      bad.push({i:i, name:a?a.nom:'#'+aid, qty:q, avail:avail});
    }
  }
  return {ok:bad.length===0, bad:bad};
}

async function bsoSave(){
  var lines=bsoLines.filter(function(l){return Number(l.articleId)&&Number(l.qty);});
  if(!lines.length){ try{toast('⚠️ ما كاين حتى ligne','warning');}catch(e){} return; }
  var v=bsoValidateStock();
  if(!v.ok){
    try{toast('⛔ مخزون غير كافٍ ('+v.bad.length+' lignes)','error');}catch(e){}
    return;
  }
  var bonNumber=bsoGenBonNumber(sortiesActiveDept);
  var payload={
    bon_number:bonNumber,
    department_id:sortiesActiveDept,
    date:new Date().toISOString().slice(0,10),
    destination:bsoDestination||null,
    notes:bsoNotes||null
  };
  var lineList=lines.map(function(l, idx){return {article_id:Number(l.articleId), qty:Number(l.qty), position:idx};});
  try{
    var newId=await sbRPC('bons_sortie_save', {p_bon:payload, p_lines:lineList});
    if(newId){
      sortiesBons.unshift(Object.assign({id:Number(newId), created_at:new Date().toISOString()}, payload));
      lineList.forEach(function(l, idx){
        var a=(articles||[]).find(function(x){return x.id===l.article_id;});
        sortiesLines.push({id:0, bon_id:Number(newId), article_id:l.article_id, qty:l.qty, snapshot_name:a?a.nom:'#'+l.article_id, position:idx});
        // optimistic stock decrement
        try{
          var stk=getArtStock(l.article_id);
          if(stk!=null) localStorage.setItem('art_stock_'+l.article_id, String(Math.max(0, Number(stk)-l.qty)));
        }catch(e){}
      });
      bsoResetState();
      renderSortiesContent();
      try{toast('✅ '+bonNumber,'success');}catch(e){}
      try{ if(typeof bsoBroadcastNew==='function') bsoBroadcastNew(Number(newId)); }catch(e){}
    }
  }catch(e){
    try{toast('❌ '+(e.message||'فشل'),'error');}catch(err){}
  }
}
```

If the project doesn't already have `sbRPC` helper, add it adjacent to `sbFetch`:

```js
async function sbRPC(fn, body){
  var r=await fetch(SB_URL+'/rest/v1/rpc/'+fn,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'apikey':SB_KEY,
      'Authorization':'Bearer '+(window._sbAccessToken||SB_KEY)
    },
    body:JSON.stringify(body||{})
  });
  if(!r.ok) throw new Error('RPC '+fn+' failed: '+r.status+' '+(await r.text()));
  return await r.json();
}
```

(Search the file for an existing equivalent first; reuse if found.)

- [ ] **Step 2: Smoke**

Switch to `📤 الخوارج` → `📋 بون جديد`. Pick 2 articles, qty 5 each. Click 💾 حفظ. Toast `✅ BS-ELEC-2026MMDD-001`. Switch to `📜 السجل` (placeholder still) → reload page → run `sortiesBons.find(x=>x.bon_number==='BS-ELEC-…')`. Should exist.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(sortie): BS save via RPC with bon_number generator + stock optimistic update"
```

---

# Milestone 6: BS history + edit/delete/photo-share

### Task 6.1: Render history list with filters

- [ ] **Step 1: Replace `renderSortiesHistoryTab` placeholder**

```js
var bsoHistFilter={from:'', to:'', q:''};
var bsoOpenBon=0;

function renderSortiesHistoryTab(){
  var bons=(sortiesBons||[]).filter(function(b){return b.department_id===sortiesActiveDept;}).slice().sort(function(a,b){return (b.created_at||'').localeCompare(a.created_at||'');});
  if(bsoHistFilter.from) bons=bons.filter(function(b){return (b.date||'')>=bsoHistFilter.from;});
  if(bsoHistFilter.to)   bons=bons.filter(function(b){return (b.date||'')<=bsoHistFilter.to;});
  if(bsoHistFilter.q){
    var q=bsoHistFilter.q.toLowerCase();
    bons=bons.filter(function(b){return (b.bon_number||'').toLowerCase().indexOf(q)>=0 || (b.destination||'').toLowerCase().indexOf(q)>=0;});
  }

  var rows=bons.map(function(b){
    var lines=(sortiesLines||[]).filter(function(l){return l.bon_id===b.id;});
    var open=(bsoOpenBon===b.id);
    var head=
      '<tr onclick="bsoToggleBon('+b.id+')" style="cursor:pointer;">'+
        '<td>'+escapeHtml(b.bon_number)+'</td>'+
        '<td>'+escapeHtml(b.date||'')+'</td>'+
        '<td>'+escapeHtml(b.destination||'—')+'</td>'+
        '<td>'+lines.length+'</td>'+
        '<td>'+
          '<button class="btn-icon" onclick="event.stopPropagation();bsoOpenEdit('+b.id+')">✏️</button>'+
          '<button class="btn-icon" onclick="event.stopPropagation();bsoDelete('+b.id+')">🗑️</button>'+
          '<button class="btn-icon" onclick="event.stopPropagation();bsoPhotoShare('+b.id+')">📨</button>'+
          '<button class="btn-icon" onclick="event.stopPropagation();bsoPrint('+b.id+')">📥</button>'+
        '</td>'+
      '</tr>';
    var detail = open
      ? '<tr><td colspan="5"><table class="data-table"><thead><tr><th>السلعة</th><th>الكمية</th></tr></thead><tbody>'+
        lines.map(function(l){return '<tr><td>'+escapeHtml(l.snapshot_name||'#'+l.article_id)+'</td><td>'+l.qty+'</td></tr>';}).join('')+
        '</tbody></table></td></tr>'
      : '';
    return head+detail;
  }).join('');

  return ''+
    '<div class="bso-filters">'+
      '<input type="date" value="'+bsoHistFilter.from+'" onchange="bsoHistFilter.from=this.value;renderSortiesContent()">'+
      '<input type="date" value="'+bsoHistFilter.to+'" onchange="bsoHistFilter.to=this.value;renderSortiesContent()">'+
      '<input placeholder="🔍 رقم/وجهة" value="'+escapeHtml(bsoHistFilter.q)+'" oninput="bsoHistFilter.q=this.value;renderSortiesContent()">'+
      '<button class="btn-secondary" onclick="bsoHistFilter={from:\'\',to:\'\',q:\'\'};renderSortiesContent()">إعادة</button>'+
    '</div>'+
    '<table class="data-table"><thead><tr><th>الرقم</th><th>التاريخ</th><th>الوجهة</th><th>السطور</th><th></th></tr></thead><tbody>'+
      (rows||'<tr><td colspan="5">ما كاين حتى بون</td></tr>')+
    '</tbody></table>';
}
function bsoToggleBon(id){ bsoOpenBon = (bsoOpenBon===id?0:id); renderSortiesContent(); }
```

- [ ] **Step 2: Stubs for actions (filled in next tasks)**

```js
function bsoOpenEdit(id){ alert('TODO: edit (Task 6.2)'); }
function bsoDelete(id){ alert('TODO: delete (Task 6.3)'); }
function bsoPhotoShare(id){ alert('TODO: photo (Task 6.4)'); }
function bsoPrint(id){ alert('TODO: print (Task 6.4)'); }
```

- [ ] **Step 3: Smoke**

Switch to `📜 السجل` — list shows historical elec dispatches as `BS-ELEC-…` with line counts.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(sortie): history list with filters + expand row"
```

### Task 6.2: Edit modal

- [ ] **Step 1: Implement edit modal flow**

```js
var bsoEditState=null; // {bon, lines}

function bsoOpenEdit(id){
  var b=(sortiesBons||[]).find(function(x){return x.id===id;});
  if(!b) return;
  var lines=(sortiesLines||[]).filter(function(l){return l.bon_id===id;}).map(function(l, idx){return {articleId:l.article_id, qty:l.qty, position:idx};});
  bsoEditState={ bon:Object.assign({}, b), lines:lines };
  bsoRenderEditModal();
}
function bsoRenderEditModal(){
  var m=document.getElementById('modal-bso-edit');
  if(!m){
    var d=document.createElement('div');
    d.id='modal-bso-edit';
    d.className='modal';
    d.style.display='flex';
    d.onclick=function(e){ if(e.target===this) bsoCloseEdit(); };
    document.body.appendChild(d);
    m=d;
  }
  m.style.display='flex';
  var st=bsoEditState; if(!st) return;
  var deptArts=bsoArticlesForActiveDept();
  var rows=st.lines.map(function(l, i){
    var artOpts='<option value="0">—</option>'+deptArts.map(function(a){return '<option value="'+a.id+'" '+(a.id===Number(l.articleId)?'selected':'')+'>'+escapeHtml(a.nom)+'</option>';}).join('');
    return '<tr>'+
      '<td><select onchange="bsoEditState.lines['+i+'].articleId=Number(this.value);bsoRenderEditModal()">'+artOpts+'</select></td>'+
      '<td><input type="number" value="'+l.qty+'" onchange="bsoEditState.lines['+i+'].qty=Math.max(0,Math.floor(Number(this.value)||0));bsoRenderEditModal()"></td>'+
      '<td><button class="btn-icon" onclick="bsoEditState.lines.splice('+i+',1);bsoRenderEditModal()">🗑️</button></td>'+
    '</tr>';
  }).join('');
  m.innerHTML='<div class="modal-box"><div class="modal-head"><h3>✏️ '+escapeHtml(st.bon.bon_number)+'</h3><button class="btn-icon" onclick="bsoCloseEdit()">✖️</button></div>'+
    '<input value="'+escapeHtml(st.bon.destination||'')+'" placeholder="📍 الوجهة" oninput="bsoEditState.bon.destination=this.value">'+
    '<table class="data-table"><thead><tr><th>السلعة</th><th>الكمية</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<button class="btn-secondary" onclick="bsoEditState.lines.push({articleId:0,qty:0});bsoRenderEditModal()">➕ ligne</button>'+
    '<textarea oninput="bsoEditState.bon.notes=this.value">'+escapeHtml(st.bon.notes||'')+'</textarea>'+
    '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px;">'+
      '<button class="btn-secondary" onclick="bsoCloseEdit()">إلغاء</button>'+
      '<button class="btn-primary" onclick="bsoSaveEdit()">💾 حفظ</button>'+
    '</div></div>';
}
function bsoCloseEdit(){
  var m=document.getElementById('modal-bso-edit');
  if(m) m.style.display='none';
  bsoEditState=null;
}
async function bsoSaveEdit(){
  if(!bsoEditState) return;
  var st=bsoEditState;
  var clean=st.lines.filter(function(l){return Number(l.articleId)&&Number(l.qty);});
  try{
    await sbRPC('bons_sortie_update', {
      p_bon_id: st.bon.id,
      p_bon: {date:st.bon.date, destination:st.bon.destination||null, notes:st.bon.notes||null},
      p_lines: clean.map(function(l, i){return {article_id:Number(l.articleId), qty:Number(l.qty), position:i};})
    });
    var idx=sortiesBons.findIndex(function(x){return x.id===st.bon.id;});
    if(idx>=0) sortiesBons[idx]=Object.assign(sortiesBons[idx], {destination:st.bon.destination, notes:st.bon.notes, updated_at:new Date().toISOString()});
    sortiesLines=sortiesLines.filter(function(l){return l.bon_id!==st.bon.id;});
    clean.forEach(function(l, i){
      var a=(articles||[]).find(function(x){return x.id===Number(l.articleId);});
      sortiesLines.push({id:0, bon_id:st.bon.id, article_id:Number(l.articleId), qty:Number(l.qty), snapshot_name:a?a.nom:'#'+l.articleId, position:i});
    });
    bsoCloseEdit();
    renderSortiesContent();
    try{toast('✅ تم التعديل','success');}catch(e){}
    try{ if(typeof bsoBroadcastEdit==='function') bsoBroadcastEdit(st.bon.id); }catch(e){}
    // Re-fetch articles to refresh stock cache
    if(typeof loadArticlesQuiet==='function') loadArticlesQuiet();
  }catch(e){
    try{toast('❌ '+(e.message||'فشل'),'error');}catch(err){}
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(sortie): edit modal — destination, notes, lines (delta-stock RPC)"
```

### Task 6.3: Delete with stock restore

- [ ] **Step 1: Implement**

```js
async function bsoDelete(id){
  var b=(sortiesBons||[]).find(function(x){return x.id===id;});
  if(!b) return;
  if(!confirm('Supprimer '+b.bon_number+' ? Stock kayrjeu.')) return;
  try{
    await sbRPC('bons_sortie_delete', {p_bon_id:id});
    var lines=(sortiesLines||[]).filter(function(l){return l.bon_id===id;});
    sortiesBons=sortiesBons.filter(function(x){return x.id!==id;});
    sortiesLines=sortiesLines.filter(function(l){return l.bon_id!==id;});
    // Optimistic stock restore
    lines.forEach(function(l){
      try{
        var s=getArtStock(l.article_id);
        if(s!=null) localStorage.setItem('art_stock_'+l.article_id, String(Number(s)+Number(l.qty)));
      }catch(e){}
    });
    renderSortiesContent();
    try{toast('🗑️ تم الحذف','success');}catch(e){}
    try{ if(typeof bsoBroadcastDelete==='function') bsoBroadcastDelete(b); }catch(e){}
  }catch(e){
    try{toast('❌ '+(e.message||'فشل'),'error');}catch(err){}
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(sortie): delete BS with stock restore + cascade lines"
```

### Task 6.4: Photo-share + print

- [ ] **Step 1: Add helpers**

```js
function bsoBuildPrintHTML(bonId){
  var b=(sortiesBons||[]).find(function(x){return x.id===bonId;});
  if(!b) return '';
  var d=(departments||[]).find(function(x){return x.id===b.department_id;}) || {name:''};
  var lines=(sortiesLines||[]).filter(function(l){return l.bon_id===bonId;});
  var rows=lines.map(function(l,i){return '<tr><td>'+(i+1)+'</td><td>'+escapeHtml(l.snapshot_name||'#'+l.article_id)+'</td><td>'+l.qty+'</td></tr>';}).join('');
  return ''+
    '<div class="bso-print" style="font-family:Cairo,sans-serif;direction:rtl;background:#fff;color:#000;padding:24px;width:780px;">'+
      '<h2 style="text-align:center;">📤 بون خرج</h2>'+
      '<div style="display:flex;justify-content:space-between;margin:14px 0;">'+
        '<div><b>الإدارة:</b> '+escapeHtml(d.name)+'</div>'+
        '<div><b>الرقم:</b> '+escapeHtml(b.bon_number)+'</div>'+
        '<div><b>التاريخ:</b> '+escapeHtml(b.date||'')+'</div>'+
      '</div>'+
      (b.destination?'<div><b>الوجهة:</b> '+escapeHtml(b.destination)+'</div>':'')+
      '<table style="width:100%;border-collapse:collapse;margin-top:14px;border:1px solid #000;">'+
        '<thead><tr><th style="border:1px solid #000;padding:6px;">#</th><th style="border:1px solid #000;padding:6px;">السلعة</th><th style="border:1px solid #000;padding:6px;">الكمية</th></tr></thead>'+
        '<tbody>'+rows.replace(/<td>/g,'<td style="border:1px solid #000;padding:6px;">')+'</tbody>'+
      '</table>'+
      (b.notes?'<div style="margin-top:14px;"><b>ملاحظات:</b><br>'+escapeHtml(b.notes)+'</div>':'')+
    '</div>';
}

async function bsoPhotoShare(bonId){
  var html=bsoBuildPrintHTML(bonId);
  if(!html) return;
  var b=(sortiesBons||[]).find(function(x){return x.id===bonId;});
  // Render offscreen iframe (sandboxed) → html2canvas → blob → broadcast
  var iframe=document.createElement('iframe');
  iframe.style.cssText='position:fixed;left:-9999px;top:0;width:820px;height:1200px;border:0;';
  document.body.appendChild(iframe);
  iframe.srcdoc='<!doctype html><html><head><meta charset="utf-8"></head><body>'+html+'</body></html>';
  await new Promise(function(r){iframe.onload=r;});
  try{
    var target=iframe.contentDocument.querySelector('.bso-print');
    var canvas=await html2canvas(target, {backgroundColor:'#fff', scale:2});
    canvas.toBlob(async function(blob){
      try{
        await sendTelegramPhotoBroadcast(blob, b.bon_number+'.png', '📤 '+b.bon_number);
        try{toast('📨 تم الإرسال','success');}catch(e){}
      }catch(e){
        try{toast('❌ '+(e.message||'فشل'),'error');}catch(err){}
      }
      iframe.remove();
    },'image/png');
  }catch(e){
    iframe.remove();
    try{toast('❌ '+(e.message||'فشل التصوير'),'error');}catch(err){}
  }
}

function bsoPrint(bonId){
  var html=bsoBuildPrintHTML(bonId);
  if(!html) return;
  var w=window.open('', '_blank');
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>BS</title></head><body onload="window.print();window.close();">'+html+'</body></html>');
  w.document.close();
}
```

- [ ] **Step 2: Smoke**

In history → click 📨 → Telegram receives image with the BS. Click 📥 → print dialog opens.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(sortie): photo-share via html2canvas + print"
```

---

# Milestone 7: Telegram notifs

### Task 7.1: Build text broadcast

**Files:**
- Modify: `index.html` — group with other notif functions (search for `sendTelegramBroadcast`).

- [ ] **Step 1: Add broadcast helpers**

```js
function bsoBuildNotifText(bonId, kind){
  var b=(sortiesBons||[]).find(function(x){return x.id===bonId;});
  if(!b) return '';
  var d=(departments||[]).find(function(x){return x.id===b.department_id;}) || {name:'',icon:''};
  var lines=(sortiesLines||[]).filter(function(l){return l.bon_id===bonId;});
  var head = kind==='edit' ? '✏️ تعديل بون خرج' : (kind==='delete' ? '🗑️ حذف بون خرج' : '📤 بون خرج جديد');
  var lineList = lines.slice(0, 10).map(function(l){
    return '• '+(l.snapshot_name||'#'+l.article_id)+' × '+l.qty;
  }).join('\n');
  if(lines.length>10) lineList += '\n…(+'+(lines.length-10)+')';
  var who = (window._currentUserName || (window.currentUser && currentUser.email) || '');
  return ''+
    head+'\n\n'+
    '🏷️ الإدارة: '+(d.icon||'')+' '+d.name+'\n'+
    '📋 الرقم: '+b.bon_number+'\n'+
    '📅 التاريخ: '+(b.date||'')+'\n'+
    (b.destination?'📍 الوجهة: '+b.destination+'\n':'')+
    (who?'👤 من طرف: '+who+'\n':'')+
    '\n🛒 السلع ('+lines.length+'):\n'+lineList;
}
function bsoBroadcastNew(id){    try{ sendTelegramBroadcast(bsoBuildNotifText(id,'new')); }catch(e){} }
function bsoBroadcastEdit(id){   try{ sendTelegramBroadcast(bsoBuildNotifText(id,'edit')); }catch(e){} }
function bsoBroadcastDelete(b){
  try{
    var d=(departments||[]).find(function(x){return x.id===b.department_id;}) || {name:''};
    var msg='🗑️ حذف بون خرج\n\n🏷️ الإدارة: '+(d.icon||'')+' '+d.name+'\n📋 الرقم: '+b.bon_number;
    sendTelegramBroadcast(msg);
  }catch(e){}
}
```

- [ ] **Step 2: Smoke**

Save a new BS → Telegram message arrives with format above. Edit the BS → 2nd message arrives with `✏️`. Delete → 3rd message with `🗑️`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(sortie): Telegram notifs on save/edit/delete with department + lines"
```

---

# Milestone 8: Strip dispatches from `#elec-dist`

### Task 8.1: Remove dispatch sections from `renderElecDist`

**Files:**
- Modify: `index.html` — `function renderElecDist` and `_dispatch_*` related sections (~lines 13903-14150).

- [ ] **Step 1: Identify the sections to remove**

Run:

```bash
grep -nE "edDisp|edGenBon|edDispatches" index.html | head
```

This lists every dispatch reference. Most live inside `renderElecDist`. The function should keep only:
- techs list rendering
- PCs assignment rendering
- worker EOD digest helpers

Strip the BS builder + dispatch history sections from the function body.

- [ ] **Step 2: Comment out (don't delete) the old rendering blocks for one release**

Wrap each removed block with:

```js
/* MOVED TO #sorties hub on 2026-05-04 — kept commented for one release.
   Delete in next migration after verifying the new hub for two weeks.
   ─── DISPATCH BUILDER ───
*/
```

- [ ] **Step 3: Smoke**

Reload `#elec-dist` page. Should show: techs list + PCs section. No dispatch builder, no dispatch history. Sidebar `📤 الخوارج` is the new home.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "refactor(elec-dist): remove dispatch sections (moved to #sorties hub)"
```

### Task 8.2: Remove dead state declarations

- [ ] **Step 1: Comment out (don't delete) `var edDispatches=[]` and the related state**

Replace with:

```js
// var edDispatches=[]; // RETIRED 2026-05-04 — see sortiesBons + sortiesLines
```

Same for any `edDispLines`, `edDispCatFilter`, `edDispArtSearch`, `edOpenBon` declarations.

- [ ] **Step 2: Update `_wipe` calls if any reference `material_dispatches`**

Search for `_wipe('material_dispatches')` and replace the table name with the archived one if the wipe still runs:

```js
// before:
await _wipe('material_dispatches'); edDispatches=[];
// after:
// 'material_dispatches' renamed to 'material_dispatches_archive_2026_05' — wipe disabled
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "refactor(elec-dist): retire edDispatches state (use sortiesBons)"
```

---

# Milestone 9: SW cache + smoke + deploy

### Task 9.1: Bump SW cache name

**Files:**
- Modify: `sw.js`

- [ ] **Step 1: Update cache name**

Find the line setting the cache name (search for `suivi-v114-`):

```js
const CACHE_NAME = 'suivi-v115-bs-hub';
```

- [ ] **Step 2: Commit**

```bash
git add sw.js
git commit -m "chore(sw): bump cache to suivi-v115-bs-hub"
```

### Task 9.2: Browser smoke test checklist

Manual browser checks before deploy:

- [ ] **Reload at `https://localhost:…` (or the local index.html) — all data loads, no console errors.**
- [ ] **Open `📤 الخوارج` → `📋 بون جديد` → create a BS with 2 lines on Élec → save → toast shows `BS-ELEC-…`.**
- [ ] **Switch to `📜 السجل` → see new BS at top, expand row to see lines.**
- [ ] **Edit the BS, change destination, remove one line, save → re-expand, see the change. Stock for the removed article incremented.**
- [ ] **Delete the BS → row disappears, stock restored.**
- [ ] **Photo-share → image arrives in Telegram with the BS.**
- [ ] **Print → print dialog opens with the BS template.**
- [ ] **Open `⚙️` → add a department `🔧 plom` → tab appears in hub.**
- [ ] **Open an article modal → tag it with both Élec and Plomberie → save → BS picker on Plomberie tab now shows that article.**
- [ ] **Try to add a 4th department to an article — toast warns; no row created.**
- [ ] **`#elec-dist` page renders only techs + PCs. No dispatch UI.**
- [ ] **Reload — service worker activates `suivi-v115-bs-hub`, banner appears (no auto-reload).**

### Task 9.3: Telegram smoke

- [ ] **Confirm a save broadcast arrived in the bot (check the Telegram app).**
- [ ] **Confirm the format matches §7.1 of the spec exactly.**

### Task 9.4: Deploy to Hostinger FTP

- [ ] **Step 1: Run the existing deploy script** (the project uses an `ftp` helper — check `package.json` scripts or the `bot.log` / docs for the deploy command. If absent, upload `index.html` + `sw.js` via the Hostinger FTP creds in `project_suivi_state.md`.)

- [ ] **Step 2: Smoke prod**

Open `https://maderadeco.app`, hard-reload, repeat the §9.2 checklist quickly on prod.

- [ ] **Step 3: Final commit**

```bash
git tag -a v115-bs-hub -m "Bons de sortie par département — production"
```

---

## Self-review (post-write)

**Spec coverage:**
- §5 Data model → Tasks 1.2 / 1.3 / 1.4 (tables, RLS, trigger).
- §5.3 Save RPC → Task 1.5. Update RPC → Task 1.6. Delete RPC → Task 1.7.
- §6.1 Hub layout → Tasks 4.1–4.3.
- §6.2 Departments CRUD → Tasks 2.2–2.3.
- §6.3 Article tagging → Tasks 3.1–3.2.
- §6.4 BS creation → Tasks 5.1–5.4.
- §6.5 BS history → Tasks 6.1–6.4.
- §7 Telegram notifs → Task 7.1.
- §8 Migration → Tasks 1.8–1.10.
- §9 Edge cases → enforced in RPCs (Tasks 1.5–1.7) and trigger (Task 1.3).
- §10 Acceptance criteria → covered by Task 9.2 smoke checklist.

**Placeholder scan:** Two intentional `alert('TODO: …')` stubs in Task 6.1 (replaced by real handlers in 6.2–6.4). Migration has known unknowns flagged in Task 0.1 (column types) — confirmed before §1.x writes the data move.

**Type consistency:** State arrays (`sortiesBons`, `sortiesLines`, `articleDepartments`, `departments`) are referenced consistently across milestones 2–7. RPC names (`bons_sortie_save/update/delete`) match between SQL (1.5–1.7) and JS (5.4, 6.2, 6.3). Function names use `bso*` prefix consistently for client code.

---

## Plan complete

Plan saved to `docs/superpowers/plans/2026-05-04-bons-sortie-departments.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
