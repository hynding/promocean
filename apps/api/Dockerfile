# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Promocean API (Hono) — multi-stage build for a pnpm/turbo monorepo.
#
# Base image: node:22-alpine. The API's only heavy native dependency is `pg`,
# which ships a pure-JS fallback and builds cleanly against musl, so alpine is
# safe here (no musl fallback needed, unlike the CMS's sharp).
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# --- Stage 1: prune the monorepo down to just the `api` package + its deps ---
FROM base AS pruner
COPY . .
# turbo@2 matches the repo's turbo major (package.json: "turbo": "^2.5.4").
RUN pnpm dlx turbo@2 prune api --docker

# --- Stage 2: install (with dev deps) and build ---
FROM base AS installer
# Install deps first from the pruned lockfile for maximal layer caching.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
# Then bring in pruned source and build api (+ its workspace deps via ^build).
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=api
# Strip dev dependencies in place, leaving prod node_modules + the built
# workspace package dist/ outputs (workspace links are preserved).
RUN pnpm prune --prod

# --- Stage 3: minimal non-root runtime ---
FROM base AS runner
ENV NODE_ENV=production
# node:alpine ships an unprivileged `node` user (uid 1000); run as it.
COPY --from=installer --chown=node:node /app .
USER node
EXPOSE 3001
# Healthcheck via node's built-in http (no curl/wget assumption); hits /readyz.
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/readyz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
