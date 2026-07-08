# Sprint 6 Design: Dockerized Stack & Pre-Deploy Hardening

**Date:** 2026-07-08
**Theme:** Ship-shape — the whole platform runs as production-style containers
with one command, and every "must land before deploy" issue is closed, so the
artifact is genuinely exposable.
**Parent spec:** `2026-07-06-promocean-design.md` §5b (hosting — platform
decision deliberately deferred; local Docker chosen for now)
**Branch:** `sprint-6-docker-hardening` (off `main` at the PR #16 merge)

## 1. Scope

In scope (decided with Steve, 2026-07-08):

1. **Prod-style Docker images** for `api`, `cms`, `demo` — multi-stage
   `turbo prune --docker` builds, slim runtimes
2. **Full-stack compose** behind a `stack` profile (dev flow unchanged),
   healthcheck-gated ordering, documented env contract (including the missing
   `apps/api/.env.example`)
3. **CI builds the images and runs e2e against the compose stack** (replacing
   the hand-rolled service boot in `ci.yml`)
4. **Issue #8** — webhook delivery hardening (all seven items; ~2 tasks)
5. **Issue #10** — rate-limiter bucket eviction + negative auth-cache cap
6. **Issue #13** — offer-id validation on impression/click routes
7. **Issues #11 + #14** — fast-follow polish + test-hardening sweep

Out of scope: cloud deploy accounts (Fly/Railway/Vercel), Sentry (needs a
DSN), first npm publish (needs NPM_TOKEN), remaining v1.x roadmap features.

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Hosting target | Local Dockerized stack, no cloud accounts | Steve's call (pivot from the spec's Fly/Railway spike). The images + compose double as the self-host artifact; any future cloud move takes Dockerfiles as-is. |
| Image build strategy | `turbo prune --docker` multi-stage | Turborepo's canonical monorepo-Docker pattern; per-app lockfile subsets cache layers well. Rejected: `pnpm deploy` (fussier with workspace: protocol); single mono-image (huge, no per-app caching). |
| Compose shape | Extend existing `docker-compose.yml` with `cms`/`api`/`demo` services behind a `stack` profile | `docker compose up -d postgres` dev flow stays byte-identical; `--profile stack` opts into the full stack. |
| CI depth | Build images AND run Playwright against the compose stack | Images and compose file can't rot when the merge gate exercises them. Rejected: build-only (a compiling image can still be broken at runtime). |
| Demo build-time env | `NEXT_PUBLIC_*` as Docker build args with localhost-stack defaults | Next bakes `NEXT_PUBLIC_*` into the browser bundle at build time; runtime env cannot change them. `PROMOCEAN_SECRET_KEY` stays runtime-only (server component). |
| Migrations | Keep running at api boot | Single-instance semantics; already how dev/CI work. Documented limitation: multi-replica rollout needs a migration job (future cloud sprint). |
| Sentry | Deferred | Needs a DSN from an account that doesn't exist; contradicts the local-only pivot. pino remains the observability story. |

## 3. Architecture

### 3.1 Images

Three Dockerfiles (`apps/api/Dockerfile`, `apps/cms/Dockerfile`,
`apps/demo/Dockerfile`), each multi-stage on `node:22-alpine`. The base image
is an implementation default, not a contract: if native deps fight musl
(Strapi's `sharp` is the known risk), that app's Dockerfile falls back to
`node:22-slim` (glibc) — document the choice in the Dockerfile. Healthchecks
must use tools present in the final image (busybox `wget` on alpine, or a
node one-liner) — no assuming `curl`.

Stages:

1. **prune** — `turbo prune <pkg> --docker` produces `out/json` (manifests +
   lockfile subset) and `out/full` (source).
2. **install+build** — `pnpm install --frozen-lockfile` on the json layer
   (cache-friendly), copy full source, `turbo run build` for the app.
3. **runtime** — slim stage with only the built output and production deps;
   non-root user; `NODE_ENV=production`.

Entrypoints: api `node dist/index.js` (runs migrations at boot — single
instance); cms `strapi start` with the admin panel built at image build; demo
Next `output: 'standalone'` → `node server.js`. The demo Dockerfile accepts
`NEXT_PUBLIC_PROMOCEAN_KEY` / `NEXT_PUBLIC_PROMOCEAN_API` build args
(defaults: the seeded demo pk key and `http://localhost:3001` — correct for
the local stack because the browser, not the container, resolves that URL).

### 3.2 Compose

Existing `docker-compose.yml` grows three services under
`profiles: ["stack"]`; `postgres` stays profile-less (dev flow unchanged) and
gains a `pg_isready` healthcheck.

- `cms`: depends_on postgres healthy; healthcheck on the Strapi HTTP port;
  seeds demo data on an empty DB (`SEED_DEMO`); env from the root `.env`.
- `api`: depends_on postgres + cms healthy; healthcheck hits `/readyz`
  (Sprint 4 endpoint — checks DB + config plane); `STRAPI_URL=http://cms:1337`.
- `demo`: depends_on api healthy; `PROMOCEAN_SECRET_KEY` runtime env;
  server-side stats calls use `PROMOCEAN_API_URL=http://api:3001` (in-network)
  while the browser uses the baked `NEXT_PUBLIC_PROMOCEAN_API=http://localhost:3001`.

Host ports preserved: 5433 (pg), 1337 (cms), 3001 (api), 3002 (demo). Root
`.env.example` documents the full stack contract; `apps/api/.env.example`
created (`DATABASE_URL`, `STRAPI_URL`, `CONFIG_PLANE_SECRET`, `API_PORT`,
`RATE_LIMIT_PER_MINUTE`, `LOG_LEVEL`).

### 3.3 CI

`ci.yml`'s e2e job: build the three images (layer cache via GitHub Actions
cache), `docker compose --profile stack up -d --wait`, run the existing
Playwright suite against `localhost:3002`, dump compose logs on failure, tear
down. The unit/typecheck job is unchanged. Image builds also run on PRs so a
broken Dockerfile blocks merge.

### 3.4 Webhook hardening (#8)

- **Migration 0004:** `timed_event_notifications` gains `delivered_at
  timestamptz` (null = claimed-but-unconfirmed) and `attempts integer`.
  Dispatcher marks `delivered_at` on success; dead-letters record as today.
- **Redelivery:** each scheduler tick re-drives claims older than a grace
  window (default 5 min) that are neither delivered nor dead-lettered —
  at-least-once delivery restored; consumer-side dedup via the new message id.
- **Message id + replay docs:** webhook payloads gain a `messageId` (uuid) —
  an additive change to the contracts webhook message schema; README
  documents consumer dedup + a recommended replay-window check on the signed
  `createdAt`.
- **Dead-letter retention:** scheduler sweep deletes dead letters older than a
  TTL (default 30 days, env-tunable).
- **Graceful shutdown:** `apps/api/src/index.ts` handles SIGTERM/SIGINT —
  stop the lifecycle scheduler (its discarded `stop()` gets wired), close the
  HTTP server, end the pg pool. Containers make this real: `docker stop`
  sends SIGTERM and waits 10s before SIGKILL.
- **Ended-event scan growth:** the CMS `timed-events/all` endpoint filters
  `endsAt > now - grace` so historical events stop costing per-tick work.
  **Window-ordering constraint:** the scan filter's grace MUST exceed the
  redelivery window (scan default 60 min vs redelivery 5 min) — a re-driven
  `ended` transition must still be able to resolve its event definition from
  the feed. Encode both as env-tunable values and assert the ordering at
  scheduler startup (warn + clamp, don't crash).
- **Documented tradeoffs:** SSRF posture (dispatcher POSTs to
  customer-controlled URLs; private-IP blocking is future multi-tenant work)
  and disabled-after-live events (no `ended` webhook fires; documented).

### 3.5 Rate-limiter memory (#10)

`apps/api/src/rate-limit.ts`: on window rollover, lazily sweep expired
buckets; cap total buckets (default 10k, env-tunable) — when full, new keys
share a single overflow bucket (still rate-limited, never unlimited, never
hard-denied). adapter-strapi: cap the
negative (`null`) auth-cache entries (bounded map, oldest-evicted) so random
invalid keys cannot grow the heap unboundedly.

### 3.6 Offer-id validation (#13)

Impression and click routes verify `:id` against the project's cached offer
config (`getOffers`); unknown → 404 with the standard envelope, using a
`not_found` error code (added to the contracts catalog if absent — additive). Config-plane
failure falls back to accepting (fail-open, matching ingestion's posture —
availability over strictness for pk-facing writes; documented inline).

### 3.7 Polish + test hardening (#11, #14)

One sweep pass: route-level warn logs and webhook logs carry `requestId`
(child loggers); `files` allowlists in contracts/sdk/widgets package.json;
`release.yml` pushes tags and runs tests before publish; a static Redoc page
served at `GET /docs` rendering `/v1/openapi.json`; log-retention note beside
the MAU-retention decision; `docs/retros/` created with a Sprint 0-5
retro-notes stub; changeset authoring note. Tests: N-way concurrent ingestion
race loop; StrictMode-wrapped beacon test; `statsQuerySchema` and
impression optional-userId contract tests; `nameById` fallback (drop the
non-null assertion); suggester distance-2/3 boundary pair.

## 4. Error handling

- Compose: healthcheck-gated `depends_on` prevents connect-before-ready;
  `--wait` surfaces boot failures with non-zero exit in CI.
- Shutdown: in-flight requests get a bounded drain (server.close + timeout)
  before pool teardown; scheduler stops first so no new webhook work starts.
- Redelivery: idempotent — a re-driven claim that already delivered is a
  no-op (delivered_at check); consumers dedup by `messageId`.
- Rate limiter at cap: new keys are still rate-limited via a shared overflow
  bucket rather than unlimited (fail-safe, documented).

## 5. Testing

- Testcontainers: redelivery (claim, crash before deliver, sweep re-drives),
  retention sweep, delivered_at marking.
- API (fakes): offer-id validation paths (known/unknown/config-failure),
  rate-limiter eviction + cap behavior (unit-level with fake clock).
- adapter-strapi: negative-cache cap eviction.
- e2e: existing 3 specs run against the compose stack — locally (DoD) and in
  CI. No new specs; the environment change IS the test.
- CI: image builds on PR; compose-based e2e replaces hand-rolled boot.
- #14 list lands as unit tests in their respective packages.

## 6. Definition of done

Clean clone + `.env` + `docker compose --profile stack up` → seeded working
stack; 3/3 Playwright specs green against the containers locally AND in CI;
`pnpm turbo run typecheck build test` green; issues #8, #10, #11, #13, #14
closable; docs updated (root README quickstart gains the one-command boot).
