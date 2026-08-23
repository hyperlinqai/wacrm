-- ============================================================
-- 043_organization_id.sql — Tenant ownership columns (SaaS Phase 2)
--
-- Adds `organization_id` to every table that currently carries a
-- direct `account_id` column — 24 tables, verified against the live
-- schema (docs/phase0-audit/01-schema-catalog.md), not assumed. This
-- is schema-only: no RLS policy changes, no application query
-- changes. Nothing that already works today changes behavior.
--
-- Why these 24 tables and no others
--   `organization_id` mirrors `account_id`'s existing footprint
--   exactly. Tables that were never `account_id`-scoped by column
--   (contact_tags, contact_custom_values, messages, message_reactions,
--   pipeline_stages, automation_steps, flow_nodes, flow_run_events,
--   broadcast_recipients — all scoped via a parent-table join instead,
--   migration 017) stay that way here too. `accounts`/`profiles`/
--   `account_invitations` are the identity/membership layer itself,
--   already bridged to organizations/organization_members in
--   migration 042 — adding organization_id *to* them would be
--   circular. `schema_migrations` carries no tenant data.
--
-- Backfill
--   Join-based via each row's own account_id -> organizations
--   .legacy_account_id (NOT a single hardcoded org id — self-hosted
--   installs may have more than one existing account; the live DB
--   Phase 0 audited has 2). Before SET NOT NULL, a hard gate counts
--   remaining NULLs across all 24 tables and RAISE EXCEPTIONs
--   (aborting the whole migration transaction) if any remain, rather
--   than silently assigning a fallback. A NULL surviving the backfill
--   would mean some row's account_id doesn't resolve to an
--   organizations row — i.e. migration 042's own backfill missed
--   something — and that needs to be fixed there, not papered over
--   here.
--
-- Why this migration is safe to apply with ZERO application changes
--   Making organization_id NOT NULL is only safe for existing rows —
--   application code today never sets it (it doesn't know the column
--   exists yet, per the agreed Phase 2 scope: plumbing only, no route
--   changes this phase). Verified locally: an INSERT that sets only
--   account_id (exactly what every existing route does) fails the
--   NOT NULL constraint outright with no trigger in place. A
--   BEFORE INSERT OR UPDATE OF account_id trigger
--   (sync_organization_id_from_account, one function shared across
--   all 24 tables, same pattern as 040's wacrm_notify_change) derives
--   organization_id from account_id transparently on every write, so
--   existing INSERT/UPDATE statements that only know about account_id
--   keep working unmodified — this is what actually makes "add
--   organization_id everywhere, NOT NULL, no app changes" true rather
--   than a production-breaking migration.
--
-- ON DELETE behavior
--   RESTRICT, not CASCADE. Deliberately different from account_id's
--   ON DELETE CASCADE (migration 017) — organization deletion is a
--   controlled SaaS operation (export/archive, then an explicit
--   scoped purge), not a side effect of one DELETE statement wiping
--   a tenant's entire dataset.
--
-- Indexes
--   A plain btree on organization_id on all 24 tables (the query
--   pattern every one of them will eventually need). Composite/unique
--   indexes are added only where the existing account_id index set
--   already has one to mirror (checked against live pg_indexes, not
--   guessed) — see inline comments at each CREATE INDEX below.
--
-- Prerequisite
--   Requires migration 042 (organizations/organization_members) to
--   already be applied — the backfill below reads `organizations
--   .legacy_account_id`, which only exists after 042.
--
-- Idempotent — safe to run multiple times. Columns/indexes use
-- IF NOT EXISTS; the backfill only updates rows still NULL; SET NOT
-- NULL is a no-op on an already-NOT-NULL column.
-- ============================================================

-- ============================================================
-- COLUMNS — nullable for now, FK attached immediately (a nullable
-- column with a FK is valid Postgres; NULLs are simply exempt from
-- the FK check until backfilled and locked down below).
-- ============================================================
ALTER TABLE contacts                       ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE tags                           ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE custom_fields                  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE contact_notes                  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE conversations                  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE whatsapp_config                ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE message_templates              ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE pipelines                      ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE deals                          ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE broadcasts                     ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE automations                    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE automation_logs                ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE automation_pending_executions  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE flows                          ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE flow_runs                      ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE member_presence                ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE api_keys                       ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE webhook_endpoints              ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE notifications                  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE quick_replies                  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE ai_configs                     ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE ai_knowledge_documents         ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE ai_knowledge_chunks            ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE ai_usage_log                   ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT;

-- ============================================================
-- AUTO-POPULATE TRIGGER — the actual "zero application changes"
-- mechanism (see header note above). Existing app code inserts/
-- updates these 24 tables knowing only about account_id; this
-- trigger derives organization_id from it transparently, the same
-- way 042's sync triggers keep organizations/organization_members
-- converged with accounts/profiles. Installed BEFORE the backfill
-- below so it's already active for any write that happens to race
-- with this migration.
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_organization_id_from_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id)
  THEN
    SELECT id INTO NEW.organization_id
    FROM public.organizations
    WHERE legacy_account_id = NEW.account_id;

    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION
        'No organization found for account_id % on table % — organizations.legacy_account_id is missing this account (check migration 042''s sync)',
        NEW.account_id, TG_TABLE_NAME;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_organization_id_from_account() OWNER TO postgres;

DO $$
DECLARE
  t TEXT;
  v_tables TEXT[] := ARRAY[
    'contacts', 'tags', 'custom_fields', 'contact_notes', 'conversations',
    'whatsapp_config', 'message_templates', 'pipelines', 'deals', 'broadcasts',
    'automations', 'automation_logs', 'automation_pending_executions',
    'flows', 'flow_runs', 'member_presence', 'api_keys', 'webhook_endpoints',
    'notifications', 'quick_replies', 'ai_configs', 'ai_knowledge_documents',
    'ai_knowledge_chunks', 'ai_usage_log'
  ];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_organization_id_trigger ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER sync_organization_id_trigger
         BEFORE INSERT OR UPDATE OF account_id ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.sync_organization_id_from_account()', t);
  END LOOP;
END $$;

-- ============================================================
-- BACKFILL — join each row's account_id through organizations
-- .legacy_account_id. Generic over the table list so it can't drift
-- from the ALTER TABLE list above; re-run-safe (only touches rows
-- still NULL).
-- ============================================================
DO $$
DECLARE
  v_table TEXT;
  v_tables TEXT[] := ARRAY[
    'contacts', 'tags', 'custom_fields', 'contact_notes', 'conversations',
    'whatsapp_config', 'message_templates', 'pipelines', 'deals', 'broadcasts',
    'automations', 'automation_logs', 'automation_pending_executions',
    'flows', 'flow_runs', 'member_presence', 'api_keys', 'webhook_endpoints',
    'notifications', 'quick_replies', 'ai_configs', 'ai_knowledge_documents',
    'ai_knowledge_chunks', 'ai_usage_log'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format($f$
      UPDATE %I t
      SET organization_id = o.id
      FROM organizations o
      WHERE o.legacy_account_id = t.account_id
        AND t.organization_id IS NULL
    $f$, v_table);
  END LOOP;
END $$;

-- ============================================================
-- NULL GATE — hard stop before SET NOT NULL if any row's account_id
-- didn't resolve to an organization. Aborts the whole migration
-- transaction (RAISE EXCEPTION inside a DO block propagates out and
-- rolls back everything applied so far in this file) rather than
-- silently proceeding with an under-backfilled table.
-- ============================================================
DO $$
DECLARE
  v_table TEXT;
  v_null_count BIGINT;
  v_total_null BIGINT := 0;
  v_report TEXT := '';
  v_tables TEXT[] := ARRAY[
    'contacts', 'tags', 'custom_fields', 'contact_notes', 'conversations',
    'whatsapp_config', 'message_templates', 'pipelines', 'deals', 'broadcasts',
    'automations', 'automation_logs', 'automation_pending_executions',
    'flows', 'flow_runs', 'member_presence', 'api_keys', 'webhook_endpoints',
    'notifications', 'quick_replies', 'ai_configs', 'ai_knowledge_documents',
    'ai_knowledge_chunks', 'ai_usage_log'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE organization_id IS NULL', v_table)
      INTO v_null_count;
    IF v_null_count > 0 THEN
      v_total_null := v_total_null + v_null_count;
      v_report := v_report || format('%s: %s NULL rows; ', v_table, v_null_count);
    END IF;
  END LOOP;

  IF v_total_null > 0 THEN
    RAISE EXCEPTION
      'organization_id backfill incomplete (% total NULL rows) — %. This means some row''s account_id does not resolve to an organizations row via legacy_account_id; investigate migration 042''s backfill before re-running this migration.',
      v_total_null, v_report;
  END IF;
END $$;

-- ============================================================
-- NOT NULL — split from the DO blocks above so the DDL happens at
-- the top transactional level. No-op (error-free) if already set.
-- ============================================================
ALTER TABLE contacts                       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE tags                           ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE custom_fields                  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE contact_notes                  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE conversations                  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE whatsapp_config                ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE message_templates              ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pipelines                      ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE deals                          ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE broadcasts                     ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE automations                    ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE automation_logs                ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE automation_pending_executions  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE flows                          ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE flow_runs                      ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE member_presence                ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE api_keys                       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE webhook_endpoints              ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE notifications                  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE quick_replies                  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_configs                     ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_knowledge_documents         ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_knowledge_chunks            ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_usage_log                   ALTER COLUMN organization_id SET NOT NULL;

-- ============================================================
-- INDEXES — plain btree on every table (baseline lookup key), except
-- ai_configs and whatsapp_config: both get only the UNIQUE index in
-- the section below (one row per organization), since a UNIQUE index
-- already serves point lookups and a separate plain btree alongside
-- it would be pure redundancy.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_contacts_organization                       ON contacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_tags_organization                           ON tags(organization_id);
CREATE INDEX IF NOT EXISTS idx_custom_fields_organization                  ON custom_fields(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_notes_organization                  ON contact_notes(organization_id);
CREATE INDEX IF NOT EXISTS idx_conversations_organization                  ON conversations(organization_id);
CREATE INDEX IF NOT EXISTS idx_message_templates_organization              ON message_templates(organization_id);
CREATE INDEX IF NOT EXISTS idx_pipelines_organization                      ON pipelines(organization_id);
CREATE INDEX IF NOT EXISTS idx_deals_organization                          ON deals(organization_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_organization                     ON broadcasts(organization_id);
CREATE INDEX IF NOT EXISTS idx_automations_organization                    ON automations(organization_id);
CREATE INDEX IF NOT EXISTS idx_automation_logs_organization                ON automation_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_automation_pending_organization             ON automation_pending_executions(organization_id);
CREATE INDEX IF NOT EXISTS idx_flows_organization                         ON flows(organization_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_organization                      ON flow_runs(organization_id);
CREATE INDEX IF NOT EXISTS idx_member_presence_organization                ON member_presence(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_organization                       ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_organization              ON webhook_endpoints(organization_id);
CREATE INDEX IF NOT EXISTS idx_notifications_organization                  ON notifications(organization_id);
CREATE INDEX IF NOT EXISTS idx_quick_replies_organization                  ON quick_replies(organization_id);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_documents_organization         ON ai_knowledge_documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_organization            ON ai_knowledge_chunks(organization_id);

-- ============================================================
-- COMPOSITE / UNIQUE INDEXES — mirrors of the account_id-keyed
-- indexes that already exist live (checked against pg_indexes, not
-- guessed). ai_configs and whatsapp_config get a UNIQUE(organization_id)
-- in place of a redundant plain-btree-plus-unique pair (the account_id
-- side has both `idx_whatsapp_config_account` and
-- `whatsapp_config_account_id_key` — a UNIQUE index already serves
-- point lookups, so the organization_id side skips the redundant
-- second index rather than reproducing it).
-- ============================================================

-- ai_configs: exactly one row per account today (UNIQUE(account_id)) —
-- same invariant per organization.
CREATE UNIQUE INDEX IF NOT EXISTS ai_configs_organization_id_key ON ai_configs(organization_id);

-- ai_usage_log: hot query is "this account's usage, newest first"
-- (idx_ai_usage_log_account_created).
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_organization_created ON ai_usage_log(organization_id, created_at DESC);

-- automations: hot query is "this account's active automations for a
-- trigger type" (idx_automations_account_active_trigger).
CREATE INDEX IF NOT EXISTS idx_automations_organization_active_trigger
  ON automations(organization_id, trigger_type) WHERE (is_active = true);

-- contacts: phone dedup is per-account today (migration 022,
-- idx_contacts_account_phone_normalized) — same invariant per
-- organization.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_organization_phone_normalized
  ON contacts(organization_id, phone_normalized) WHERE (phone_normalized <> '');

-- conversations: one conversation per (account, contact) today
-- (migration 036, idx_conversations_account_contact) — same
-- invariant per organization.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_organization_contact
  ON conversations(organization_id, contact_id);

-- flow_runs: at most one active run per (account, contact) today
-- (migration 017, idx_one_active_run_per_contact) — same invariant
-- per organization.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_contact_organization
  ON flow_runs(organization_id, contact_id) WHERE (status = 'active');

-- flows: hot query is "this account's active flows"
-- (idx_flows_account_active).
CREATE INDEX IF NOT EXISTS idx_flows_organization_active
  ON flows(organization_id) WHERE (status = 'active');

-- whatsapp_config: one WhatsApp number per account today
-- (whatsapp_config_account_id_key) — same invariant per organization.
-- (phone_number_id stays globally UNIQUE regardless, untouched here.)
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_organization_id_key ON whatsapp_config(organization_id);
