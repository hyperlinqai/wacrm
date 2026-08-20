-- Roles and grants the self-hosted Supabase services (GoTrue, PostgREST,
-- Storage, Realtime) need on a stock Postgres. Run as a superuser with:
--
--   psql "$DATABASE_URL" -v svc_password='<password>' -f 010_service_roles.sql
--
-- Idempotent: safe to re-run (passwords are reset to :svc_password).

\set ON_ERROR_STOP on

-- ── Service login roles ─────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN CREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
    CREATE ROLE supabase_storage_admin LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin LOGIN SUPERUSER;
  END IF;
END
$$;

ALTER ROLE authenticator          PASSWORD :'svc_password';
ALTER ROLE supabase_auth_admin    PASSWORD :'svc_password';
ALTER ROLE supabase_storage_admin PASSWORD :'svc_password';
ALTER ROLE supabase_admin         PASSWORD :'svc_password';

-- PostgREST and the Storage API impersonate these after JWT verification
-- (storage does it via set_config('role', ...) per request).
GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO supabase_storage_admin;

-- ── Schema ownership ────────────────────────────────────────────────
-- GoTrue and Storage run their own migrations and must own their schemas.
ALTER SCHEMA auth    OWNER TO supabase_auth_admin;
ALTER SCHEMA storage OWNER TO supabase_storage_admin;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'auth' LOOP
    EXECUTE format('ALTER TABLE auth.%I OWNER TO supabase_auth_admin', r.tablename);
  END LOOP;
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'storage' LOOP
    EXECUTE format('ALTER TABLE storage.%I OWNER TO supabase_storage_admin', r.tablename);
  END LOOP;
END
$$;

ALTER FUNCTION storage.foldername(text) OWNER TO supabase_storage_admin;

-- GoTrue's 00_init migration does CREATE OR REPLACE on these, so it must
-- own them (a later GoTrue migration installs the canonical dual-GUC uid()).
ALTER FUNCTION auth.uid()  OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin;

-- GoTrue / Storage create helper schemas during their migrations.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO supabase_auth_admin, supabase_storage_admin',
                 current_database());
END
$$;

-- Realtime's Ecto migrator expects its schema to exist already.
CREATE SCHEMA IF NOT EXISTS _realtime AUTHORIZATION supabase_admin;

GRANT USAGE ON SCHEMA public, auth, storage TO
  authenticator, supabase_auth_admin, supabase_storage_admin;
GRANT CREATE ON SCHEMA public TO supabase_auth_admin, supabase_storage_admin;

-- The RLS policies on storage.objects consult public.profiles; the
-- handle_new_user trigger (SECURITY DEFINER, owner postgres) writes to
-- public tables when GoTrue inserts a user.
GRANT SELECT ON public.profiles TO supabase_storage_admin;

-- ── API-facing grants ───────────────────────────────────────────────
-- Hosted Supabase grants these by default; stock Postgres does not.
-- RLS (enabled per-table by the migrations) still gates every row.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid()  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

-- Future tables created by the current (migration-running) role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- storage.objects / storage.buckets are queried through the Storage API
-- as the requesting role.
GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO anon, authenticated, service_role;

-- The app's own auth layer reads/writes auth.users through the
-- authenticator login role. auth.users may carry RLS (GoTrue's legacy
-- migrations enable it with no policies), which would hide every row.
GRANT SELECT, INSERT, UPDATE ON auth.users TO authenticator;
GRANT SELECT ON storage.buckets TO authenticator;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = 'auth.users'::regclass AND relrowsecurity) THEN
    DROP POLICY IF EXISTS wacrm_app_auth_users ON auth.users;
    CREATE POLICY wacrm_app_auth_users ON auth.users
      FOR ALL TO authenticator USING (true) WITH CHECK (true);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = 'storage.buckets'::regclass AND relrowsecurity) THEN
    DROP POLICY IF EXISTS wacrm_app_buckets ON storage.buckets;
    CREATE POLICY wacrm_app_buckets ON storage.buckets
      FOR SELECT TO authenticator USING (true);
  END IF;
END
$$;

-- Realtime's postgres_changes needs logical WAL. Takes effect only after
-- a Postgres restart (presence/broadcast channels work regardless).
ALTER SYSTEM SET wal_level = 'logical';
