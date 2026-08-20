# Self-hosted Supabase on your own Postgres

WA-CRM talks to Supabase's HTTP services (auth, REST, storage, realtime),
not to Postgres directly. This directory runs those services in Docker
against an **external stock Postgres** — no Supabase cloud project, no
bundled database container.

```
Next.js app ──► gateway :8000 (nginx)
                 ├─ /auth/v1     → GoTrue        ─┐
                 ├─ /rest/v1     → PostgREST      ├─► your Postgres
                 ├─ /storage/v1  → Storage API   ─┤   (e.g. VPS)
                 └─ /realtime/v1 → Realtime      ─┘
```

## One-time database setup

From the repo root, against a fresh database:

```bash
# 1. schema: compat bootstrap + all migrations + demo seed
DATABASE_URL=postgres://user:pass@host:5432/wa-crm \
SVC_PASSWORD=<password for the supabase_* service roles> \
  ./scripts/apply-postgres.sh
```

Requirements: superuser connection, `uuid-ossp` + `pgcrypto` extensions
available (stock Debian/Ubuntu Postgres has both). `pgvector` is optional —
without it AI knowledge falls back from semantic to full-text search.

## Running the stack

```bash
cd supabase/self-host
cp .env.example .env
node ../../scripts/generate-supabase-keys.mjs   # paste output into .env
# set POSTGRES_HOST / POSTGRES_DB / SVC_PASSWORD to match your database
docker compose up -d
```

**First boot only:** the Storage API's own migrations must replace
`storage.foldername()`, which the WA-CRM RLS policies depend on. If the
storage container crash-loops with `cannot drop function foldername`, run:

```bash
./first-boot-storage-fix.sh
```

Then point the app at the gateway in `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://<host-running-this-stack>:8000
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from .env>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from .env>
```

Demo login (from the seed): `demo@wacrm.local` / `Demo123!`

## Production notes

- **Realtime live updates** (`postgres_changes` — live inbox, notifications)
  need `wal_level = logical`. `010_service_roles.sql` already ran
  `ALTER SYSTEM SET wal_level = 'logical'`; it takes effect after a
  **Postgres restart** (`systemctl restart postgresql` on the DB host).
  Until then the app works, but new messages appear on refresh instead of
  live. Presence/broadcast channels work either way.
- `NEXT_PUBLIC_SUPABASE_URL` must be reachable from **users' browsers**,
  not just the server — on a VPS use `http://<vps-ip>:8000` or put the
  gateway behind your reverse proxy with TLS.
- Set `SITE_URL` / `API_EXTERNAL_URL` in `.env` to the public URLs before
  `docker compose up`.
- Signups are auto-confirmed (`GOTRUE_MAILER_AUTOCONFIRM=true`) because no
  SMTP is configured. Wire `GOTRUE_SMTP_*` in `docker-compose.yml` for
  real e-mail confirmation, invites, and password resets.
- Storage files live in the `storage-data` Docker volume — include it in
  backups alongside the database.
