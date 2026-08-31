# Running with Docker

The repo ships two multi-stage Dockerfiles (Next.js standalone output,
both run as a non-root user) and a `docker-compose.yml` with three
services:

| Service | Image | Role |
| --- | --- | --- |
| `proxy` | `caddy:2-alpine` | The only service that publishes a port. Routes `/api/*` to `api` and everything else to `web` (see `Caddyfile`). |
| `web` | `Dockerfile` | The UI. No database credentials. |
| `api` | `Dockerfile.api` | The HTTP API. Owns `DATABASE_URL` and the media volume. |

Splitting the API out lets the two build, deploy and scale
independently. Keeping them behind one origin is deliberate and not
negotiable in an existing deployment: absolute URLs built from
`NEXT_PUBLIC_SITE_URL` are stored in the database (`profiles.avatar_url`
and the media URLs on message rows), the Meta webhook is registered
against that host, and lead-form widgets are already embedded on
customer pages pointing at it. Give the API its own hostname and all
three break.

The database is external — point `DATABASE_URL` at your Postgres
(schema applied with `scripts/apply-postgres.sh`); no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp apps/web/.env.local.example apps/web/.env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `apps/web/.env.local`):

   ```bash
   docker compose --env-file apps/web/.env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `apps/web/.env.local`).
   That port belongs to `proxy`; `web` and `api` are reachable only from
   inside the Compose network.

Both services read the same `env_file`. They overlap on `JWT_SECRET`
(the API signs session cookies, the UI's proxy verifies and slides
them) and `NEXT_PUBLIC_SITE_URL`, so keep one file rather than two —
a `JWT_SECRET` that differs between them signs everyone out.

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time** from the in-repo `apps/web/env/next-public.production` (they are
  browser-facing, not secrets). If you change any of them, rebuild:
  `docker compose --env-file apps/web/.env.local up --build -d`.
- Everything else (`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `apps/web/.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

You need both images plus something routing `/api/*` between them. If
you are doing this by hand, put your own reverse proxy in front:

```bash
docker build -t wacrm-web -f Dockerfile .
docker build -t wacrm-api -f Dockerfile.api .

docker network create wacrm

docker run -d --network wacrm --name api --env-file apps/web/.env.local \
  -e PORT=3001 \
  -e STORAGE_DIR=/var/lib/wacrm-storage \
  -v wacrm-storage:/var/lib/wacrm-storage \
  wacrm-api

docker run -d --network wacrm --name web --env-file apps/web/.env.local \
  -e PORT=3000 wacrm-web
```

Then point a proxy at `web:3000`, with `/api/*` going to `api:3001`.
The bundled `Caddyfile` is a working example — note the SSE settings on
the `/api/*` route: `/api/realtime` is a long-lived Server-Sent Events
stream, and a proxy that buffers responses or times idle connections out
will break realtime updates.

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
- Uploaded media is served by the **api** service, at the
  `/api/storage/object/public/*` URL shape already stored on rows in the
  database. The `storage-data` volume mounts there, not on `web`.
- Nothing inside the container is scheduled. If you use automation
  Wait steps or flows, point an external scheduler at
  `GET /api/automations/cron` and `GET /api/flows/cron` on this
  deployment, sending the shared secret in the `x-cron-secret` header
  (`AUTOMATION_CRON_SECRET`, see `apps/web/.env.local.example`). Both return
  503 until that variable is set.
