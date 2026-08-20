# Deploying WA-CRM on Dokploy

Two Dokploy services on the same VPS, plus the Postgres database you
already run there:

```
┌─ Dokploy ───────────────────────────────────────────┐
│  ① Compose service: supabase/self-host  (:8000)     │──► Postgres
│  ② Application:     WA-CRM app (Dockerfile, :3000)  │    (VPS, :5432)
└─────────────────────────────────────────────────────┘
```

## 0. Prerequisites (one-time, already done for the current VPS)

The database must be migrated and the service roles created:

```bash
DATABASE_URL=postgres://user:pass@host:5432/wa-crm \
SVC_PASSWORD=<service-role password> \
  ./scripts/apply-postgres.sh
```

Push this repository (including `supabase/`) to the Git remote Dokploy
will pull from. The two `.env` files are gitignored by design — all
values below go into each service's **Environment** tab in Dokploy.

## 1. Supabase stack (Compose service)

- **Create → Compose**, point it at this repo.
- **Compose path:** `supabase/self-host/docker-compose.yml`
- **Environment** (same keys as `supabase/self-host/.env.example`):

  ```
  POSTGRES_HOST=<postgres host — the VPS itself>
  POSTGRES_PORT=5432
  POSTGRES_DB=wa-crm
  SVC_PASSWORD=<same one given to apply-postgres.sh>
  JWT_SECRET=…            # node scripts/generate-supabase-keys.mjs
  ANON_KEY=…
  SERVICE_ROLE_KEY=…
  SECRET_KEY_BASE=…
  GATEWAY_PORT=8000
  API_EXTERNAL_URL=https://supabase.your-domain.com   # or http://<vps-ip>:8000
  SITE_URL=https://crm.your-domain.com                # where the app lives
  ```

- Expose the gateway: either keep the `8000:8000` port mapping (reach it
  as `http://<vps-ip>:8000`), or attach a Dokploy **domain** to the
  `gateway` service on container port 8000 for TLS. The gateway reflects
  the request origin in its CORS headers, so no per-domain CORS config
  is needed.
- **First deploy only:** if the `storage` container crash-loops with
  `cannot drop function foldername`, run
  `supabase/self-host/first-boot-storage-fix.sh` once against the
  database (see that script's header), then redeploy.

## 2. The app (Application service)

- **Create → Application**, same repo, **Build type: Dockerfile**
  (the `Dockerfile` at the repo root).
- `NEXT_PUBLIC_*` values are **inlined at build time** and Dokploy does
  not pass its environment variables to Dockerfile builds — so they live
  in-repo in **`env/next-public.production`** (they are browser-facing,
  not secrets; the anon key is public by design). The Dockerfile copies
  that file to `.env.production` before `next build`. To change any of
  them: edit the file, commit, push, redeploy — a restart is not enough.
- **Environment** (runtime, server-only — never baked into the image):

  ```
  SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY>
  ENCRYPTION_KEY=<64 hex chars>
  META_APP_SECRET=<from Meta for Developers>
  AUTOMATION_CRON_SECRET=<random hex>
  # optional: META_APP_ID, WHATSAPP_TEMPLATES_DRY_RUN, ALLOWED_INVITE_HOSTS…
  ```

- Attach your **domain** to container port **3000**.

## 3. After the first deploy

- Log in with the seed user `demo@wacrm.local` / `Demo123!` (or register —
  signups are currently auto-confirmed since no SMTP is configured).
- Live inbox updates need `wal_level = logical` on Postgres; it is already
  set via `ALTER SYSTEM` but requires one Postgres restart on the host.
- Point the Meta webhook at
  `https://crm.your-domain.com/api/whatsapp/webhook` once WhatsApp is
  configured in Settings.

## Gotchas

- `NEXT_PUBLIC_SUPABASE_URL` must be reachable from users' browsers, not
  just from inside the VPS — never use `localhost` or a Docker-internal
  hostname here.
- If the app is served over **https**, the Supabase gateway must be too
  (browsers block mixed content). Give both services domains behind
  Dokploy's Traefik rather than exposing the gateway on a bare port.
- Keep `SITE_URL` (stack) and `NEXT_PUBLIC_SITE_URL` (app) identical;
  GoTrue uses it for redirect allow-listing.
