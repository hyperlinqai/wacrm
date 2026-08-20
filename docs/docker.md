# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with a single
`app` service. The database is external — point `DATABASE_URL` at your
Postgres (schema applied with `scripts/apply-postgres.sh`); no database
container is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time** from the in-repo `env/next-public.production` (they are
  browser-facing, not secrets). If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`.
- Everything else (`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 \
  -e STORAGE_DIR=/var/lib/wacrm-storage \
  -v wacrm-storage:/var/lib/wacrm-storage \
  -p 3000:3000 wacrm
```

## Notes

- Database migrations under `supabase/migrations/` are **not** run by
  the container — apply them with `scripts/apply-postgres.sh`.
- Uploaded media (avatars, chat and flow media) lives on the
  `storage-data` volume mounted at `/var/lib/wacrm-storage`. Include it
  in backups alongside the database.
- Received attachments are copied into the `chat-media` bucket on that
  volume, because Meta deletes media roughly 30 days after it arrives
  and the copy is the only thing that outlives that. It grows with
  inbound volume, so watch disk space. Turn it off per account under
  Settings → WhatsApp → Attachment Storage; attachments received while
  it's off become unviewable once Meta drops them. Files over 16 MB
  (the bucket's limit) are never copied.
- Nothing inside the container is scheduled. If you use automation
  Wait steps or flows, point an external scheduler at
  `GET /api/automations/cron` and `GET /api/flows/cron` on this
  deployment, sending the shared secret in the `x-cron-secret` header
  (`AUTOMATION_CRON_SECRET`, see `.env.local.example`). Both return
  503 until that variable is set.
