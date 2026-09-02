-- ============================================================
-- 052_meta_lead_ads.sql — Meta (Facebook / Instagram) Lead Ads
--
-- Adds `meta_lead_pages` (one row per connected Facebook Page whose
-- Lead Ads forms feed this CRM) and `meta_leads` (one row per lead
-- Meta delivered — an audit trail independent of the contact it
-- resolved to, mirroring lead_form_submissions from migration 046).
--
-- How a lead arrives
--   Meta's Webhooks product POSTs a `leadgen` change for the Page
--   (object: "page") carrying only ids — page_id, form_id, leadgen_id.
--   The webhook route resolves the page row by `page_id`, decrypts its
--   stored Page access token, fetches the lead's field_data from the
--   Graph API, and runs it through the same find-or-create contact
--   path as web forms. Which is why `page_id` is UNIQUE across the
--   whole deployment: the webhook has no tenant in hand, the page id
--   *is* the tenant lookup key.
--
-- Trust model
--   Page access tokens are secrets (they can read every lead the Page
--   ever received, and post as the Page). They're stored AES-256-GCM
--   encrypted with ENCRYPTION_KEY exactly like whatsapp_config.access_token
--   and are never returned to the browser — the list route strips them.
--   RLS protects the dashboard-facing surface only; the webhook route
--   writes through the service-role client, same as web forms.
--
-- Why both organization_id and account_id
--   Same as lead_forms (046): account_id is what application code sets
--   on INSERT, and the sync_organization_id_from_account trigger from
--   043 derives organization_id — no new plumbing.
--
-- RLS role thresholds
--   meta_lead_pages: SELECT at base membership; INSERT/UPDATE/DELETE at
--   organization_admin — connecting a Page is "configure an external
--   integration", same tier as lead_forms / webhook_endpoints.
--   meta_leads: SELECT only, at base membership. Written exclusively by
--   the webhook / sync routes through the service-role client.
--
-- contacts.source
--   Adds the value 'meta_ads' to the app-validated set (manual |
--   whatsapp | web_form | import | api | meta_ads). The column is plain
--   text with no CHECK constraint (046), so no DDL is needed for it —
--   this comment is the record that the set grew.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- META_LEAD_PAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_lead_pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id               text NOT NULL,                 -- Facebook Page id (numeric string)
  page_name             text NOT NULL,
  -- AES-256-GCM ciphertext (lib/whatsapp/encryption.ts). Never sent to the client.
  page_access_token     text NOT NULL,
  status                text NOT NULL DEFAULT 'active', -- active | paused (app-validated)
  -- Whether POST /{page_id}/subscribed_apps (field: leadgen) succeeded
  -- at connect time. False = Meta will not push leads for this Page
  -- until an admin re-subscribes (Sync still works via polling).
  webhook_subscribed    boolean NOT NULL DEFAULT false,
  -- Segment tag applied to every contact created/matched from this
  -- Page's leads (same idea as lead_forms.tag_id, migration 047).
  tag_id                uuid REFERENCES tags(id) ON DELETE SET NULL,
  lead_count            integer NOT NULL DEFAULT 0,
  last_lead_at          timestamptz,
  last_synced_at        timestamptz,
  connected_by          uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_pages_organization_id ON meta_lead_pages(organization_id);
CREATE INDEX IF NOT EXISTS idx_meta_lead_pages_account_id ON meta_lead_pages(account_id);

ALTER TABLE meta_lead_pages ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON meta_lead_pages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meta_lead_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS sync_organization_id_trigger ON meta_lead_pages;
CREATE TRIGGER sync_organization_id_trigger
  BEFORE INSERT OR UPDATE OF account_id ON meta_lead_pages
  FOR EACH ROW EXECUTE FUNCTION sync_organization_id_from_account();

DROP POLICY IF EXISTS meta_lead_pages_select ON meta_lead_pages;
CREATE POLICY meta_lead_pages_select ON meta_lead_pages FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS meta_lead_pages_insert ON meta_lead_pages;
CREATE POLICY meta_lead_pages_insert ON meta_lead_pages FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS meta_lead_pages_update ON meta_lead_pages;
CREATE POLICY meta_lead_pages_update ON meta_lead_pages FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS meta_lead_pages_delete ON meta_lead_pages;
CREATE POLICY meta_lead_pages_delete ON meta_lead_pages FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

COMMENT ON COLUMN meta_lead_pages.page_access_token IS
  'Encrypted (AES-256-GCM, ENCRYPTION_KEY) Page access token with leads_retrieval. Never exposed to the client.';
COMMENT ON COLUMN meta_lead_pages.tag_id IS
  'Segment tag applied to every contact produced by this Page''s Lead Ads. NULL = create one named after the Page on next connect/lead.';

-- ============================================================
-- META_LEADS
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_row_id       uuid NOT NULL REFERENCES meta_lead_pages(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Meta's lead id. UNIQUE so a webhook retry or an overlapping Sync
  -- can never double-create — the insert conflicts and the processor
  -- treats it as "already handled".
  leadgen_id        text NOT NULL,
  form_id           text,
  form_name         text,
  ad_id             text,
  ad_name           text,
  adset_id          text,
  adset_name        text,
  campaign_id       text,
  campaign_name     text,
  platform          text,                     -- fb | ig (as reported by Meta)
  is_organic        boolean,
  -- Raw Meta field_data: [{ name, values: [...] }] — the full form
  -- answers, including anything that didn't map onto a contact column.
  field_data        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Extracted contact fields, for display without re-parsing field_data.
  full_name         text,
  phone             text,
  email             text,
  -- processed | no_phone | invalid_phone | failed (app-validated)
  status            text NOT NULL DEFAULT 'processed',
  error             text,
  received_via      text NOT NULL DEFAULT 'webhook',   -- webhook | sync
  lead_created_at   timestamptz,               -- Meta's created_time
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leadgen_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_leads_page_row_id ON meta_leads(page_row_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_leads_organization_id ON meta_leads(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_leads_contact_id ON meta_leads(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE meta_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_leads_select ON meta_leads;
CREATE POLICY meta_leads_select ON meta_leads FOR SELECT
  USING (is_organization_member(organization_id));

-- No INSERT/UPDATE/DELETE policy for authenticated roles on meta_leads:
-- rows are written only by the webhook / sync routes' service-role
-- client (same posture as lead_form_submissions / automation_logs).

-- ============================================================
-- lead_count increment — atomic, callable from the service-role client
-- (same convention as increment_lead_form_submit_count, 046).
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_meta_lead_page_count(p_page_row_id uuid, p_lead_at timestamptz)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE meta_lead_pages
  SET lead_count = lead_count + 1,
      last_lead_at = GREATEST(COALESCE(last_lead_at, p_lead_at), p_lead_at)
  WHERE id = p_page_row_id;
$$;

ALTER FUNCTION public.increment_meta_lead_page_count(uuid, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.increment_meta_lead_page_count(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_meta_lead_page_count(uuid, timestamptz) TO authenticated, service_role;
