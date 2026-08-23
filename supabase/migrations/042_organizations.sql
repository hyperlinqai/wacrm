-- ============================================================
-- 042_organizations.sql — Organization / Tenant layer (SaaS Phase 1)
--
-- Introduces `organizations` / `organization_members` /
-- `organization_settings` as the tenant model the SaaS product will
-- run on, WITHOUT touching `accounts` / `profiles` or any of the 36
-- account_id-scoped tables from migration 017 onward. Nothing reads
-- from the new tables yet — the app keeps writing accounts/profiles
-- exactly as it does today (Phase 0 audit: docs/phase0-audit/).
--
-- Why a parallel table set instead of renaming accounts -> organizations
--   `accounts` is load-bearing for 102 live RLS policies and every
--   account_id FK in the schema (Phase 0 audit, 02-erd.md /
--   03-rls-policies.md). Renaming/repointing all of that in one
--   migration is the highest-risk possible move. Instead: build the
--   new tenant model next to the old one, keep it perfectly in sync
--   via triggers, and let a *later* phase cut application code over
--   table-by-table, then retire accounts/profiles once nothing reads
--   them. This migration is pure addition — it cannot break anything
--   that currently works.
--
-- What this migration does
--   1. Adds `organization_role_enum` (organization_owner > admin >
--      agent > viewer) — deliberately NOT reusing account_role_enum,
--      since "owner"/"admin" now need an "organization_" prefix to
--      stay unambiguous once both models exist side by side.
--   2. Adds `organizations`, `organization_members`,
--      `organization_settings`.
--   3. Adds `is_organization_member(org_id, min_role)`, the
--      organization-layer twin of `is_account_member()`, and enables
--      RLS on all three new tables using it.
--   4. Adds `auth.users.is_platform_owner` (see "platform_owner" note
--      below) and folds a bypass for it into `is_organization_member`.
--   5. Adds a one-time backfill: one `organizations` row per existing
--      `accounts` row (linked via `legacy_account_id`), one
--      `organization_settings` row per organization, one
--      `organization_members` row per existing `profiles` row.
--   6. Adds AFTER triggers on `accounts` and `profiles` so every
--      *future* write through the existing account/profile code
--      paths (signup, invite redemption, role changes, ownership
--      transfer, member removal — see 018/019_*.sql) keeps
--      organizations/organization_members converged automatically,
--      with zero application-code changes required in this phase.
--
-- The "platform_owner" role
--   The role list handed down for this phase was: platform_owner,
--   organization_owner, organization_admin, agent, viewer. The first
--   four fit an org-scoped `role` column; platform_owner does not —
--   a platform operator isn't a "member" of any one tenant, and
--   organization_members.organization_id is (deliberately) NOT NULL,
--   so there's no clean row to hang a platform-wide role off inside
--   this table. Modeled instead as a single global flag,
--   `auth.users.is_platform_owner`, the same way migration 040 added
--   `auth.users.sessions_revoked_at` for a cross-cutting auth concern.
--   `is_organization_member()` treats it as an automatic bypass (rank
--   above owner in every organization), which is the actual desired
--   behavior for platform staff/support access. If this guess doesn't
--   match intent, it's a one-column, low-cost thing to revisit — flag
--   it in review.
--
-- What this migration deliberately leaves for a later phase
--   - No application code reads/writes these tables yet.
--   - No `plans` table — `organizations.plan_id` is a bare text slug
--     ('free' default) for now; billing/entitlements is out of scope
--     for Phase 1.
--   - No subdomain/host-routing logic — `organizations.slug` is
--     generated and unique so that's ready to build on, but nothing
--     consumes it yet.
--   - `accounts`/`profiles` are not deprecated, not read-only, not
--     touched. Removing them is an explicit future migration once
--     application code has fully cut over (tracked separately).
--
-- Idempotent — safe to run multiple times. Tables use IF NOT EXISTS;
-- policies/triggers are dropped before recreate (Postgres has no
-- CREATE POLICY/TRIGGER IF NOT EXISTS); the backfill only inserts
-- rows that don't already exist (keyed on legacy_account_id / the
-- organization_id+user_id unique constraint).
-- ============================================================

-- ============================================================
-- TYPES
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_role_enum') THEN
    CREATE TYPE organization_role_enum AS ENUM (
      'organization_owner', 'organization_admin', 'agent', 'viewer'
    );
  END IF;
END $$;

-- ============================================================
-- auth.users.is_platform_owner — see "platform_owner" note above.
-- ============================================================
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_platform_owner boolean NOT NULL DEFAULT false;

-- ============================================================
-- ORGANIZATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text NOT NULL,
  logo_url          text,
  status            text NOT NULL DEFAULT 'active',   -- active | suspended | cancelled (app-validated, matches the plain-text `status` convention used by whatsapp_config/broadcasts/deals/etc. rather than a DB enum)
  plan_id           text NOT NULL DEFAULT 'free',      -- no plans/billing table yet (out of scope this phase) — bare slug so entitlement logic has a stable default to branch on
  default_currency  text NOT NULL DEFAULT 'USD',
  -- Bridge back to the table this row was derived/kept in sync from.
  -- NULL would mean "an organization created directly, with no legacy
  -- account" — not possible yet (nothing creates orgs directly this
  -- phase) but the column stays nullable so that's not a schema
  -- change later.
  legacy_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_key UNIQUE (slug),
  CONSTRAINT organizations_legacy_account_id_key UNIQUE (legacy_account_id)
);

CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON organizations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ORGANIZATION_MEMBERS
--
-- Unlike `profiles` (one account_id column per user — a hard
-- one-account-per-user constraint flagged in the Phase 0 audit,
-- 05-auth-flow.md, as the biggest structural blocker to multi-org
-- support), this is a genuine many-to-many join table: the same
-- user_id can appear in many organization_id rows. That's the actual
-- capability unlock in this migration — nothing in this phase makes
-- the app *use* multi-org membership yet, but the schema no longer
-- forbids it.
-- ============================================================
CREATE TABLE IF NOT EXISTS organization_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            organization_role_enum NOT NULL DEFAULT 'viewer',
  status          text NOT NULL DEFAULT 'active',   -- active | invited | suspended | removed
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_members_org_user_key UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_members_org  ON organization_members(organization_id);
-- The new query this table makes possible: "every organization a user
-- belongs to" — impossible with profiles' single account_id column.
CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id);

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON organization_members;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ORGANIZATION_SETTINGS
--
-- One row per organization (PK = organization_id, a 1:1 extension
-- table rather than a second uuid PK + unique FK — there is exactly
-- one settings row per org, always). Known, frequently-read fields
-- get real columns; `settings jsonb` is the escape hatch for
-- fast-moving config/feature flags that don't yet warrant a migration.
-- ============================================================
CREATE TABLE IF NOT EXISTS organization_settings (
  organization_id  uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  default_currency text NOT NULL DEFAULT 'USD',
  timezone         text NOT NULL DEFAULT 'UTC',
  locale           text NOT NULL DEFAULT 'en',
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON organization_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON organization_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- MEMBERSHIP HELPER — is_organization_member()
--
-- Organization-layer twin of is_account_member() (migration 017).
-- SECURITY DEFINER so the policy body can read organization_members
-- without recursive RLS evaluation.
--
-- Role hierarchy: platform_owner (bypass) > organization_owner(4) >
-- organization_admin(3) > agent(2) > viewer(1).
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_organization_member(
  target_organization_id uuid,
  min_role organization_role_enum DEFAULT 'viewer'
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM auth.users u WHERE u.id = auth.uid() AND u.is_platform_owner)
    OR EXISTS (
      SELECT 1
      FROM organization_members m
      WHERE m.user_id = auth.uid()
        AND m.organization_id = target_organization_id
        AND m.status = 'active'
        AND CASE m.role
              WHEN 'organization_owner' THEN 4
              WHEN 'organization_admin' THEN 3
              WHEN 'agent'              THEN 2
              WHEN 'viewer'             THEN 1
            END
          >=
            CASE min_role
              WHEN 'organization_owner' THEN 4
              WHEN 'organization_admin' THEN 3
              WHEN 'agent'              THEN 2
              WHEN 'viewer'             THEN 1
            END
    );
$$;

ALTER FUNCTION public.is_organization_member(uuid, organization_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_organization_member(uuid, organization_role_enum) TO authenticated, service_role;

-- ============================================================
-- RLS — ORGANIZATIONS / ORGANIZATION_MEMBERS / ORGANIZATION_SETTINGS
--
-- Mirrors the accounts/account_invitations policy shape from 017:
-- members read; admin+ writes settings-class data; nobody outside
-- the sync triggers/backfill (which run SECURITY DEFINER / as table
-- owner) can INSERT a row via the client — organization creation is
-- not yet a user-facing action in this phase.
-- ============================================================
DROP POLICY IF EXISTS organizations_select ON organizations;
CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (is_organization_member(id));

DROP POLICY IF EXISTS organizations_update ON organizations;
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (is_organization_member(id, 'organization_admin'))
  WITH CHECK (is_organization_member(id, 'organization_admin'));

DROP POLICY IF EXISTS organization_members_select ON organization_members;
CREATE POLICY organization_members_select ON organization_members FOR SELECT
  USING (is_organization_member(organization_id));

-- Admins manage the roster; a member may also remove *themselves*
-- (leave) without needing admin — mirrors "leave account" semantics
-- being a self-service action elsewhere in the app.
DROP POLICY IF EXISTS organization_members_modify ON organization_members;
CREATE POLICY organization_members_modify ON organization_members FOR ALL
  USING (
    is_organization_member(organization_id, 'organization_admin')
    OR user_id = auth.uid()
  )
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));

DROP POLICY IF EXISTS organization_settings_select ON organization_settings;
CREATE POLICY organization_settings_select ON organization_settings FOR SELECT
  USING (is_organization_member(organization_id));

DROP POLICY IF EXISTS organization_settings_update ON organization_settings;
CREATE POLICY organization_settings_update ON organization_settings FOR UPDATE
  USING (is_organization_member(organization_id, 'organization_admin'))
  WITH CHECK (is_organization_member(organization_id, 'organization_admin'));

-- ============================================================
-- ROLE MAPPING — account_role_enum -> organization_role_enum
-- ============================================================
CREATE OR REPLACE FUNCTION public.account_role_to_organization_role(p_role account_role_enum)
RETURNS organization_role_enum
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'owner'  THEN 'organization_owner'::organization_role_enum
    WHEN 'admin'  THEN 'organization_admin'::organization_role_enum
    WHEN 'agent'  THEN 'agent'::organization_role_enum
    WHEN 'viewer' THEN 'viewer'::organization_role_enum
  END;
$$;

-- ============================================================
-- SLUG GENERATION
-- ============================================================
CREATE OR REPLACE FUNCTION public.slugify(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(trim(both '-' from regexp_replace(lower(coalesce(p_input, '')), '[^a-z0-9]+', '-', 'g')), '');
$$;

-- Not concurrency-hardened (check-then-insert) — acceptable here for
-- the same reason the codebase already tolerates similar small races
-- in find-or-create paths (Phase 0 audit, 06-whatsapp-webhook-flow.md):
-- organization creation is currently only one-per-signup, effectively
-- serialized in practice. Revisit if organization creation becomes a
-- high-concurrency path.
CREATE OR REPLACE FUNCTION public.generate_organization_slug(p_name text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_base   text := COALESCE(public.slugify(p_name), 'org');
  v_slug   text := v_base;
  v_suffix int  := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base || '-' || v_suffix;
  END LOOP;
  RETURN v_slug;
END;
$$;

-- ============================================================
-- SYNC TRIGGERS — keep organizations/organization_members converged
-- with every future write to accounts/profiles, with zero
-- application-code changes in this phase.
--
-- Every code path that touches accounts/profiles today (handle_new_user
-- on signup, redeem_invitation, set_member_role, remove_account_member,
-- transfer_account_ownership — migrations 017/018/019) is plain SQL
-- UPDATE/INSERT against those two tables, so these AFTER triggers catch
-- all of them automatically.
-- ============================================================

-- ---- accounts -> organizations ---------------------------------
CREATE OR REPLACE FUNCTION public.sync_organization_from_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.organizations (name, slug, default_currency, legacy_account_id)
    VALUES (NEW.name, public.generate_organization_slug(NEW.name), NEW.default_currency, NEW.id)
    ON CONFLICT (legacy_account_id) DO NOTHING;

    INSERT INTO public.organization_settings (organization_id, default_currency)
    SELECT o.id, NEW.default_currency
    FROM public.organizations o
    WHERE o.legacy_account_id = NEW.id
    ON CONFLICT (organization_id) DO NOTHING;

  ELSIF TG_OP = 'UPDATE' THEN
    -- name/default_currency only — slug is URL-stable once assigned,
    -- status/plan_id are organization-layer concepts accounts has no
    -- equivalent for and are never overwritten here.
    UPDATE public.organizations
    SET name = NEW.name,
        default_currency = NEW.default_currency
    WHERE legacy_account_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_organization_from_account() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_organization_from_account_trigger ON accounts;
CREATE TRIGGER sync_organization_from_account_trigger
  AFTER INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.sync_organization_from_account();

-- ---- profiles -> organization_members ---------------------------
CREATE OR REPLACE FUNCTION public.sync_organization_member_from_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.organization_members m
    USING public.organizations o
    WHERE o.legacy_account_id = OLD.account_id
      AND m.organization_id = o.id
      AND m.user_id = OLD.user_id;
    RETURN OLD;
  END IF;

  -- A profile can move to a different account_id (invite redemption,
  -- remove_account_member spinning up a fresh personal account) —
  -- when that happens, drop the membership in the OLD organization
  -- before upserting the new one, so a user is never left with a
  -- stale membership row for an account they no longer belong to.
  IF TG_OP = 'UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    DELETE FROM public.organization_members m
    USING public.organizations o
    WHERE o.legacy_account_id = OLD.account_id
      AND m.organization_id = o.id
      AND m.user_id = OLD.user_id;
  END IF;

  INSERT INTO public.organization_members (organization_id, user_id, role)
  SELECT o.id, NEW.user_id, public.account_role_to_organization_role(NEW.account_role)
  FROM public.organizations o
  WHERE o.legacy_account_id = NEW.account_id
  ON CONFLICT (organization_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, status = 'active';

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_organization_member_from_profile() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_organization_member_from_profile_trigger ON profiles;
CREATE TRIGGER sync_organization_member_from_profile_trigger
  AFTER INSERT OR UPDATE OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_organization_member_from_profile();

-- ============================================================
-- BACKFILL — one organization per existing account, one
-- organization_settings row per organization, one organization_member
-- per existing profile.
--
-- Idempotent: ON CONFLICT DO NOTHING keyed on the same unique
-- constraints the triggers rely on, so re-running this migration (or
-- running it after some rows were already created by the triggers
-- above firing on unrelated concurrent activity) converges cleanly
-- rather than erroring or duplicating.
-- ============================================================
DO $$
DECLARE
  v_account RECORD;
BEGIN
  -- (1) organizations, one per existing account.
  FOR v_account IN SELECT id, name, default_currency FROM public.accounts LOOP
    INSERT INTO public.organizations (name, slug, default_currency, legacy_account_id)
    VALUES (
      v_account.name,
      public.generate_organization_slug(v_account.name),
      v_account.default_currency,
      v_account.id
    )
    ON CONFLICT (legacy_account_id) DO NOTHING;
  END LOOP;

  -- (2) organization_settings, one per organization created above
  -- (or by the trigger, for any account created after this migration
  -- started applying but before this DO block ran).
  INSERT INTO public.organization_settings (organization_id, default_currency)
  SELECT o.id, o.default_currency
  FROM public.organizations o
  WHERE NOT EXISTS (
    SELECT 1 FROM public.organization_settings s WHERE s.organization_id = o.id
  );

  -- (3) organization_members, one per existing profile.
  INSERT INTO public.organization_members (organization_id, user_id, role)
  SELECT o.id, p.user_id, public.account_role_to_organization_role(p.account_role)
  FROM public.profiles p
  JOIN public.organizations o ON o.legacy_account_id = p.account_id
  ON CONFLICT (organization_id, user_id) DO NOTHING;
END $$;
