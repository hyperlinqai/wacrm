# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# Stage 1 — install dependencies (cached until any package.json changes)
#
# Copy every workspace's package.json (not the whole tree) before
# `npm ci` so Docker's layer cache survives source-only changes —
# only editing a package.json anywhere invalidates this layer.
# ---------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp-server/package.json apps/mcp-server/package.json
COPY packages/roles/package.json packages/roles/package.json
RUN npm ci

# ---------------------------------------------------------------
# Stage 2 — build (apps/web only — this image serves the Next.js app;
# apps/mcp-server is published to npm separately, not deployed here)
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build
# time from apps/web/env/next-public.production (copied to
# apps/web/.env.production in the builder). Override by editing that
# file and rebuilding. Server-only secrets (service role key,
# ENCRYPTION_KEY, META_APP_SECRET) are read at runtime and must NOT be
# baked into the image.
# ---------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Git / Hostinger builds do not have gitignored .env.production.
# Public NEXT_PUBLIC_* values live in-repo so `docker build` can prerender.
COPY apps/web/env/next-public.production apps/web/.env.production
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN npm run build --workspace=apps/web

# ---------------------------------------------------------------
# Stage 3 — minimal runtime (standalone output)
#
# `outputFileTracingRoot` (apps/web/next.config.ts) points Next's
# tracer at the monorepo root, so `apps/web/.next/standalone`
# reproduces the whole relevant subtree — hoisted node_modules,
# apps/web/server.js, apps/web/package.json — rooted at /app exactly
# like a single-package build would put server.js at /app/server.js.
# Static assets and public/ are excluded from that trace by design and
# must be copied in separately, at their real nested path.
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

COPY --from=builder --chown=nextjs:nextjs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
