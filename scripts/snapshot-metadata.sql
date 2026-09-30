-- Optional, one-time setup in the project's Supabase SQL Editor.
-- Only the service role may call this read-only catalog function.
-- Does not create/backfill a migration ledger or claim manual SQL was recorded.
CREATE OR REPLACE FUNCTION public.platform_snapshot_metadata()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tables_json jsonb;
  ledger regclass;
  ledger_source text;
  ledger_columns text[];
  ledger_select text;
  migrations_json jsonb := '[]'::jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(t.obj ORDER BY t.name), '[]'::jsonb)
  INTO tables_json
  FROM (
    SELECT c.relname AS name, jsonb_build_object(
      'name', c.relname,
      'columns', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod)
        ) ORDER BY a.attnum), '[]'::jsonb)
        FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      )
    ) AS obj
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ) t;

  FOREACH ledger_source IN ARRAY ARRAY[
    'supabase_migrations.schema_migrations',
    'public.schema_migrations',
    'public.migrations',
    'public._prisma_migrations'
  ] LOOP
    ledger := to_regclass(ledger_source);
    IF ledger IS NULL THEN CONTINUE; END IF;
    -- Read only identity/time fields; never SQL statements, checksums, or logs.
    SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO ledger_columns
    FROM pg_attribute a
    WHERE a.attrelid = ledger AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname IN ('version', 'name', 'id', 'migration_name',
                       'applied_at', 'executed_at', 'finished_at', 'rolled_back_at');
    IF ledger_columns IS NULL THEN CONTINUE; END IF;
    SELECT string_agg(format('%I', col), ', ') INTO ledger_select
    FROM unnest(ledger_columns) col;
    EXECUTE format(
      'SELECT coalesce(jsonb_agg(to_jsonb(m)), ''[]''::jsonb) FROM (SELECT %s FROM %s) m',
      ledger_select, ledger
    ) INTO migrations_json;
    EXIT;
  END LOOP;

  RETURN jsonb_build_object(
    'tables', tables_json,
    'migration_source', CASE WHEN ledger IS NOT NULL AND ledger_columns IS NOT NULL
                             THEN ledger_source ELSE NULL END,
    'migrations', migrations_json
  );
END;
$$;

REVOKE ALL ON FUNCTION public.platform_snapshot_metadata() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_snapshot_metadata() TO service_role;