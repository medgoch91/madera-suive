# Bons de sortie par département — Design spec

**Date:** 2026-05-04
**Author:** Mohamed Barakat (brainstormed with Claude)
**Status:** Approved — ready for implementation plan
**File touched:** `index.html` (~19,351 lines), Supabase migrations, SW cache

---

## 1. Problem statement

Today only the `elec-dist` department has a "bon de sortie" (BS) flow tracking
articles leaving stock. All other articles entered via bons d'entrée from
fournisseurs sit in stock with no formal sortie tracking.

User wants every article that leaves stock to be sent to its **department**
through a department-specific bon de sortie, with full traceability.

## 2. Goals

- Define a CRUD-managed list of departments (admin can add/edit/archive).
- Tag every article with 1–3 departments (m:n).
- Issue bons de sortie scoped to a department, with their own numbering series
  (`BS-ELEC-…`, `BS-PLOM-…`, …).
- Migrate existing `elec-dist` dispatches into the new model without data loss.
- Same Telegram notification fan-out as bons d'entrée / cheques / factures.
- Photo-share + PDF/print parity with cheques and factures.

## 3. Non-goals (deferred to later spec)

- Per-department piece-work / paie (workers stay on the existing salaries
  + PCs system unchanged).
- Per-department stock min/max thresholds + alerts.
- Per-department reports / KPIs on the dashboard.
- Per-department Telegram chat-id filtering (everyone gets every BS for now).
- Mobile UX polish (tracked separately in `project_suivi_mobile_pending.md`).

## 4. Decisions log

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Article-to-department cardinality | m:n, max 3 | User: "kynin li kymchi 2 depart tal 3" |
| 2 | Workers on the BS? | No — BS is dept-level | User: "knt3mlo m3a department machi workers" |
| 3 | BS numbering series | Separate per dept (`BS-ELEC-…`) | User: "mfr9" |
| 4 | Department list | CRUD-managed by user | User: "men ahsan list tkon modifier" |
| 5 | UI topology | Approach C — hub + dynamic tabs | Matches catalog-hub pattern user adopted |
| 6 | Scope | α — BS + tagging + dept CRUD only | Workers/PCs stay untouched |
| 7 | Migration | Option (i) — dispatches → hub; elec-dist keeps techs+PCs | Clean separation |
| 8 | Telegram notifs | (a) — broadcast all chat_ids with dept in message | Matches existing pattern |
| 9 | Permissions | Same as bons d'entrée | No new permission gate |
| 10 | Destination field | Yes — optional text on BS | Useful for chantier traceability |
| 11 | Photo-share | Yes — per-row button | Match cheques/factures pattern |

## 5. Data model

### 5.1 New tables

```sql
-- Department registry
CREATE TABLE departments (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,        -- 'elec', 'plom', 'peint'
  name        TEXT NOT NULL,               -- 'الكهرباء', 'السباكة'
  icon        TEXT,                        -- '⚡', '🔧'
  color       TEXT DEFAULT '#94a3b8',      -- accent color in tabs/badges
  position    INT DEFAULT 0,               -- ordering in tabs
  active      BOOLEAN DEFAULT TRUE,        -- soft delete
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Article ↔ Department m:n join
CREATE TABLE article_departments (
  article_id     BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  department_id  BIGINT NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (article_id, department_id)
);

-- Enforce ≤3 departments per article
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

-- Bon de sortie header
CREATE TABLE bons_sortie (
  id             BIGSERIAL PRIMARY KEY,
  bon_number     TEXT UNIQUE NOT NULL,         -- 'BS-ELEC-20260504-001'
  department_id  BIGINT NOT NULL REFERENCES departments(id),
  date           DATE NOT NULL DEFAULT CURRENT_DATE,
  destination    TEXT,                          -- chantier/projet (optional)
  notes          TEXT,                          -- (optional)
  created_by     UUID REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bons_sortie_department_date ON bons_sortie(department_id, date DESC);

-- Bon de sortie lines
CREATE TABLE bons_sortie_lines (
  id             BIGSERIAL PRIMARY KEY,
  bon_id         BIGINT NOT NULL REFERENCES bons_sortie(id) ON DELETE CASCADE,
  article_id     BIGINT NOT NULL REFERENCES articles(id),
  qty            NUMERIC NOT NULL CHECK (qty > 0),
  snapshot_name  TEXT,                          -- article.nom at save time
  position       INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bons_sortie_lines_bon_id ON bons_sortie_lines(bon_id);
CREATE INDEX idx_bons_sortie_lines_article_id ON bons_sortie_lines(article_id);
```

### 5.2 RLS

All four tables: `authenticated_all` policy (same model as `bons`,
`salary_rates`, `pc_avances`).

```sql
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_all ON departments FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- (repeat for the 3 other tables)
```

### 5.3 Atomic save RPC

```sql
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

  -- 1. Insert header
  INSERT INTO bons_sortie (bon_number, department_id, date, destination, notes, created_by)
  VALUES (
    p_bon->>'bon_number',
    v_dept_id,
    COALESCE((p_bon->>'date')::DATE, CURRENT_DATE),
    p_bon->>'destination',
    p_bon->>'notes',
    auth.uid()
  )
  RETURNING id INTO v_bon_id;

  -- 2. Insert lines + decrement stock atomically
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    -- Verify article is tagged for this department
    IF NOT EXISTS (
      SELECT 1 FROM article_departments
      WHERE article_id = (v_line->>'article_id')::BIGINT
        AND department_id = v_dept_id
    ) THEN
      RAISE EXCEPTION 'Article % is not tagged for department %', v_line->>'article_id', v_dept_id;
    END IF;

    -- Verify stock
    SELECT stock INTO v_avail FROM articles WHERE id = (v_line->>'article_id')::BIGINT FOR UPDATE;
    IF v_avail < (v_line->>'qty')::NUMERIC THEN
      RAISE EXCEPTION 'Insufficient stock for article %: avail=% qty=%', v_line->>'article_id', v_avail, v_line->>'qty';
    END IF;

    -- Decrement stock
    UPDATE articles SET stock = stock - (v_line->>'qty')::NUMERIC WHERE id = (v_line->>'article_id')::BIGINT;

    -- Insert line
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
```

A symmetric `bons_sortie_update(p_bon_id, p_bon, p_lines)` RPC handles edits:
diff old vs new lines and apply stock deltas atomically.
A `bons_sortie_delete(p_bon_id)` RPC returns stock for every line then deletes.

## 6. UI architecture

### 6.1 Hub `#sorties`

```
┌─────────────────────────────────────────────┐
│ 📤 الخوارج                       [⚙️ Depts]│
├─────────────────────────────────────────────┤
│ [⚡ Élec][🔧 Plomberie][🎨 Peinture][➕]   │
├─────────────────────────────────────────────┤
│ Sub-tabs: [📋 بون جديد] [📜 السجل]         │
├─────────────────────────────────────────────┤
│ < contenu dynamique selon le tab actif >    │
└─────────────────────────────────────────────┘
```

- Sidebar entry: `📤 الخوارج` → route `#sorties`.
- Top tabs auto-built from `departments WHERE active=true ORDER BY position, id`.
- The `➕` tab opens the departments CRUD modal directly on the "new dept" form.
- The `⚙️ Depts` button opens the same modal in list mode.

### 6.2 Departments CRUD

**List view** inside the modal:
- Row: `code · name · icon · color · {N articles} · {N BS} · ✏️ · 🗑️archive · ⬆️⬇️`
- Footer: `➕ Add new department` button → form view.

**Form view:**
- `code` (immutable after first save — used as namespace in BS numbers)
- `name` (Arabic, required)
- `icon` (single emoji, optional)
- `color` (color picker, default `#94a3b8`)
- `position` (number input, optional — auto-bump on save if collision)
- `active` (checkbox, default true)

**Archive vs delete:**
- 🗑️ button = soft delete (`active=false`).
- Hard delete blocked at DB level if any BS exist for that dept.

### 6.3 Article tagging

Inside the existing article edit modal, new section after `🏷️ الخصائص`:

```
📤 الإدارات (max 3)

[⚡ Élec ×]  [🔧 Plomberie ×]  [+ ajouter]
```

- Multi-select chips (same UX as `fournisseurs.families`).
- Click `[+ ajouter]` → dropdown of remaining active departments.
- Save diff: insert new tags + delete removed tags via two RPC calls.
- If user tries to add a 4th chip → toast `⚠️ Max 3 إدارات لكل سلعة`.

### 6.4 BS creation flow (sub-tab `📋 بون جديد`)

Layout mirrors current `edDispatches` builder:

```
┌──────────────────────────────────────────────┐
│ 📋 بون جديد                  📍 Destination  │
│                              [Villa Hay …]   │
├──────────────────────────────────────────────┤
│ Articles search · category filter            │
├──────────────────────────────────────────────┤
│ Article picker (filtered by current dept)    │
├──────────────────────────────────────────────┤
│ Line 1 · article · qty · stock badge · 🗑️    │
│ Line 2 · …                                   │
│ Line 3 · …                                   │
│ Line 4 · …                                   │
│ ➕ ajouter ligne                             │
├──────────────────────────────────────────────┤
│ 📝 ملاحظات                                  │
│ [textarea]                                   │
├──────────────────────────────────────────────┤
│           [💾 حفظ البون]                    │
└──────────────────────────────────────────────┘
```

- `ED_DISP_MIN_ROWS = 4` reused.
- Article picker query: `SELECT a.* FROM articles a JOIN article_departments ad ON a.id = ad.article_id WHERE ad.department_id = :current_dept`.
- Stock badge per row: `getArtStock(aid)` minus planned qty in other rows for same article.
- `bon_number` generated client-side: `BS-{DEPT_CODE}-{YYYYMMDD}-{NNN}` based on max existing for that dept on that date.
- Save → `rpc('bons_sortie_save', {p_bon, p_lines})` → toast + reset state + Telegram notif.

### 6.5 BS history flow (sub-tab `📜 السجل`)

- Filters: date range + search (`bon_number` / `destination`) + reset.
- List: row per BS, expandable to show lines.
- Per-row actions:
  - ✏️ Edit modal — change destination/notes/lines (delegates to `bons_sortie_update`).
  - 🗑️ Delete with confirm (`bons_sortie_delete` returns stock).
  - 📨 Photo-share — html2canvas of an offscreen iframe rendering the BS template, broadcast as photo.
  - 📥 PDF/Print — same template, `window.print()` in a new window.

## 7. Telegram notifications

### 7.1 Broadcast format

```
📤 بون خرج جديد

🏷️ الإدارة: ⚡ الكهرباء
📋 الرقم: BS-ELEC-20260504-001
📅 التاريخ: 2026-05-04
📍 الوجهة: Villa Hay Riad
👤 من طرف: Mohamed

🛒 السلع (5):
• كابل 2.5mm × 50m
• مفتاح ضوء × 12
• لمبة LED 9W × 24
• كرتون 16A × 8
• داكتيل 25mm × 30m
```

Edit notif: same format, header `✏️ تعديل بون خرج`.
Delete notif: header `🗑️ حذف بون خرج` + reason if provided.

### 7.2 Fan-out

`sendTelegramBroadcast(text)` → all chat_ids in
`localStorage.tg_chat_id` ∪ `bot_subscribers`. Same fan-out as bons d'entrée.

Photo-share path: explicit user click triggers `sendTelegramPhotoBroadcast(blob, filename, caption)` with the html2canvas blob.

## 8. Migration

### 8.1 Forward migration

File: `supabase/migrations/20260504000000_bons_sortie_departments.sql`

```sql
BEGIN;

-- 1. Schema (sections 5.1, 5.2, 5.3 above)
-- ...

-- 2. Seed elec
INSERT INTO departments (id, code, name, icon, color, position)
VALUES (1, 'elec', '⚡ الكهرباء', '⚡', '#fbbf24', 1);

SELECT setval('departments_id_seq', GREATEST((SELECT MAX(id) FROM departments), 1));

-- 3. Migrate existing dispatches → bons_sortie
INSERT INTO bons_sortie (bon_number, department_id, date, destination, notes, created_by, created_at)
SELECT
  REPLACE(bon_number, 'BS-', 'BS-ELEC-') AS bon_number,
  1 AS department_id,
  date,
  NULL AS destination,
  notes,
  created_by,
  created_at
FROM ed_dispatches;

-- 4. Migrate dispatch lines (assumes ed_dispatch_lines schema — adapt to actual)
INSERT INTO bons_sortie_lines (bon_id, article_id, qty, snapshot_name, position, created_at)
SELECT
  bs.id,
  edl.article_id,
  edl.qty,
  a.nom,
  edl.position,
  edl.created_at
FROM ed_dispatch_lines edl
JOIN ed_dispatches ed ON edl.dispatch_id = ed.id
JOIN bons_sortie bs ON bs.bon_number = REPLACE(ed.bon_number, 'BS-', 'BS-ELEC-')
JOIN articles a ON a.id = edl.article_id;

-- 5. Auto-tag elec articles based on past dispatches
INSERT INTO article_departments (article_id, department_id)
SELECT DISTINCT article_id, 1
FROM ed_dispatch_lines
ON CONFLICT DO NOTHING;

-- 6. Archive old tables (manual DROP later)
ALTER TABLE ed_dispatches RENAME TO ed_dispatches_archive_2026_05;
ALTER TABLE ed_dispatch_lines RENAME TO ed_dispatch_lines_archive_2026_05;

COMMIT;
```

### 8.2 Rollback

```sql
BEGIN;
ALTER TABLE ed_dispatches_archive_2026_05 RENAME TO ed_dispatches;
ALTER TABLE ed_dispatch_lines_archive_2026_05 RENAME TO ed_dispatch_lines;
DROP TABLE bons_sortie_lines, bons_sortie, article_departments, departments CASCADE;
DROP FUNCTION bons_sortie_save, bons_sortie_update, bons_sortie_delete;
COMMIT;
```

### 8.3 Client cutover

- SW cache bumped to `suivi-v115-bs-hub`.
- New sidebar entry `📤 الخوارج` added; `📦 فورنيسور و السلعة` unchanged.
- `renderElecDist` strips dispatch-related sections (techs + PCs renderers stay).
- `edDispatches` JS state + `edDisp*` functions deleted; replaced by
  `sortiesBons[]` + `bsoDisp*` family.

### 8.4 Data verification (post-migration)

Run after the migration to confirm no row was lost:

```sql
SELECT
  (SELECT COUNT(*) FROM ed_dispatches_archive_2026_05) AS old_headers,
  (SELECT COUNT(*) FROM bons_sortie WHERE department_id = 1) AS new_headers,
  (SELECT COUNT(*) FROM ed_dispatch_lines_archive_2026_05) AS old_lines,
  (SELECT COUNT(*) FROM bons_sortie_lines bsl JOIN bons_sortie bs ON bsl.bon_id = bs.id WHERE bs.department_id = 1) AS new_lines,
  (SELECT COUNT(DISTINCT article_id) FROM ed_dispatch_lines_archive_2026_05) AS distinct_articles_dispatched,
  (SELECT COUNT(*) FROM article_departments WHERE department_id = 1) AS auto_tagged_articles;
```

Counts must match (old_headers = new_headers, old_lines = new_lines,
distinct_articles_dispatched = auto_tagged_articles).

## 9. Edge cases

| Case | Behavior |
|------|----------|
| Article with 0 departments | Invisible in every BS picker — must be tagged before sortie |
| Article in 2 departments | Appears in both pickers — expected |
| Department archived (`active=false`) | Tab hidden in hub; existing BS for it still readable from `📜 السجل` if user toggles "show archived" |
| Stock = 0 on save | `bons_sortie_save` raises; toast `⛔ مخزون غير كافٍ` |
| Article renamed after BS save | `snapshot_name` preserves the historical name in lines display |
| User edits a BS — line removed | RPC restores `qty` to `articles.stock` |
| User edits a BS — line added | RPC verifies stock and decrements |
| User edits a BS — qty changed | Delta `(old - new)` applied to stock |
| User deletes a BS | RPC restores stock for every line then deletes header (cascade lines) |
| User tries to delete a department with BS | Blocked by FK `ON DELETE RESTRICT`; user must archive instead |
| User tries to add 4th tag on an article | Trigger raises; client also enforces with toast |

## 10. Acceptance criteria

1. Admin can create/edit/archive departments through the hub.
2. Admin can tag any article with up to 3 departments through the article modal.
3. From the hub `#sorties`, selecting a department tab shows only articles tagged for it in the picker.
4. Saving a BS decrements stock atomically; partial failure leaves no half-state.
5. The history sub-tab lists past BS for the active department with edit/delete/photo-share/print actions.
6. Editing or deleting a BS adjusts stock atomically.
7. Telegram notifications fire on save / edit / delete with the format in §7.1.
8. After migration, every old elec dispatch appears under the Élec tab with a `BS-ELEC-…` number, and every article that was ever dispatched is auto-tagged for elec.
9. The `#elec-dist` page no longer renders dispatches but still renders techs + PCs sections unchanged.
10. SW cache bumped; first reload after deploy refreshes assets cleanly.

## 11. Open questions for implementation phase

- Exact schema of existing `ed_dispatches` / `ed_dispatch_lines` tables (column names, FK direction) — confirm before writing the migration. The current `index.html` references `edDispatches` as a JS state array — actual table name in Supabase needs verification via `\d` or `SELECT table_name FROM information_schema.tables`.
- Whether to keep both old `BS-…` and new `BS-ELEC-…` numbers retrievable (e.g., a virtual column / view aliasing the legacy number) — proposed: not needed, telegram history holds legacy numbers, new system is forward-only.
- Print template style — reuse cheque template (~A4 landscape) vs facture template (full A4 portrait). Proposed: cheque-stub style, more compact.

## 12. Reference patterns to reuse

- Card-grid responsive fallback at ≤768px → see commit `6259853` (wages dashboard redesign).
- Sticky save bar in modal → commit `4e758d6`.
- Photo-share via offscreen iframe + html2canvas → existing facture row implementation.
- Family chip multi-select UI → existing `fournisseurs.families` editor.
- Atomic RPC pattern with stock delta → existing elec dispatch save.
