-- 040_direct_postgres.sql
--
-- Support for the direct-Postgres data layer that replaces supabase-js:
--
--   1. auth.users.sessions_revoked_at — backs signOut({ scope: 'global' })
--      now that sessions are stateless JWTs: tokens issued before this
--      timestamp are rejected by the app's session check.
--   2. pg_notify triggers on the five tables the UI subscribes to live
--      (previously Supabase Realtime / logical replication). The payload
--      carries only routing keys; the SSE endpoint refetches the row
--      under the subscriber's own RLS context before delivering it, so
--      row visibility rules still apply to live events.

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz;

CREATE OR REPLACE FUNCTION public.wacrm_notify_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec jsonb;
BEGIN
  rec := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  PERFORM pg_notify('wacrm_changes', jsonb_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'keys', jsonb_strip_nulls(jsonb_build_object(
      'id',              rec -> 'id',
      'user_id',         rec -> 'user_id',
      'account_id',      rec -> 'account_id',
      'conversation_id', rec -> 'conversation_id'
    ))
  )::text);
  RETURN NULL;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'messages', 'conversations', 'notifications', 'member_presence', 'message_reactions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS wacrm_notify_change ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER wacrm_notify_change
         AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.wacrm_notify_change()', t);
  END LOOP;
END;
$$;
