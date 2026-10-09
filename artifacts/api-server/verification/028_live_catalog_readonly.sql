-- Optional read-only SQL Editor diagnostics; this does NOT apply 028.
-- REST exposes columns/RPC arguments, not live stored function bodies.
SELECT p.oid::regprocedure::text AS signature,
  pg_get_functiondef(p.oid) AS definition,p.proacl AS grants
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f' AND p.proname='capture_sms_inbound'
ORDER BY p.pronargs;

-- Inspect all public functions/views touching conversations for alias-qualified
-- or unqualified created_at references. Matches require human scope review:
-- the same function/view can legitimately reference messages.created_at.
SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f'
  AND pg_get_functiondef(p.oid)~* '\mconversations\M'
  AND pg_get_functiondef(p.oid)~* '\mcreated_at\M';
SELECT schemaname,viewname,definition FROM pg_views
WHERE schemaname='public' AND definition~* '\mconversations\M' AND definition~* '\mcreated_at\M';
SELECT schemaname,matviewname,definition FROM pg_matviews
WHERE schemaname='public' AND definition~* '\mconversations\M' AND definition~* '\mcreated_at\M';

SELECT table_name,column_name,data_type,is_nullable,column_default
FROM information_schema.columns WHERE table_schema='public'
ORDER BY table_name,ordinal_position;
