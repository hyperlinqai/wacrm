# Backup & Freeze Record

## Git freeze point

- Committed the in-progress working tree (branding/dashboard refactor, new
  template-library feature, migration 041) as `3aefeba` — see that commit for
  the exact diff — then tagged it:
  ```
  git tag -a single-tenant-stable -m "Freeze point before multi-tenant SaaS conversion (Phase 0 audit baseline)"
  ```
- **Tag is local only** — not pushed to `origin`. Push it explicitly
  (`git push origin single-tenant-stable`) when ready to share the freeze point.
- To return to this exact state at any point: `git checkout single-tenant-stable`.

## Database backup

Target: `wa-crm` on `157.10.99.50:5432` (PostgreSQL 18.4), the same server both
`.env.local` and `.env.production` point at (no separate local/dev Postgres —
noted here since it means "local development" and "production" are currently
the same database; worth deliberately separating before real customer data
exists).

Connected as the app's own `authenticator` role (from `.env.local`). Local
`pg_dump`/`psql` were PostgreSQL 16 (Homebrew) — too old to dump an 18.4 server
(`pg_dump: error: aborting because of server version mismatch`) — so
`postgresql@18` was installed via Homebrew (`brew install postgresql@18`,
left unlinked, invoked via its full path) to get a matching client.

### What was captured

All under `../../../backups/` (repo-parent-level `backups/`, **outside** the git
repo and not gitignore'd-in — deliberately kept out of version control since a
DB dump can contain customer PII):

| File | Contents |
|---|---|
| `wa-crm_20260823-134154_public.dump` | `pg_dump -Fc` (custom format, `pg_restore`-able) — **full data**, all 37 tables in `public` (contacts, conversations, messages, deals, pipelines, automations, templates, whatsapp_config, api_keys, everything listed in [01-schema-catalog.md](01-schema-catalog.md)) |
| `wa-crm_20260823-134154_schema-public.sql` | `pg_dump --schema-only`, `public` schema — plain SQL, DDL only |
| `columns.txt`, `foreign_keys.txt`, `rls_policies.txt`, `rls_status.txt`, `functions.txt`, `row_counts.txt` | Raw `psql` catalog dumps used to write 01/02/03 |

Row counts at capture time confirm this is a small dev/test dataset, not
production traffic: 2 accounts, 2 profiles, 1 conversation, 1 message, 5 flow
nodes, etc. — see `row_counts.txt`.

### What was **not** captured, and why

`pg_dump` (even `pg_dump --schema-only`, even scoped with `--role=service_role`)
against the **whole database** failed:
```
pg_dump: error: query failed: ERROR:  permission denied for table objects
pg_dump: detail: Query was: LOCK TABLE auth.users, storage.buckets, storage.objects, ...
```
`pg_dump` takes one `LOCK TABLE` across every table it plans to dump, in one
statement — if the connecting role lacks a lockable privilege on *any* table in
that list, the whole dump aborts, even though it has full rights on most of the
list. Root cause (confirmed from `supabase/postgres-compat/010_service_roles.sql`):
- `authenticator` (the app's login role) has explicit `SELECT, INSERT, UPDATE` on
  `auth.users` and `SELECT` on `storage.buckets` — **but nothing on `storage.objects`**.
- `service_role` has full grants on `public.*` and `storage.*` — **but nothing on
  `auth.users`** (only `authenticator` was explicitly granted that).

No single role in this deployment can read both `auth.users` and `storage.objects`
in one session without `SET ROLE` to a role that itself doesn't have the other
half — and neither `authenticator` nor `service_role` is a superuser. This is a
correct outcome of the least-privilege design documented in
[05-auth-flow.md](05-auth-flow.md), not a misconfiguration.

Consequences:
- **`storage.objects`/`storage.buckets` (Storage metadata) were not backed up.**
  The underlying files (avatars, chat/flow media) live on disk
  (`STORAGE_DIR`, `storage-data/` per `docker-compose.yml`), not in Postgres —
  only the *metadata rows* are unbacked-up here. Back these up at the filesystem/
  volume level instead (out of scope for a `pg_dump`-based backup).
- **`auth.users` row *data* (email, password hash, `sessions_revoked_at`, ban
  status — every real user account) was not exported.** A direct attempt via
  `psql \copy (select * from auth.users) to '<file>.csv' csv header` was
  **blocked by this session's own safety controls**, correctly — that's
  password-hash-and-PII data being written to a plaintext file on disk. This
  was not retried or worked around.
  - **The DDL is not at risk** — `auth.users`' full schema is fully captured in
    `supabase/postgres-compat/000_bootstrap.sql` (checked into git, already
    part of the `single-tenant-stable` freeze) and is trivially recreatable via
    `scripts/apply-postgres.sh`.
  - **The row data is the actual gap.** If a real data-loss backup of user
    accounts (not just schema) is wanted, that needs either: (a) a superuser/
    `supabase_admin` credential run through `pg_dump` directly (avoids the
    LOCK TABLE-wide-permission problem entirely), or (b) an explicit,
    consciously-authorized export of that specific table, done by whoever owns
    that credential — not something to script into an unattended tool run.
    Flagging this as an open decision rather than making it unilaterally.

### To restore

```bash
# Business data (contacts, conversations, messages, deals, etc.):
pg_restore --no-owner --no-privileges -d <target-db-url> wa-crm_20260823-134154_public.dump

# Or apply schema fresh + re-seed, for a clean environment:
DATABASE_URL=<target> SVC_PASSWORD=<...> ./scripts/apply-postgres.sh
```

## Follow-ups worth doing before Phase 1+ work touches the database

1. Decide on a real backup cadence/target (this was a one-off manual capture)
   before any destructive migration work begins.
2. Get a superuser/`supabase_admin` credential path set up (even if only used
   interactively, never scripted) so a genuinely complete backup — including
   `auth.users` row data — is possible without the permission wall hit here.
3. Point `.env.local` at something other than the same server as
   `.env.production`, so "local development" can no longer accidentally read
   or write real/shared data.
