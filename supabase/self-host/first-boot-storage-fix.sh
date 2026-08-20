#!/usr/bin/env bash
# One-time fix for the Storage API's first boot against a database that
# already ran the WA-CRM migrations: its 'storage-schema' migration must
# DROP+recreate storage.foldername(text), which fails while our RLS
# policies on storage.objects depend on it.
#
# This drops the policies, restarts the storage container so its
# migrations complete, then restores the policies from the committed
# snapshot. Needs DATABASE_URL (or .env.local at the repo root).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"

if [[ -z "${DATABASE_URL:-}" && -f "$ENV_FILE" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
fi
[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL is not set" >&2; exit 1; }

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q)

echo "Dropping storage.objects policies…"
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies
           WHERE schemaname = 'storage' AND tablename = 'objects' LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects', p.policyname);
  END LOOP;
END
$$;
SQL

echo "Restarting storage so its migrations can run…"
docker compose -f "$ROOT/supabase/self-host/docker-compose.yml" restart storage
for i in $(seq 1 30); do
  if docker compose -f "$ROOT/supabase/self-host/docker-compose.yml" logs storage --since 20s 2>/dev/null \
      | grep -q "Started Successfully"; then
    break
  fi
  sleep 2
done

echo "Restoring policies…"
"${PSQL[@]}" -f "$ROOT/supabase/postgres-compat/020_storage_object_policies.sql"
echo "Done."
