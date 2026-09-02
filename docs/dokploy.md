# Deploying WA-CRM on Dokploy

One Dokploy **Compose** service and your Postgres — nothing else. The
stack is three containers behind one origin: Caddy routes `/api/*` to
the API container and everything else to the UI container, so the
browser (and Meta's webhook, and every embedded lead-form widget) only
ever sees one hostname.

```
┌─ Dokploy Compose service ────────────────────────────┐
│  proxy (caddy:2, :80) ◄── domain via Traefik         │
│    ├── /api/* ──► api  (Dockerfile.api, :3001) ──────┼──► Postgres (VPS, :5432)
│    │              └── volume: /var/lib/wacrm-storage │
│    └── rest  ──► web  (Dockerfile, :3000)            │
└──────────────────────────────────────────────────────┘
```

## 0. Database (one-time, already done for the current VPS)

```bash
DATABASE_URL=postgres://<superuser>@host:5432/wa-crm \
SVC_PASSWORD=<password for the app's DB roles> \
  ./scripts/apply-postgres.sh
```

This applies every migration and creates the `authenticator` login role
the app connects with (least privilege: it can only assume the
anon/authenticated/service_role RLS roles).

## 1. The app

- **Create → Compose**, this repo, **Compose path:
  `./docker-compose.yml`**. Dokploy builds both images from the repo's
  Dockerfiles and starts all three containers.
- `NEXT_PUBLIC_*` values are inlined at build time from the in-repo
  `apps/web/env/next-public.production` (they are not secrets). To change
  them: edit that file, commit, push, redeploy. `NEXT_PUBLIC_SITE_URL`
  there must be the domain you attach below.
- **Environment tab** (runtime secrets — Dokploy writes these to a
  `.env` beside the compose file, which both app containers read; the
  same `JWT_SECRET` must reach both, or every session is signed out):

  ```
  DATABASE_URL=postgresql://authenticator:<SVC_PASSWORD>@<postgres-host>:5432/wa-crm
  JWT_SECRET=<openssl rand -hex 32>
  ENCRYPTION_KEY=<64 hex chars>
  META_APP_SECRET=<from Meta for Developers>
  AUTOMATION_CRON_SECRET=<random hex>
  NEXT_PUBLIC_SITE_URL=https://your-domain
  # The Dokploy dashboard itself owns host port 3000 — give the proxy a
  # free one. (Only matters because the compose file publishes a port;
  # the domain below reaches the proxy over the Docker network anyway.)
  HOST_PORT=8081
  # META_APP_ID: optional for image-header templates alone, but REQUIRED
  # if WhatsApp Embedded Signup is enabled (§1a below) — the code-exchange
  # route rejects every attempt without it, same value as NEXT_PUBLIC_META_APP_ID.
  META_APP_ID=<same app id as NEXT_PUBLIC_META_APP_ID>
  # Meta Lead Ads (optional): verify token for the Page webhook handshake.
  # Falls back to WHATSAPP_WEBHOOK_VERIFY_TOKEN / a connected WhatsApp
  # config's token if unset. See docs/meta-lead-ads.md.
  META_LEADS_WEBHOOK_VERIFY_TOKEN=<random string>
  # optional: WHATSAPP_TEMPLATES_DRY_RUN, ALLOWED_INVITE_HOSTS…
  ```

- **Domain**: Domains → add your domain, **service `proxy`, container
  port `80`**, HTTPS on (Let's Encrypt). Do not attach domains to `web`
  or `api` directly — splitting the hostname breaks the media URLs and
  webhook registrations stored against the one origin.
- Uploaded media lives on the `storage-data` named volume the compose
  file declares and mounts into `api` at `/var/lib/wacrm-storage` —
  no manual volume setup needed, and it survives redeploys.

## 1a. WhatsApp Embedded Signup (optional, but removes every manual step)

Without this, WhatsApp connects via a manual form (Settings → WhatsApp
connection) where an admin pastes in a phone number id, WABA id, a
System User access token they generated themselves, and a PIN. With
it, connecting is one click — "Connect WhatsApp with Meta" — and Meta
handles token generation, WABA/phone selection and PIN setup entirely
inside its own hosted UI.

One-time setup Meta requires (in the App Dashboard for the app named
in `META_APP_ID` / `NEXT_PUBLIC_META_APP_ID`):

1. Add the **Facebook Login for Business** product to the app, if not
   already present.
2. Facebook Login for Business → **Configurations** → create a new
   configuration for the **WhatsApp Business Signup** use case. Copy
   its id.
3. Set `NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID` to that id, and
   `NEXT_PUBLIC_META_APP_ID` to the same value as `META_APP_ID`, in
   `apps/web/env/next-public.production`.
4. If this app will onboard businesses other than your own, the
   `whatsapp_business_management` and `whatsapp_business_messaging`
   permissions need **Advanced Access** via App Review — Standard
   Access only works for your own business's WABAs. Self-testing with
   your own number works without this.

The "Connect WhatsApp with Meta" button hides itself and falls back to
the manual form until both `NEXT_PUBLIC_*` values are set.

## 2. After the first deploy

- Log in with the seed user `demo@wacrm.local` / `Demo123!` or register
  (signups are auto-confirmed; there is no email verification step).
- Live inbox updates need nothing special — no logical replication, no
  extra services. The LISTEN/NOTIFY triggers ship with migration 040;
  the SSE stream is served by the `api` container and Caddy is already
  configured to never buffer or time it out.
- Point the Meta webhook at
  `https://your-domain/api/whatsapp/webhook` once WhatsApp is configured
  in Settings.

## Gotchas

- `NEXT_PUBLIC_SITE_URL` (in `apps/web/env/next-public.production`) must be the
  URL users' browsers reach the app on — it is also the base for public
  media URLs Meta fetches. Changing it requires a rebuild.
- One env set feeds both app containers. `JWT_SECRET` in particular
  must match between `web` and `api` (the API signs session cookies,
  the UI verifies and slides them) — the shared `.env` guarantees that;
  don't override it per-service.
- Password-reset emails are not available (there is no mail service);
  a workspace owner changes passwords from Settings instead.
- Back up two things: the Postgres database and the
  `storage-data` volume (`/var/lib/wacrm-storage` inside `api`).
- Restrict Postgres (port 5432) to the app host — the database no longer
  needs to be reachable from anywhere else.
