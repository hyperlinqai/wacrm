-- ============================================================
-- 046_web_forms.sql — Web Forms lead-capture module
--
-- Adds `lead_forms` (one row per embeddable form, organization-owned)
-- and `lead_form_submissions` (one row per public POST, an audit trail
-- independent of the contact it resolved to), plus `contacts.source` /
-- `contacts.source_form_id` so a lead captured through a form is
-- visibly attributable in the UI.
--
-- Why this feature needs its own public-facing trust model
--   Every other write path in this schema is either session-authenticated
--   (RLS via organization_members) or API-key-authenticated
--   (requireApiKey, migration-042-era). This module's whole point is a
--   `<script>` tag pasted into a landing page outside this app's control,
--   which means the form's public id sits in plaintext in that page's
--   HTML source — anyone can view-source it. It is therefore treated as
--   a non-secret public identifier (the same trust model as a Google
--   Forms/Typeform form id), NOT as a credential to hash/rotate like an
--   API key or invitation token. Protection against abuse comes from
--   app-layer rate limiting + a honeypot field (see the submit route),
--   not from unguessability. RLS on both tables below exists purely to
--   protect the *dashboard-facing* read/write surface — the public
--   submit endpoint always writes via the service-role client, same as
--   the WhatsApp webhook route.
--
-- Why lead_forms carries both organization_id and account_id
--   Mirrors the 24 tables from migration 043: account_id is what
--   application code sets on INSERT (the dashboard's create route
--   resolves it from the caller's profile, same as automations/
--   webhook_endpoints), and the BEFORE INSERT/UPDATE OF account_id
--   trigger installed by 043 (sync_organization_id_from_account)
--   derives organization_id automatically — zero new plumbing needed
--   for that half of the write path.
--
-- Why lead_form_submissions is organization_id-native, no account_id
--   Unlike the 24 tables from 043, this table has no legacy
--   pre-organization existence — it's new in this migration — so
--   there's no account_id mirror to maintain. The submit route already
--   has organization_id in hand (from the lead_forms row it just read),
--   so it's set directly on INSERT rather than trigger-derived.
--
-- RLS role thresholds
--   lead_forms: SELECT at base membership (any team member doing
--   day-to-day lead follow-up can see which forms exist and how many
--   leads they've produced), INSERT/UPDATE/DELETE require
--   'organization_admin' — creating/editing a form is "configure a
--   public-facing integration" (externally-visible blast radius if
--   misconfigured: a live landing page starts rejecting submissions, or
--   captures the wrong fields), closer to webhook_endpoints/api_keys
--   than to routine contact/deal editing (which is agent-writable).
--   lead_form_submissions: SELECT only, same membership level as
--   lead_forms — never written by an authenticated session, only by the
--   public submit route's service-role client (same posture as
--   automation_logs).
--
-- contacts.source / contacts.source_form_id
--   No source/origin concept existed on contacts before this migration
--   (confirmed against every prior migration and the Contact type).
--   New column, plain text (app-validated: manual | whatsapp | web_form
--   | import | api — matches the no-enum-for-status-like-columns
--   convention already established by organizations.status), default
--   'manual'. This default is a simplification for EXISTING rows, not a
--   claim of historical accuracy — a real backfill would need to
--   inspect message history per contact, out of scope here. Other
--   existing write paths (webhook, /api/v1/contacts, manual add, CSV
--   import) are NOT touched in this migration and keep implicitly
--   writing 'manual' until each is separately updated to pass an
--   explicit source — 'web_form' is simply the only immediately-accurate
--   value produced by any path on day one. Harmless, not a data
--   integrity issue: source is informational/display-only.
--
-- Idempotent — safe to run multiple times, matching every migration
-- since 017.
-- ============================================================

-- ============================================================
-- LEAD_FORMS
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_forms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name              text NOT NULL,                   -- internal label, never shown publicly
  status            text NOT NULL DEFAULT 'active',   -- active | paused | archived (app-validated, no enum)
  -- Ordered array of {id, type, label, placeholder, required, options?}.
  -- type in ('text','email','phone','textarea','select'). The submit
  -- route maps the 'phone'/'email'-typed field values onto
  -- contacts.phone/contacts.email; everything else lands only in
  -- lead_form_submissions.payload. The dashboard builder is responsible
  -- for enforcing exactly one 'phone' field per form (findOrCreateContact
  -- requires a phone) — not enforced at the DB layer, same as other
  -- jsonb-shaped config columns in this schema (trigger_config, etc).
  fields            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- {primaryColor, buttonText, fontFamily, borderRadius, successMessage}
  style             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NULL/empty = allow submissions from any origin (default — matches
  -- the "public form id is not a secret" trust model). Non-empty = an
  -- origin allow-list the submit route checks the request's Origin
  -- header against, an optional extra safety net.
  allowed_domains   text[],
  submit_count      integer NOT NULL DEFAULT 0,
  created_by        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_forms_organization_id ON lead_forms(organization_id);
CREATE INDEX IF NOT EXISTS idx_lead_forms_account_id ON lead_forms(account_id);

ALTER TABLE lead_forms ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON lead_forms;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lead_forms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS sync_organization_id_trigger ON lead_forms;
CREATE TRIGGER sync_organization_id_trigger
  BEFORE INSERT OR UPDATE OF account_id ON lead_forms
  FOR EACH ROW EXECUTE FUNCTION sync_organization_id_from_account();

DROP POLICY IF EXISTS lead_forms_select ON lead_forms;
CREATE POLICY lead_forms_select ON lead_forms FOR SELECT
  USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS lead_forms_insert ON lead_forms;
CREATE POLICY lead_forms_insert ON lead_forms FOR INSERT
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS lead_forms_update ON lead_forms;
CREATE POLICY lead_forms_update ON lead_forms FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'));
DROP POLICY IF EXISTS lead_forms_delete ON lead_forms;
CREATE POLICY lead_forms_delete ON lead_forms FOR DELETE
  USING (is_organization_member(organization_id, 'organization_admin'));

-- ============================================================
-- LEAD_FORM_SUBMISSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_form_submissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_form_id      uuid NOT NULL REFERENCES lead_forms(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- raw submitted field values (honeypot stripped)
  ip_address        text,
  user_agent        text,
  referrer          text,       -- landing-page URL the widget was embedded on
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_lead_form_id ON lead_form_submissions(lead_form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_organization_id ON lead_form_submissions(organization_id);

ALTER TABLE lead_form_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_form_submissions_select ON lead_form_submissions;
CREATE POLICY lead_form_submissions_select ON lead_form_submissions FOR SELECT
  USING (is_organization_member(organization_id));

-- No INSERT/UPDATE/DELETE policy for any authenticated role on either
-- table beyond what's declared above — lead_forms mutations go through
-- the organization_admin-gated policies; lead_form_submissions rows are
-- written exclusively by the public submit route's service-role client
-- (RLS-bypassing), matching automation_logs' read-only-via-RLS posture.

-- ============================================================
-- CONTACTS — source attribution
-- ============================================================
-- ============================================================
-- submit_count increment — atomic, callable from the service-role
-- client (same convention as increment_automation_execution_count in
-- migration 038): avoids a read-then-write race across concurrent
-- submissions to a popular form.
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_lead_form_submit_count(p_lead_form_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE lead_forms SET submit_count = submit_count + 1 WHERE id = p_lead_form_id;
$$;

ALTER FUNCTION public.increment_lead_form_submit_count(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.increment_lead_form_submit_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_lead_form_submit_count(uuid) TO authenticated, service_role;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_form_id uuid REFERENCES lead_forms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_source_form_id ON contacts(source_form_id) WHERE source_form_id IS NOT NULL;
