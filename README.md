# Promocean

Achievements, offers, and live promotional events for any website or app — one API.

Monorepo: pnpm + Turborepo. See `docs/superpowers/specs/` for the design spec.

## Quickstart (dev)

    corepack enable && pnpm install
    pnpm build
    cp .env.example .env
    pnpm db:up
    pnpm dev

The `dev` task starts every app in parallel via Turborepo, but `cms` and `api`
each need their own environment configured first — see below for a from-scratch
setup that boots the full stack (cms + api + demo) and proves the achievement
loop end to end.

Note: `.env.example` sets `SEED_DEMO=true`, which seeds a publicly known demo
publishable key (`pk_test_demo_…`) — fine for local dev and CI, but this must
never be enabled in a staging or production environment.

### Running the full stack manually

From the repo root, first run `pnpm install` then `pnpm build` (workspace packages
must be built once so `cms`/`api`/`demo` can resolve each other's `dist/`). Then, in
three terminals:

    # 1. Postgres + Strapi CMS (reads apps/cms/.env — see apps/cms/.env.example)
    pnpm db:up
    pnpm --filter cms dev

    # 2. Runtime API (reads process.env directly — no .env file; pass inline)
    DATABASE_URL=postgres://promocean:promocean@localhost:5433/promocean \
    CONFIG_PLANE_SECRET=dev-config-secret \
    STRAPI_URL=http://localhost:1337 \
    API_PORT=3001 \
    pnpm --filter api dev

    # 3. Demo app (reads apps/demo/.env.local — copy apps/demo/.env.example)
    cp apps/demo/.env.example apps/demo/.env.local
    pnpm --filter demo dev

Note: Postgres is published on host port **5433** (`docker-compose.yml` maps
`5433:5432`), not the default 5432.

Open `http://localhost:3002/?user=manual-1` and click **Complete a lesson** —
you should see a "🏆 Achievement unlocked — First Lesson" toast and the badge
cabinet showing First Lesson 1/1 unlocked, Getting Started 1/10 in progress.

### End-to-end tests

The Playwright spec at `apps/demo/e2e/achievement-loop.spec.ts` drives the demo
app in a real browser and proves the track → unlock → badge-cabinet loop. With
cms + api already running (per above):

    pnpm --filter demo exec playwright install chromium
    pnpm --filter demo e2e

This is also run in CI as the `e2e` job in `.github/workflows/ci.yml`, which
boots Postgres, cms, and api with throwaway secrets before running the spec.
