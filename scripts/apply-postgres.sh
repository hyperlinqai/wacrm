#!/usr/bin/env bash
# Apply WA-CRM Supabase migrations onto a stock Postgres database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"

if [[ -z "${DATABASE_URL:-}" && -f "$ENV_FILE" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set (and was not found in $ENV_FILE)" >&2
  exit 1
fi

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q)

echo "Bootstrapping auth / storage / roles…"
"${PSQL[@]}" -f "$ROOT/supabase/postgres-compat/000_bootstrap.sql"

# DB roles the app connects with (authenticator + the RLS roles it can
# assume). SVC_PASSWORD becomes the authenticator password — put it in
# the app's DATABASE_URL.
if [[ -n "${SVC_PASSWORD:-}" ]]; then
  echo "Configuring app service roles…"
  "${PSQL[@]}" -v svc_password="$SVC_PASSWORD" \
    -f "$ROOT/supabase/postgres-compat/010_service_roles.sql"
else
  echo "  skip service roles (set SVC_PASSWORD to create the app's DB login)"
fi

apply_sql() {
  local file="$1"
  local version
  version="$(basename "$file")"
  local already
  already="$("${PSQL[@]}" -tAc "SELECT 1 FROM public.schema_migrations WHERE version = '$version'")"
  if [[ "$already" == "1" ]]; then
    echo "  skip $version (already applied)"
    return
  fi
  echo "  apply $version"
  if [[ "$version" == "030_ai_knowledge.sql" || "$version" == "032_fix_ai_knowledge_membership.sql" ]]; then
    python3 - "$file" <<'PY' | "${PSQL[@]}"
import re, sys
src = open(sys.argv[1]).read()
src = src.replace("CREATE EXTENSION IF NOT EXISTS vector;", "SELECT 1;")
src = src.replace("embedding    vector(1536),", "embedding    text,")
src = re.sub(
    r"CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_idx\n  ON ai_knowledge_chunks USING hnsw \(embedding vector_cosine_ops\);",
    "-- skipped: pgvector is not installed on this server",
    src,
)
src = src.replace(
    "(c.embedding <=> p_query_embedding::vector(1536)) AS distance",
    "NULL::real AS distance",
)
src = src.replace(
    "ORDER BY c.embedding <=> p_query_embedding::vector(1536)",
    "ORDER BY c.id",
)
print(src)
PY
  else
    "${PSQL[@]}" -f "$file"
  fi
  "${PSQL[@]}" -c "INSERT INTO public.schema_migrations (version) VALUES ('$version') ON CONFLICT DO NOTHING;"
}

echo "Applying migrations…"
for file in "$ROOT"/supabase/migrations/*.sql; do
  apply_sql "$file"
done

echo "Verifying schema…"
"${PSQL[@]}" -f "$ROOT/supabase/ci/verify-schema.sql"

echo "Seeding demo data…"
"${PSQL[@]}" -f "$ROOT/supabase/postgres-compat/999_seed.sql"

echo "Done."
