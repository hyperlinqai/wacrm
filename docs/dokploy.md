# Deploying WA-CRM on Dokploy

One Dokploy service and your Postgres — nothing else. The app talks to
Postgres directly (auth, data with row-level security, file storage on a
volume, live updates via LISTEN/NOTIFY + SSE).

```
┌─ Dokploy ────────────────────────────────┐
│  Application: WA-CRM (Dockerfile, :3000) │──► Postgres (VPS, :5432)
│  └── volume: /var/lib/wacrm-storage      │
└──────────────────────────────────────────┘
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

- **Create → Application**, this repo, **Build type: Dockerfile**.
- `NEXT_PUBLIC_*` values are inlined at build time from the in-repo
  `env/next-public.production` (they are not secrets). To change them:
  edit that file, commit, push, redeploy.
- **Environment** (runtime secrets):

  ```
  DATABASE_URL=postgresql://authenticator:<SVC_PASSWORD>@<postgres-host>:5432/wa-crm
  JWT_SECRET=<openssl rand -hex 32>
  ENCRYPTION_KEY=<64 hex chars>
  META_APP_SECRET=<from Meta for Developers>
  AUTOMATION_CRON_SECRET=<random hex>
  STORAGE_DIR=/var/lib/wacrm-storage
  # optional: META_APP_ID, WHATSAPP_TEMPLATES_DRY_RUN, ALLOWED_INVITE_HOSTS…
  ```

- **Mount a volume** at `/var/lib/wacrm-storage` (Dokploy → Advanced →
  Volumes) — uploaded media lives there. Without it, uploads vanish on
  every redeploy.
- Attach your **domain** to container port **3000**.

## 2. After the first deploy

- Log in with the seed user `demo@wacrm.local` / `Demo123!` or register
  (signups are auto-confirmed; there is no email verification step).
- Live inbox updates need nothing special — no logical replication, no
  extra services. The LISTEN/NOTIFY triggers ship with migration 040.
- Point the Meta webhook at
  `https://your-domain/api/whatsapp/webhook` once WhatsApp is configured
  in Settings.

## Gotchas

- `NEXT_PUBLIC_SITE_URL` (in `env/next-public.production`) must be the
  URL users' browsers reach the app on — it is also the base for public
  media URLs Meta fetches. Changing it requires a rebuild.
- Password-reset emails are not available (there is no mail service);
  a workspace owner changes passwords from Settings instead.
- Back up two things: the Postgres database and the
  `/var/lib/wacrm-storage` volume.
- Restrict Postgres (port 5432) to the app host — the database no longer
  needs to be reachable from anywhere else.
