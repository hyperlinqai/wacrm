-- ============================================================
-- 049_contact_lists_and_activation.sql — contact lists + "active
-- contacts" rule + one server-side contact filter
--
-- Why
--   Businesses import far more contacts than they ever want to message
--   (a full exported phone book, an old lead sheet). Until now every
--   imported row was a first-class broadcast recipient. This migration
--   adds three things so a workspace can hold thousands of contacts
--   while only a chosen subset is "active":
--
--   1. contact_lists / contact_list_members — named, hand-curated
--      groups of contacts (an import can land directly in one). Lists
--      differ from tags on purpose: tags are settings-class labels
--      (admin-created, applied by automations/forms), lists are
--      day-to-day audience buckets any agent can create and fill.
--
--   2. contact_activation_rules — one row per organization saying who
--      counts as active: everyone (default, today's behaviour), only
--      members of chosen lists, or only holders of chosen tags. The
--      result is MATERIALISED into `contacts.is_active` by triggers so
--      the Contacts page, broadcasts and the public API can filter on
--      a plain boolean column instead of re-deriving membership. A
--      per-contact `activation_override` ('active' | 'inactive' | NULL)
--      pins a contact regardless of the rule — that is how "import
--      everything but mark this batch inactive" works.
--
--   3. filter_contacts() — replaces the tag-only
--      filter_contacts_by_tags() (kept, untouched) with one RPC that
--      applies every Contacts-page filter (search, active status,
--      tags, lists, source, custom-field rule, created range) in a
--      single query with a windowed total count, for the same
--      PostgREST-limit reasons migration 025 documents.
--
-- Trigger safety
--   * The contacts BEFORE trigger only fires on INSERT and on UPDATE OF
--     activation_override, so the is_active writes done by the refresh
--     functions never re-enter it.
--   * refresh_* functions are SECURITY DEFINER (owned by postgres) so a
--     membership row written by an agent can update the parent
--     contact's flag even though the agent's own session would also be
--     allowed to — this just keeps the trigger path independent of
--     RLS, the same reason sync_organization_id_from_account (043) is
--     DEFINER.
--   * Trigger names start with "wacrm_z" so they sort AFTER
--     sync_organization_id_trigger on the same event — organization_id
--     is resolved before the activation lookup needs it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- CONTACT_LISTS
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- creator (audit)
  name            text NOT NULL,
  description     text,
  color           text NOT NULL DEFAULT '#8b5cf6',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_lists_organization_id ON contact_lists(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_lists_account_id      ON contact_lists(account_id);
-- One list name per organization (case-insensitive) so "VIP" and "vip"
-- can't coexist and the import modal's "find or create by name" is safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_lists_org_name
  ON contact_lists (organization_id, lower(name));

ALTER TABLE contact_lists ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON contact_lists;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_lists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS sync_organization_id_trigger ON contact_lists;
CREATE TRIGGER sync_organization_id_trigger
  BEFORE INSERT OR UPDATE OF account_id ON contact_lists
  FOR EACH ROW EXECUTE FUNCTION sync_organization_id_from_account();

-- Lists are agent-writable (same threshold as contacts themselves):
-- curating an audience is routine contact work, not configuration.
DROP POLICY IF EXISTS contact_lists_select ON contact_lists;
CREATE POLICY contact_lists_select ON contact_lists FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS contact_lists_insert ON contact_lists;
CREATE POLICY contact_lists_insert ON contact_lists FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS contact_lists_update ON contact_lists;
CREATE POLICY contact_lists_update ON contact_lists FOR UPDATE
  USING (is_organization_member(organization_id, 'agent'));
DROP POLICY IF EXISTS contact_lists_delete ON contact_lists;
CREATE POLICY contact_lists_delete ON contact_lists FOR DELETE
  USING (is_organization_member(organization_id, 'agent'));

-- ============================================================
-- CONTACT_LIST_MEMBERS (many-to-many, child of contacts)
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_list_members (
  list_id    uuid NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_list_members_contact ON contact_list_members(contact_id);

ALTER TABLE contact_list_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_list_members_select ON contact_list_members;
CREATE POLICY contact_list_members_select ON contact_list_members FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_list_members.contact_id AND is_organization_member(c.organization_id))
);
DROP POLICY IF EXISTS contact_list_members_modify ON contact_list_members;
CREATE POLICY contact_list_members_modify ON contact_list_members FOR ALL USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_list_members.contact_id AND is_organization_member(c.organization_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_list_members.contact_id AND is_organization_member(c.organization_id, 'agent'))
);

-- ============================================================
-- CONTACT_ACTIVATION_RULES (one per organization)
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_activation_rules (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- everyone | lists | tags (app-validated + CHECK, no enum — matches
  -- organizations.status / contacts.source convention)
  mode            text NOT NULL DEFAULT 'everyone'
                  CHECK (mode IN ('everyone', 'lists', 'tags')),
  list_ids        uuid[] NOT NULL DEFAULT '{}',
  tag_ids         uuid[] NOT NULL DEFAULT '{}',
  updated_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contact_activation_rules ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON contact_activation_rules;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_activation_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS sync_organization_id_trigger ON contact_activation_rules;
CREATE TRIGGER sync_organization_id_trigger
  BEFORE INSERT OR UPDATE OF account_id ON contact_activation_rules
  FOR EACH ROW EXECUTE FUNCTION sync_organization_id_from_account();

-- Settings-class: changing the rule flips the reachable audience for
-- every broadcast, so writes are admin-only (same tier as tags).
DROP POLICY IF EXISTS contact_activation_rules_select ON contact_activation_rules;
CREATE POLICY contact_activation_rules_select ON contact_activation_rules FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS contact_activation_rules_insert ON contact_activation_rules;
CREATE POLICY contact_activation_rules_insert ON contact_activation_rules FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS contact_activation_rules_update ON contact_activation_rules;
CREATE POLICY contact_activation_rules_update ON contact_activation_rules FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS contact_activation_rules_delete ON contact_activation_rules;
CREATE POLICY contact_activation_rules_delete ON contact_activation_rules FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ============================================================
-- CONTACTS: materialised active flag + manual override
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS activation_override text
  CHECK (activation_override IN ('active', 'inactive'));

CREATE INDEX IF NOT EXISTS idx_contacts_org_active ON contacts(organization_id, is_active);

COMMENT ON COLUMN contacts.is_active IS
  'Derived: activation_override if set, else the organization''s contact_activation_rules. Maintained by triggers — do not write directly.';
COMMENT ON COLUMN contacts.activation_override IS
  'Manual pin: ''active'' / ''inactive'' beat the organization rule; NULL = follow the rule.';

-- Pure lookup: what SHOULD is_active be for this contact right now.
CREATE OR REPLACE FUNCTION public.contact_effective_active(
  p_contact_id      uuid,
  p_organization_id uuid,
  p_override        text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_override = 'active'   THEN true
    WHEN p_override = 'inactive' THEN false
    ELSE COALESCE((
      SELECT CASE r.mode
        WHEN 'lists' THEN EXISTS (
          SELECT 1 FROM contact_list_members m
          WHERE m.contact_id = p_contact_id AND m.list_id = ANY(r.list_ids))
        WHEN 'tags' THEN EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = p_contact_id AND ct.tag_id = ANY(r.tag_ids))
        ELSE true
      END
      FROM contact_activation_rules r
      WHERE r.organization_id = p_organization_id
    ), true)
  END;
$$;
ALTER FUNCTION public.contact_effective_active(uuid, uuid, text) OWNER TO postgres;

-- Recompute is_active for a set of contacts (membership changed).
CREATE OR REPLACE FUNCTION public.refresh_contact_activation(p_contact_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE contacts c
  SET is_active = contact_effective_active(c.id, c.organization_id, c.activation_override)
  WHERE c.id = ANY(p_contact_ids)
    AND c.is_active IS DISTINCT FROM
        contact_effective_active(c.id, c.organization_id, c.activation_override);
$$;
ALTER FUNCTION public.refresh_contact_activation(uuid[]) OWNER TO postgres;

-- Recompute is_active for every contact in an organization (rule changed).
CREATE OR REPLACE FUNCTION public.refresh_org_contact_activation(p_organization_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE contacts c
  SET is_active = contact_effective_active(c.id, c.organization_id, c.activation_override)
  WHERE c.organization_id = p_organization_id
    AND c.is_active IS DISTINCT FROM
        contact_effective_active(c.id, c.organization_id, c.activation_override);
$$;
ALTER FUNCTION public.refresh_org_contact_activation(uuid) OWNER TO postgres;

-- contacts: compute on INSERT and whenever the override is edited.
CREATE OR REPLACE FUNCTION public.wacrm_contact_activation_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.is_active := contact_effective_active(NEW.id, NEW.organization_id, NEW.activation_override);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.wacrm_contact_activation_before_write() OWNER TO postgres;

DROP TRIGGER IF EXISTS wacrm_z_contact_activation ON contacts;
CREATE TRIGGER wacrm_z_contact_activation
  BEFORE INSERT OR UPDATE OF activation_override ON contacts
  FOR EACH ROW EXECUTE FUNCTION wacrm_contact_activation_before_write();

-- contact_tags / contact_list_members: a membership row changed → the
-- parent contact may have crossed the rule boundary.
CREATE OR REPLACE FUNCTION public.wacrm_membership_refresh_activation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM refresh_contact_activation(ARRAY[COALESCE(NEW.contact_id, OLD.contact_id)]);
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.wacrm_membership_refresh_activation() OWNER TO postgres;

DROP TRIGGER IF EXISTS wacrm_z_refresh_activation ON contact_tags;
CREATE TRIGGER wacrm_z_refresh_activation
  AFTER INSERT OR DELETE ON contact_tags
  FOR EACH ROW EXECUTE FUNCTION wacrm_membership_refresh_activation();

DROP TRIGGER IF EXISTS wacrm_z_refresh_activation ON contact_list_members;
CREATE TRIGGER wacrm_z_refresh_activation
  AFTER INSERT OR DELETE ON contact_list_members
  FOR EACH ROW EXECUTE FUNCTION wacrm_membership_refresh_activation();

-- contact_activation_rules: the rule changed → recompute the whole org.
CREATE OR REPLACE FUNCTION public.wacrm_rule_refresh_activation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM refresh_org_contact_activation(COALESCE(NEW.organization_id, OLD.organization_id));
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.wacrm_rule_refresh_activation() OWNER TO postgres;

DROP TRIGGER IF EXISTS wacrm_z_refresh_activation ON contact_activation_rules;
CREATE TRIGGER wacrm_z_refresh_activation
  AFTER INSERT OR UPDATE OR DELETE ON contact_activation_rules
  FOR EACH ROW EXECUTE FUNCTION wacrm_rule_refresh_activation();

-- Deleting a list/tag that a rule references: prune it from the rule
-- (arrays can't carry an FK). The rule UPDATE then recomputes the org.
CREATE OR REPLACE FUNCTION public.wacrm_prune_activation_rule_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'contact_lists' THEN
    UPDATE contact_activation_rules
    SET list_ids = array_remove(list_ids, OLD.id)
    WHERE organization_id = OLD.organization_id AND OLD.id = ANY(list_ids);
  ELSE
    UPDATE contact_activation_rules
    SET tag_ids = array_remove(tag_ids, OLD.id)
    WHERE organization_id = OLD.organization_id AND OLD.id = ANY(tag_ids);
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.wacrm_prune_activation_rule_refs() OWNER TO postgres;

DROP TRIGGER IF EXISTS wacrm_z_prune_activation_rule ON contact_lists;
CREATE TRIGGER wacrm_z_prune_activation_rule
  AFTER DELETE ON contact_lists
  FOR EACH ROW EXECUTE FUNCTION wacrm_prune_activation_rule_refs();

DROP TRIGGER IF EXISTS wacrm_z_prune_activation_rule ON tags;
CREATE TRIGGER wacrm_z_prune_activation_rule
  AFTER DELETE ON tags
  FOR EACH ROW EXECUTE FUNCTION wacrm_prune_activation_rule_refs();

-- ============================================================
-- RPC: filter_contacts — every Contacts-page filter in one query
-- ============================================================
-- SECURITY INVOKER: RLS on contacts / contact_tags / contact_list_members /
-- contact_custom_values scopes everything to the caller's organization.
-- Array params: NULL or empty = "no filter on this dimension".
-- p_custom_op: is | is_not | contains | is_set | is_empty
CREATE OR REPLACE FUNCTION public.filter_contacts(
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
RETURNS TABLE (contact contacts, total_count bigint)
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
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts(text, boolean, uuid[], uuid[], text[], uuid, text, text, timestamptz, timestamptz, int, int) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts(text, boolean, uuid[], uuid[], text[], uuid, text, text, timestamptz, timestamptz, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts(text, boolean, uuid[], uuid[], text[], uuid, text, text, timestamptz, timestamptz, int, int) TO authenticated, service_role;

-- ============================================================
-- RPC: contact_list_counts — member count per visible list
-- ============================================================
CREATE OR REPLACE FUNCTION public.contact_list_counts()
RETURNS TABLE (list_id uuid, member_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT l.id, count(m.contact_id)
  FROM contact_lists l
  LEFT JOIN contact_list_members m ON m.list_id = l.id
  GROUP BY l.id;
$$;
ALTER FUNCTION public.contact_list_counts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.contact_list_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.contact_list_counts() TO authenticated, service_role;

-- ============================================================
-- RPC: preview_activation_rule — "N of M would be active" before saving
-- ============================================================
CREATE OR REPLACE FUNCTION public.preview_activation_rule(
  p_mode     text,
  p_list_ids uuid[] DEFAULT '{}',
  p_tag_ids  uuid[] DEFAULT '{}'
)
RETURNS TABLE (total_count bigint, active_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    count(*) AS total_count,
    count(*) FILTER (WHERE
      c.activation_override = 'active'
      OR (
        c.activation_override IS NULL
        AND CASE p_mode
          WHEN 'lists' THEN EXISTS (
            SELECT 1 FROM contact_list_members m
            WHERE m.contact_id = c.id AND m.list_id = ANY(COALESCE(p_list_ids, '{}')))
          WHEN 'tags' THEN EXISTS (
            SELECT 1 FROM contact_tags ct
            WHERE ct.contact_id = c.id AND ct.tag_id = ANY(COALESCE(p_tag_ids, '{}')))
          ELSE true
        END
      )
    ) AS active_count
  FROM contacts c;
$$;
ALTER FUNCTION public.preview_activation_rule(text, uuid[], uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_activation_rule(text, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_activation_rule(text, uuid[], uuid[]) TO authenticated, service_role;
