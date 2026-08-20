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
# time from env/next-public.production (copied to .env.production in
# the builder). Override by editing that file and rebuilding.
# Server-only secrets (service role key, ENCRYPTION_KEY, META_APP_SECRET)
# are read at runtime and must NOT be baked into the image.
# ---------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Git / Hostinger builds do not have gitignored .env.production.
# Public NEXT_PUBLIC_* values live in-repo so `docker build` can prerender.
COPY env/next-public.production .env.production
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN npm run build

# ---------------------------------------------------------------
# Stage 3 — minimal runtime (standalone output)
# ---------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs \
    # Media volume mount point (STORAGE_DIR) — pre-owned by the app user
    # so the named volume inherits writable permissions on first use.
    && mkdir -p /var/lib/wacrm-storage && chown nextjs:nextjs /var/lib/wacrm-storage

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
