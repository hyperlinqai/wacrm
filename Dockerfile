# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# Stage 1 — install dependencies (cached until package*.json change)
# ---------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------
# Stage 2 — build
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build
# time, so they must be provided as build args (docker-compose.yml
# forwards them from .env.local). Server-only secrets (service role
# key, ENCRYPTION_KEY, META_APP_SECRET, ...) are read at runtime and
# must NOT be baked into the image.
# ---------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Optional build-args (docker compose --env-file …). Do NOT `ENV` them
# unconditionally: an empty ARG would override `.env.production` and
# make `next build` prerender /forgot-password without a Supabase URL.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN set -e; \
    if [ -n "$NEXT_PUBLIC_SUPABASE_URL" ]; then \
      printf '%s\n' \
        "NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}" \
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
        "NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}" \
        "NEXT_PUBLIC_APP_LOCALE=${NEXT_PUBLIC_APP_LOCALE:-en}" \
        > .env.production.local; \
    fi; \
    has_url=0; \
    for f in .env.production .env.production.local; do \
      if [ -f "$f" ] && grep -qE '^NEXT_PUBLIC_SUPABASE_URL=.+' "$f"; then has_url=1; fi; \
    done; \
    if [ "$has_url" != 1 ]; then \
      echo "NEXT_PUBLIC_SUPABASE_URL is missing. Add .env.production or pass --build-arg NEXT_PUBLIC_SUPABASE_URL=..." >&2; \
      exit 1; \
    fi; \
    npm run build

# ---------------------------------------------------------------
# Stage 3 — minimal runtime (standalone output)
# ---------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
