-- ================================================================
--  Smart Purchase Entry — supplier_products junction table
--  Adapté pour le schéma سويفي existant (fournisseurs + articles)
-- ================================================================

CREATE TABLE IF NOT EXISTS supplier_products (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id             BIGINT NOT NULL REFERENCES fournisseurs(id) ON DELETE CASCADE,
  product_id              BIGINT NOT NULL REFERENCES articles(id)     ON DELETE CASCADE,
  last_purchase_price_ttc NUMERIC(12, 2) DEFAULT 0,
  updated_at              TIMESTAMPTZ    DEFAULT NOW(),
  UNIQUE (supplier_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_sp_supplier ON supplier_products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_sp_product  ON supplier_products(product_id);

-- Enable Row Level Security (recommended)
ALTER TABLE supplier_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON supplier_products
  FOR ALL USING (true);
