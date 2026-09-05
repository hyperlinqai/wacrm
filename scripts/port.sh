#!/usr/bin/env sh
# Resolve a local dev port for the npm scripts.
#
#   scripts/port.sh web   ->  4310
#   scripts/port.sh api   ->  4311
#
# Why a script instead of just putting PORT in .env.local: Next boots its
# HTTP server before any .env file is read, so `PORT=…` in .env.local is
# silently ignored (see node_modules/next/dist/docs/01-app/03-api-reference/
# 06-cli/next.md, "Changing the default port"). The port has to reach Next
# as an argv flag, so the scripts ask this helper and pass --port.
#
# Where the values come from, first match wins:
#   1. WEB_PORT / API_PORT already exported in the shell
#      (`WEB_PORT=5000 npm run dev:web` for a one-off)
#   2. WEB_PORT / API_PORT in apps/web/.env.local — the one env file both
#      apps share (apps/api/.env.local is a symlink to it)
#   3. the port already inside API_ORIGIN, for the API only, so the port
#      the web app rewrites /api/* to and the port the API listens on
#      cannot drift apart
#   4. the built-in defaults below
#
# The defaults are deliberately NOT Next's 3000/3001: on a machine with
# more than one Node project those are almost always taken, and a dev
# server that loses the race silently picks a different port while
# API_ORIGIN keeps pointing at the old one.
set -e

WEB_PORT_DEFAULT=4310
API_PORT_DEFAULT=4311

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${WACRM_ENV_FILE:-$ROOT/apps/web/.env.local}

# Read one key out of the env file. Grepping a single key beats sourcing
# a file full of secrets, which would run any `$(…)` in a value as shell.
# Last assignment wins, mirroring how dotenv resolves duplicates.
read_var() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null |
    tail -n1 |
    cut -d= -f2- |
    tr -d " \"'\r"
}

case "$1" in
  web)
    port=${WEB_PORT:-$(read_var WEB_PORT)}
    echo "${port:-$WEB_PORT_DEFAULT}"
    ;;
  api)
    port=${API_PORT:-$(read_var API_PORT)}
    if [ -z "$port" ]; then
      # e.g. "http://localhost:4311" -> "4311"
      port=$(read_var API_ORIGIN | sed -n 's#.*:\([0-9][0-9]*\)/*$#\1#p')
    fi
    echo "${port:-$API_PORT_DEFAULT}"
    ;;
  *)
    echo "usage: scripts/port.sh web|api" >&2
    exit 1
    ;;
esac
