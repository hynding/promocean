# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Promocean CMS (Strapi 5) — multi-stage build for a pnpm/turbo monorepo.
#
# Base image: node:22-alpine. Strapi pulls in `sharp` (native, libvips) which
# is the known musl risk. sharp 0.33+ ships musl prebuilt binaries and
# `libc6-compat` covers the remaining glibc symbol lookups, so alpine builds
# and runs. If a future sharp/libvips bump breaks under musl, switch every
# `node:22-alpine` below to `node:22-slim`, drop the `apk add libc6-compat`
# line, and this Dockerfile keeps working unchanged otherwise.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
# libc6-compat: glibc shim so sharp's musl prebuilt resolves cleanly.
RUN apk add --no-cache libc6-compat && corepack enable
WORKDIR /app

# --- Stage 1: prune the monorepo down to just the `cms` package + its deps ---
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2 prune cms --docker

# --- Stage 2: install (with dev deps) and build the Strapi admin ---
FROM base AS installer
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `strapi build` (run via turbo) compiles the admin panel; it needs devDeps.
RUN pnpm turbo run build --filter=cms
# Drop dev deps in place; the built admin lives in apps/cms/build + .strapi and
# survives the prune (only node_modules is pruned).
RUN pnpm prune --prod

# --- Stage 3: minimal non-root runtime ---
FROM base AS runner
ENV NODE_ENV=production
COPY --from=installer --chown=node:node /app .
USER node
EXPOSE 1337
# Strapi exposes /_health returning 204 with no auth — perfect for a probe.
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=10 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||1337)+'/_health',r=>process.exit(r.statusCode===204||r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
# `strapi start` serves the prebuilt admin (NODE_ENV=production). Exec the
# workspace-local bin shim directly (not via `node`): its `#!/bin/sh` shebang
# sets the pnpm NODE_PATH Strapi needs, then `exec node bin/strapi.js`, so the
# real node process becomes PID 1's child and receives SIGTERM for clean stops.
WORKDIR /app/apps/cms
CMD ["node_modules/.bin/strapi", "start"]
