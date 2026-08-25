-- ============================================================
-- 048_contacts_notify.sql — emit change events for contacts
--
-- The "New Contact Created" automation trigger used to fire only from
-- the WhatsApp webhook (a contact auto-created by an inbound message).
-- Contacts added by hand, via CSV import, a web form or the public API
-- never triggered it. Emitting the standard wacrm_changes NOTIFY for
-- contacts lets one server-side listener (lib/automations/
-- contact-created-listener.ts) fire the trigger for EVERY creation
-- path, including direct SQL.
--
-- Also adds `source` to the notify payload keys (null for tables
-- without the column) so listeners can tell where a contact came from.
-- ============================================================

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
    'op',    TG_OP,
    'keys',  jsonb_strip_nulls(jsonb_build_object(
      'id',              rec -> 'id',
      'user_id',         rec -> 'user_id',
      'account_id',      rec -> 'account_id',
      'conversation_id', rec -> 'conversation_id',
      'source',          rec -> 'source'
    ))
  )::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS wacrm_notify_change ON public.contacts;
CREATE TRIGGER wacrm_notify_change
  AFTER INSERT OR UPDATE OR DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.wacrm_notify_change();
