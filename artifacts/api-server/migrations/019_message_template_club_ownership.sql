-- Apply manually in the existing external Supabase SQL Editor.
-- The operator explicitly chose PB Club as owner of the legacy global templates.
-- Existing template IDs, text, flags, and timestamps must remain unchanged.
-- No messages, candidates, approvals, sending settings, or audit tables are written.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id);

CREATE TEMP TABLE message_template_ownership_before ON COMMIT DROP AS
  SELECT id, club_id, to_jsonb(t)-'club_id' AS original_fields
  FROM public.message_templates t;

DO $migration$
DECLARE target_club uuid;
BEGIN
  BEGIN
    SELECT id INTO STRICT target_club FROM public.clubs WHERE slug='pb-club';
  EXCEPTION WHEN no_data_found OR too_many_rows THEN
    RAISE EXCEPTION 'Exactly one pb-club must exist; no template ownership changes committed';
  END;
  UPDATE public.message_templates SET club_id=target_club WHERE club_id IS NULL;

  -- Refuse unexpected trigger side effects rather than rewriting history or
  -- disabling triggers. Any failure rolls back the entire migration.
  IF EXISTS(
    SELECT 1 FROM message_template_ownership_before b
    FULL JOIN public.message_templates t ON t.id=b.id
    WHERE b.id IS NULL OR t.id IS NULL
      OR (to_jsonb(t)-'club_id') IS DISTINCT FROM b.original_fields
      OR t.club_id IS DISTINCT FROM COALESCE(b.club_id,target_club)
  ) THEN
    RAISE EXCEPTION 'Template fields or existing ownership changed unexpectedly; migration rolled back';
  END IF;
END $migration$;

CREATE INDEX IF NOT EXISTS message_templates_club_id_idx
  ON public.message_templates(club_id);
NOTIFY pgrst, 'reload schema';
COMMIT;

-- Read-only confirmation, including the columns checked before publishing.
SELECT id,club_id,name,body,use_case_tags,is_builtin
FROM public.message_templates ORDER BY id;
