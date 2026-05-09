-- 20260509000000_bon_photos_storage.sql
-- Add photo upload capability to bons d'entrée: a Storage bucket for the
-- photo blob + a photo_path column on bons that stores the bucket key.
-- Audit-trail use case: snap a photo of the paper bon when entering it,
-- attach it forever.

BEGIN;

-- 1. Add photo_path column to bons
ALTER TABLE bons ADD COLUMN IF NOT EXISTS photo_path TEXT NULL;

COMMENT ON COLUMN bons.photo_path IS 'Path inside the bon-photos Storage bucket. NULL = no photo. Use storage.from(bon-photos).getPublicUrl(path) to get a viewable URL.';

-- 2. Create the public bucket (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('bon-photos', 'bon-photos', true, 10485760, ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif'])
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif'];

-- 3. RLS — same single-tenant pattern as the rest of the app:
--    anonymous SELECT (so public.maderadeco.app can render <img src> without auth),
--    authenticated INSERT/UPDATE/DELETE for the app itself.
DO $$ BEGIN
  -- Drop existing policies if they exist so we can re-create cleanly
  EXECUTE 'DROP POLICY IF EXISTS "bon_photos_anon_read" ON storage.objects';
  EXECUTE 'DROP POLICY IF EXISTS "bon_photos_auth_write" ON storage.objects';
END $$;

CREATE POLICY "bon_photos_anon_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'bon-photos');

CREATE POLICY "bon_photos_auth_write"
  ON storage.objects FOR ALL
  TO authenticated
  USING (bucket_id = 'bon-photos')
  WITH CHECK (bucket_id = 'bon-photos');

COMMIT;
