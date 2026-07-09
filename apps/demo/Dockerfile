# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Promocean demo (Next.js 16, App Router) — multi-stage build.
#
# Base image: node:22-alpine (no native deps of concern).
#
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so
# they arrive as Docker build args and are exported to the env before
# `next build`. Only the publishable key + browser API URL are baked (both
# non-secret). The secret key (PROMOCEAN_SECRET_KEY) and server-side
# PROMOCEAN_API_URL are RUNTIME env, injected by compose, never baked.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# --- Stage 1: prune the monorepo down to just the `demo` package + its deps --
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2 prune demo --docker

# --- Stage 2: install (with dev deps) and build the standalone server ---
FROM base AS installer
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# Build-time public config (safe to embed in the client bundle).
ARG NEXT_PUBLIC_PROMOCEAN_KEY=pk_test_demo_1234567890abcdef
ARG NEXT_PUBLIC_PROMOCEAN_API=http://localhost:3001
ENV NEXT_PUBLIC_PROMOCEAN_KEY=$NEXT_PUBLIC_PROMOCEAN_KEY \
    NEXT_PUBLIC_PROMOCEAN_API=$NEXT_PUBLIC_PROMOCEAN_API \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build --filter=demo

# --- Stage 3: minimal non-root runtime (standalone, no pnpm/full deps) ---
FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3002 HOSTNAME=0.0.0.0
# Standalone output is self-contained: server.js + traced node_modules.
COPY --from=installer --chown=node:node /app/apps/demo/.next/standalone ./
COPY --from=installer --chown=node:node /app/apps/demo/.next/static ./apps/demo/.next/static
COPY --from=installer --chown=node:node /app/apps/demo/public ./apps/demo/public
USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3002)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "apps/demo/server.js"]
