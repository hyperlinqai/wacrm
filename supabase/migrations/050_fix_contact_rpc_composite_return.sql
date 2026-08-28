-- ============================================================
-- 050_fix_contact_rpc_composite_return.sql — return jsonb, not a
-- bare composite row, from filter_contacts / filter_contacts_by_tags
--
-- Both RPCs were written for supabase-js/PostgREST, which auto-decodes
-- a `RETURNS TABLE (contact contacts, ...)` composite column into a
-- JS object. This app no longer talks to PostgREST — since the
-- direct-Postgres migration (040/041-era, see src/lib/db) RPCs run as
-- plain `SELECT * FROM fn(...)` over `pg`, and `pg` has no built-in
-- decoder for a table's anonymous composite type (only for scalars and
-- jsonb). The result: every "contact" column value arrived as node-pg's
-- raw composite-literal STRING (e.g. "(11111111-...,uuid,...)"), not
-- an object — so `row.contact.id` was `undefined` for every row.
--
-- Symptom on filter_contacts specifically (migration 049, the
-- Contacts-page filter bar): every <TableRow key={contact.id}> got
-- key={undefined}, hence React's "missing key" warning — and every
-- field in the table silently rendered as garbage/blank, not just the
-- key. filter_contacts_by_tags (025) has the identical defect; it has
-- no callers left in the app (the Contacts page now calls
-- filter_contacts for every filter, tags included) but is fixed here
-- too so it isn't a landmine for the next caller.
--
-- Fix: return `to_jsonb(c) AS contact` (jsonb) instead of `c AS
-- contact` (composite). `pg` decodes jsonb out of the box, so the
-- existing app code (`rows.map(r => r.contact)`) needs no changes.
-- Postgres can't change a function's return type via CREATE OR
-- REPLACE (existing convention in 045: DROP FUNCTION then CREATE).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);

CREATE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact jsonb, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT to_jsonb(c) AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) TO authenticated;

DROP FUNCTION IF EXISTS public.filter_contacts(text, boolean, uuid[], uuid[], text[], uuid, text, text, timestamptz, timestamptz, int, int);

CREATE FUNCTION public.filter_contacts(
  p_search          text        DEFAULT NULL,
  p_active          boolean     DEFAULT NULL,
  p_tag_ids         uuid[]      DEFAULT NULL,
  p_list_ids        uuid[]      DEFAULT NULL,
  p_sources         text[]      DEFAULT NULL,
  p_custom_field_id uuid        DEFAULT NULL,
  p_custom_op       text        DEFAULT 'is',
  p_custom_value    text        DEFAULT NULL,
  p_created_from    timestamptz DEFAULT NULL,
  p_created_to      timestamptz DEFAULT NULL,
  p_limit           int         DEFAULT 25,
  p_offset          int         DEFAULT 0
)
RETURNS TABLE (contact jsonb, total_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE (
        p_search IS NULL OR p_search = ''
        OR c.name    ILIKE '%' || p_search || '%'
        OR c.phone   ILIKE '%' || p_search || '%'
        OR c.email   ILIKE '%' || p_search || '%'
        OR c.company ILIKE '%' || p_search || '%'
      )
      AND (p_active IS NULL OR c.is_active = p_active)
      AND (
        p_sources IS NULL OR cardinality(p_sources) = 0
        OR c.source = ANY(p_sources)
      )
      AND (
        p_tag_ids IS NULL OR cardinality(p_tag_ids) = 0
        OR EXISTS (SELECT 1 FROM contact_tags ct
                   WHERE ct.contact_id = c.id AND ct.tag_id = ANY(p_tag_ids))
      )
      AND (
        p_list_ids IS NULL OR cardinality(p_list_ids) = 0
        OR EXISTS (SELECT 1 FROM contact_list_members m
                   WHERE m.contact_id = c.id AND m.list_id = ANY(p_list_ids))
      )
      AND (
        p_custom_field_id IS NULL
        OR CASE COALESCE(p_custom_op, 'is')
          WHEN 'is_set' THEN EXISTS (
            SELECT 1 FROM contact_custom_values v
            WHERE v.contact_id = c.id AND v.custom_field_id = p_custom_field_id
              AND COALESCE(v.value, '') <> '')
          WHEN 'is_empty' THEN NOT EXISTS (
            SELECT 1 FROM contact_custom_values v
            WHERE v.contact_id = c.id AND v.custom_field_id = p_custom_field_id
              AND COALESCE(v.value, '') <> '')
          WHEN 'is_not' THEN NOT EXISTS (
            SELECT 1 FROM contact_custom_values v
            WHERE v.contact_id = c.id AND v.custom_field_id = p_custom_field_id
              AND v.value = p_custom_value)
          WHEN 'contains' THEN EXISTS (
            SELECT 1 FROM contact_custom_values v
            WHERE v.contact_id = c.id AND v.custom_field_id = p_custom_field_id
              AND v.value ILIKE '%' || COALESCE(p_custom_value, '') || '%')
          ELSE EXISTS (
            SELECT 1 FROM contact_custom_values v
            WHERE v.contact_id = c.id AND v.custom_field_id = p_custom_field_id
              AND v.value = p_custom_value)
        END
      )
      AND (p_created_from IS NULL OR c.created_at >= p_created_from)
      AND (p_created_to   IS NULL OR c.created_at <  p_created_to)
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
  )
  SELECT to_jsonb(c) AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts(text, boolean, uuid[], uuid[], text[], uuid, text, text, timestamptz, timestamptz, int, int) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts(text, boolean, uuid[], uuid[], text[], uuid, text, text, timestamptz, timestamptz, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts(text, boolean, uuid[], uuid[], text[], uuid, text, text, timestamptz, timestamptz, int, int) TO authenticated, service_role;
