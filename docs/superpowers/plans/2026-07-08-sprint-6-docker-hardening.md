# Promocean Sprint 6: Dockerized Stack & Pre-Deploy Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The whole platform boots as production-style containers with one command (`docker compose --profile stack up`), CI exercises those containers on every merge, and every "must land before deploy" issue (#8, #10, #11, #13, #14) is closed.

**Architecture:** Hardening lands first (it ships inside the images), Docker second, CI last. Images are per-app multi-stage `turbo prune --docker` builds; compose gains a `stack` profile so the dev flow (`docker compose up -d postgres` + host servers) is untouched; webhook redelivery/shutdown work rides the existing dispatcher/scheduler seams in `apps/api/src/webhooks.ts`.

**Spec:** `docs/superpowers/specs/2026-07-08-sprint-6-docker-hardening-design.md`. Branch `sprint-6-docker-hardening` off main (PR #16 merge).

## Global Constraints

(All prior global constraints bind: error envelope `{ error: { code, message, details? } }`, zod contracts single source of truth, TDD per task, per-package gates green before commit, known-break pattern recorded when a shared port widens.)

Sprint-6 additions (values verbatim from the spec):
- Compose: new services under `profiles: ["stack"]`; `postgres` stays profile-less and gains a `pg_isready` healthcheck. Host ports preserved: 5433 (pg), 1337 (cms), 3001 (api), 3002 (demo). Dev flow `docker compose up -d postgres` must remain byte-identical in behavior.
- Images: multi-stage `turbo prune <pkg> --docker`; base `node:22-alpine` is a default not a contract — fall back to `node:22-slim` if native deps (Strapi `sharp`) fight musl, documenting the choice in the Dockerfile. Healthchecks use tools present in the final image (busybox `wget` or a node one-liner) — never assume `curl`. Non-root user, `NODE_ENV=production`.
- Demo image: `NEXT_PUBLIC_PROMOCEAN_KEY` / `NEXT_PUBLIC_PROMOCEAN_API` are **build args** (defaults `pk_test_demo_1234567890abcdef` / `http://localhost:3001` — the browser resolves that URL, not the container). `PROMOCEAN_SECRET_KEY` is runtime-only. In-network server-side stats calls use `PROMOCEAN_API_URL=http://api:3001`.
- Webhook payloads gain `messageId` (uuid) — additive to `webhookMessageSchema`. Error catalog gains `not_found` — additive.
- Redelivery: claims older than `WEBHOOK_REDELIVERY_GRACE_MINUTES` (default 5) that are neither delivered nor exhausted get re-driven each tick; re-drive attempts capped at 5, then dead-letter + mark delivered (stop the loop). Dead letters older than `WEBHOOK_DEAD_LETTER_TTL_DAYS` (default 30) are swept.
- Ended-event scan filter: cms `timed-events/all` accepts `?endedWithinMinutes=`; the api always sends it from `TIMED_EVENT_SCAN_GRACE_MINUTES` (default 60). **Ordering constraint:** scan grace MUST exceed redelivery grace — assert at scheduler startup, warn + clamp (scan grace := max(scan, redelivery + 5)), never crash.
- Graceful shutdown: SIGTERM/SIGINT → stop scheduler first, then `server.close()` with a 10s drain timeout, then `db.$client.end()`. (`docker stop` sends SIGTERM and waits 10s.)
- Rate limiter: lazy sweep of expired buckets on window rollover; cap total buckets at `RATE_LIMIT_MAX_BUCKETS` (default 10000); at cap, new keys share a single overflow bucket (still limited, never unlimited, never hard-denied). adapter-strapi negative (`null`) auth-cache entries capped (bounded, oldest-evicted; default 1000).
- Offer-id validation: impression/click `:id` not in the project's cached offers → 404 `not_found` envelope; config-plane failure → fail-open (accept + warn), documented inline.

---

### Task 1: contracts — webhook messageId + not_found code

**Files:** Modify `packages/contracts/src/webhooks.ts`, `src/errors.ts`; test append `packages/contracts/test/contracts.test.ts`.

**Interfaces — produces:**
```ts
// webhooks.ts: webhookMessageSchema gains messageId: z.uuid()  (REQUIRED field — the dispatcher is the only producer and Task 3 updates both call sites in the same sprint; consumers dedup on it)
// errors.ts: errorCodeSchema gains 'not_found' (additive)
```
Tests (RED first): message with messageId round-trips; message without messageId rejected; `not_found` accepted by the envelope. **Known break (record, don't patch):** requiring `messageId` breaks `apps/api` webhook tests/dispatch call sites until Task 3 — contracts' own gates green.

Commit: `feat(contracts): webhook message id and not_found error code`

---

### Task 2: core + adapter-db — delivery-status columns, redelivery/retention store methods

**Files:** Modify `packages/core/src/ports.ts` (WebhookDeliveryStore widening), `packages/adapter-db/src/schema.ts`, `src/stores.ts`; create migration `packages/adapter-db/migrations/0004_*` (drizzle-kit generate); test `packages/adapter-db/test/webhook-delivery.test.ts` (extend).

**Schema:** `timedEventNotifications` gains `deliveredAt: timestamp('delivered_at', { withTimezone: true })` (nullable) and `attempts: integer('attempts').notNull().default(0)`. (`fired_at` already exists — it is the claim timestamp; do NOT add another.)

**Interfaces — produces (port additions on WebhookDeliveryStore):**
```ts
markDelivered(projectId: string, eventId: string, transition: TimedEventTransition): Promise<void>
// sets delivered_at = now() on the claim row (idempotent — already-delivered is a no-op update)
findStaleClaims(olderThan: Date, maxAttempts: number): Promise<Array<{ projectId: string; eventId: string; transition: TimedEventTransition; attempts: number }>>
// rows where delivered_at IS NULL AND fired_at < olderThan AND attempts < maxAttempts
incrementAttempts(projectId: string, eventId: string, transition: TimedEventTransition): Promise<void>
deleteDeadLettersBefore(cutoff: Date): Promise<number>  // returns deleted count
```
**Known break:** api fakes/tests referencing WebhookDeliveryStore stay red until Task 3. adapter-db gates green.

Tests (Testcontainers, extend existing file): claim → markDelivered sets delivered_at (raw SQL assert); findStaleClaims returns only null-delivered rows older than cutoff and below maxAttempts (seed a delivered, a fresh, an exhausted, and a stale row); incrementAttempts increments; deleteDeadLettersBefore deletes only older rows and returns count. Migration applies on fresh DB (runMigrations in beforeAll — existing pattern).

Commit: `feat(core,adapter-db): webhook delivery status, stale-claim lookup, dead-letter retention`

---

### Task 3: api — dispatcher delivered-marking, messageId, scheduler redelivery + retention

**Files:** Modify `apps/api/src/webhooks.ts`, `apps/api/src/routes/events.ts` (unlock webhook gains messageId), `apps/api/test/webhooks.test.ts`, `test/fakes.ts` (delivery-store fake gains the four new methods); README webhook section (consumer dedup by `messageId` + replay-window check on signed `createdAt`; SSRF posture note: dispatcher POSTs to customer URLs, private-IP blocking is future multi-tenant work; disabled-after-live events emit no `ended` message — documented).

**Behavior:**
- `WebhookDispatcher.deliver` returns `Promise<void>` still, but `deliverToEndpoint` outcomes are awaited via the existing `Promise.allSettled`; a new public `deliverTransition(projectId, eventId, transition, message)` wraps deliver + `markDelivered` after all endpoints settle (each endpoint either succeeded or dead-lettered — "resolved"). A crash before markDelivered leaves the claim stale → redelivery sweep finds it. The unlock path in events.ts keeps plain `deliver` (unlocks have no claim row) but adds `messageId: crypto.randomUUID()` to its message; the scheduler builds messages with `messageId` too.
- Scheduler tick additions (order): (1) normal transition scan (claim → `deliverTransition`); (2) redelivery sweep — `findStaleClaims(now - redeliveryGraceMs, 5)`, for each: `incrementAttempts`, rebuild the message from the event definition in the feed (fresh `messageId` — consumers dedup per message, the redelivery IS a new message; document this), `deliverTransition`; if the event definition is absent from the feed, `recordDeadLetter(projectId, '<unresolvable>', claimJson, 'event definition no longer in scan window', now)` + `markDelivered` (stop the loop); if `attempts` already ≥ 5 findStaleClaims excludes it, but the 5th failure path dead-letters + marks delivered explicitly; (3) retention sweep — `deleteDeadLettersBefore(now - ttlDays)`, log count when > 0.
- `startLifecycleScheduler` opts gain `{ redeliveryGraceMinutes?: number (default 5), scanGraceMinutes?: number (default 60), deadLetterTtlDays?: number (default 30) }`; startup ordering assert: if `scanGraceMinutes <= redeliveryGraceMinutes`, `logger.warn` and clamp `scanGraceMinutes = redeliveryGraceMinutes + 5`. `index.ts` wires the three envs (`WEBHOOK_REDELIVERY_GRACE_MINUTES`, `TIMED_EVENT_SCAN_GRACE_MINUTES`, `WEBHOOK_DEAD_LETTER_TTL_DAYS`). The scanGrace value is CONSUMED in Task 4 (passed to the config plane); this task only plumbs + asserts it.

Tests (fakes, extend webhooks.test.ts): delivered claim marked after successful dispatch; crash-sim (fake deliver throws) leaves claim unmarked; stale claim re-driven with incremented attempts and fresh messageId; unresolvable stale claim dead-lettered + marked; exhausted (attempts=5) not re-driven; retention sweep called with correct cutoff; ordering assert warns + clamps; every scheduler message carries a uuid messageId. Workspace typecheck fully green again after this task.

Commit: `feat(api): webhook redelivery, dead-letter retention, message ids (closes #8 scope pt 1)`

---

### Task 4: lifecycle plumbing — cms scan filter, adapter param, graceful shutdown

**Files:** Modify `apps/cms/src/api/config-plane/controllers/config-plane.ts` (`timedEventsAll` handler), `packages/adapter-strapi/src/index.ts` + `src/schemas.ts` (constructor opt + query param), `packages/core/src/ports.ts` (NO change — the param rides the adapter constructor, not the port), `apps/api/src/index.ts` (shutdown + wiring); tests `packages/adapter-strapi/test/adapter.test.ts`, cms live-verify.

**Behavior:**
- cms `timedEventsAll`: accepts `?endedWithinMinutes=<int>`; when present and valid (positive int), filters out events with `endsAt < now - endedWithinMinutes`; absent/invalid → unfiltered (backward compatible). Live-verify with curl (filtered vs unfiltered).
- adapter-strapi: `StrapiConfigPlane` constructor opts gain `allTimedEventsEndedWithinMinutes?: number`; when set, `getAllTimedEvents` appends the query param. Test with stub fetch (param present/absent in requested URL).
- api `index.ts`: construct plane with `allTimedEventsEndedWithinMinutes: scanGraceMinutes` (same env as Task 3); **graceful shutdown** — capture `const stopScheduler = startLifecycleScheduler(...)` (currently discarded) and `const server = serve(...)`; on SIGTERM/SIGINT: `stopScheduler()`, `server.close(cb)` with a 10s `setTimeout(..., 10_000).unref()` force-exit fallback, `await db.$client.end()`, `process.exit(0)`. Log each phase. Extract as `installShutdownHandlers({ stopScheduler, server, pool, logger })` in a new `apps/api/src/shutdown.ts` so it's unit-testable with fakes (signal simulated by calling the returned handler directly; assert ordering: scheduler stopped before server.close, pool ended after).

Tests: shutdown.ts unit test (ordering + force-exit timer unref'd, via fake timers); adapter-strapi param tests; cms curl evidence in report. Note for reviewer: readyz probe (`plane.getAllTimedEvents()`) now sees the filtered feed — fine, it checks reachability not completeness.

Commit: `feat(cms,adapter-strapi,api): ended-event scan window and graceful shutdown (closes #8 scope pt 2)`

---

### Task 5: rate-limiter + auth-cache memory bounds (#10)

**Files:** Modify `apps/api/src/rate-limit.ts`, `packages/adapter-strapi/src/index.ts`; tests `apps/api/test/security.test.ts` (extend), `packages/adapter-strapi/test/adapter.test.ts` (extend).

**Behavior:**
- rate-limit.ts: `createRateLimiter(limitPerMinute, opts?: { maxBuckets?: number; now?: () => number })` (now injectable for tests; default `Date.now`). On each request where the requester's own bucket rolls over (`now - windowStart >= WINDOW_MS`), ALSO sweep: iterate the map deleting every expired bucket (lazy full sweep amortized to at most once per window per active key — cheap at 10k cap; note the O(n) bound in a comment). Cap: when `buckets.size >= maxBuckets` (default 10000, env `RATE_LIMIT_MAX_BUCKETS` read in app.ts) and the key is new, use the shared literal key `'__overflow__'` bucket instead of inserting — still counted and 429-able, never unlimited, never denied outright.
- adapter-strapi: negative auth-cache bound — when `verifyKey` caches a `null` value and the count of currently-cached null entries is at `maxNegativeAuthEntries` (constructor opt, default 1000), evict the oldest null entry first (track insertion order — a Set of keyHashes for null entries alongside the existing Map suffices). Positive entries unaffected.

Tests: sweep removes expired buckets (fake `now`, advance a window, assert internal size via behavior: flood N keys in window 1, advance, one request from a fresh key, then assert the overflow path does NOT trigger for the next new key — expose bucket count via an optional test-only accessor `_bucketCount()` documented as test-internal); at-cap new key shares overflow bucket (two new keys at cap 429 together at the shared limit); adapter-strapi: 1001st null-cached key evicts the first null entry (first key re-fetches on next verify — assert fetch call count), positive entries survive.

Commit: `fix(api,adapter-strapi): bound rate-limiter buckets and negative auth cache (closes #10)`

---

### Task 6: offer-id validation on impression/click (#13)

**Files:** Modify `apps/api/src/routes/offers.ts`; tests `apps/api/test/offers.test.ts` (extend).

**Behavior:** Both `POST /:id/click` and `POST /:id/impression`, after body validation: `const offers = await deps.configStore.getOffers(scope.projectId).catch(() => null)`; if `offers !== null && !offers.some((o) => o.id === offerId)` → 404 `{ error: { code: 'not_found', message: 'Unknown offer id.' } }`. `null` (config failure) → fail-open: record + `logger.warn` (availability over strictness for pk-facing writes — inline comment). Recording call unchanged.

Tests: known id → 200 recorded; unknown id → 404, nothing recorded (assert fake untouched); config-store failure → 200 recorded (fail-open); both routes covered.

Commit: `fix(api): validate offer id on impression and click routes (closes #13)`

---

### Task 7: polish sweep (#11)

**Files:** Modify `apps/api/src/routes/events.ts`, `src/routes/placements.ts` (route-level `logger.warn` calls become per-request child loggers: `logger.child({ requestId: c.get('requestId') })` — smallest change: build the child inline where warns occur), `apps/api/src/app.ts` (serve static Redoc page at `GET /docs`: inline HTML string embedding `<redoc spec-url="/v1/openapi.json">` + the Redoc CDN script tag, auth-free alongside openapi.json — note: page loads the viewer from CDN in the browser; the API itself stays dependency-free), `packages/contracts/package.json`, `packages/sdk/package.json`, `packages/widgets/package.json` (add `"files": ["dist", "README.md", "LICENSE"]`), `.github/workflows/release.yml` (add `pnpm turbo run test --filter='./packages/*'` before publish; add `git push --tags` step after publish), root README (log-retention note beside the MAU-retention/erasure docs: external user IDs appear in access-log paths; erasure does not touch logs; document retention expectation), `docs/retros/README.md` (create: one-paragraph retro stubs for Sprints 0-5 sourced from the progress ledger), `.changeset/README-authoring.md` or a note in root README (changesets should list only actually-changed packages).

Tests: existing suites stay green; new test asserts `GET /docs` returns 200 HTML without auth; a log-capture test (pino test transport or spy) asserts a route warn carries `requestId`. `npm pack --dry-run` output for the three packages captured in the report (files allowlist verification).

Commit: `chore: fast-follow polish — request-id logs, docs page, tarball hygiene, release fixes (closes #11)`

---

### Task 8: test-hardening sweep (#14)

**Files:** Modify `packages/adapter-db/test/ingestion.test.ts` (N-way race: 8 parallel `ingestEvent` calls, distinct idempotency keys, same user/achievement target 20 → raw SQL current === 8), `packages/widgets/test/widgets.test.tsx` (render `Placement` inside `<StrictMode>`, assert exactly one beacon call), `packages/contracts/test/contracts.test.ts` (statsQuerySchema: valid Z-datetime accepted, junk rejected, empty object accepted; impression request with userId omitted accepted), `packages/core/test/suggest.test.ts` (exact distance-2 input matches, exact distance-3 input → null — e.g. registered `['level_complete']`, input `'level_compl'` (distance 3 → null) vs `'level_complet'` (distance 2... verify actual distances when writing; construct pairs by deleting 2 vs 3 trailing chars)), `apps/api/src/routes/events.ts` (replace `nameById.get(u.achievementId)!` with `?? u.achievementId` + one test where the fake returns a newUnlock absent from increments asserting the fallback name).

Tests ARE the deliverable; every existing suite stays green; no production behavior changes except the `nameById` fallback.

Commit: `test: race loop, StrictMode beacon, schema coverage, suggester boundary; nameById fallback (closes #14)`

---

### Task 9: Docker images + compose stack

**Files:** Create `apps/api/Dockerfile`, `apps/cms/Dockerfile`, `apps/demo/Dockerfile`, root `.dockerignore` (node_modules, .git, dist, .next, .turbo, .superpowers, docs), root `.env.example` (full stack contract: all cms vars from apps/cms/.env.example with stack-appropriate values + `CONFIG_PLANE_SECRET`, `RATE_LIMIT_PER_MINUTE`, `TIMED_EVENT_SCAN_GRACE_MINUTES`, `WEBHOOK_REDELIVERY_GRACE_MINUTES`, `WEBHOOK_DEAD_LETTER_TTL_DAYS`, `PROMOCEAN_SECRET_KEY`), create `apps/api/.env.example` (`DATABASE_URL`, `STRAPI_URL`, `CONFIG_PLANE_SECRET`, `API_PORT`, `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_MAX_BUCKETS`, `LOG_LEVEL`, the three webhook envs); modify `apps/demo/next.config.ts` (`output: 'standalone'`), `docker-compose.yml` (see spec §3.2: postgres healthcheck `pg_isready -U promocean`; `cms`/`api`/`demo` services under `profiles: ["stack"]`, `build:` contexts at repo root with per-app dockerfile, healthcheck-gated `depends_on` — cms waits postgres healthy, api waits postgres+cms healthy with healthcheck on `/readyz` via busybox wget, demo waits api healthy; env per spec incl. `STRAPI_URL=http://cms:1337`, `PROMOCEAN_API_URL=http://api:3001`, `DATABASE_URL=postgres://promocean:promocean@postgres:5432/promocean` — note in-network port 5432, not the 5433 host mapping).

**Dockerfile shape (all three, adjust pkg name/entrypoint):** stage 1 `base` (node:22-alpine + `corepack enable`); stage 2 `pruner` (copy repo, `pnpm dlx turbo@<repo's turbo major> prune <pkg> --docker`); stage 3 `installer` (copy `out/json` + lockfile, `pnpm install --frozen-lockfile`, copy `out/full`, `pnpm turbo run build --filter=<pkg>`); stage 4 `runner` (non-root `node` user, `NODE_ENV=production`, copy built output + prod node_modules — for api copy the pruned workspace and run `node apps/api/dist/index.js`; for cms copy the built strapi app and run `pnpm --filter cms start` equivalent (`node_modules/.bin/strapi start` from apps/cms dir); for demo copy `.next/standalone` + `.next/static` + `public`, run `node apps/demo/server.js`). Demo stage 3 takes `ARG NEXT_PUBLIC_PROMOCEAN_KEY=pk_test_demo_1234567890abcdef` / `ARG NEXT_PUBLIC_PROMOCEAN_API=http://localhost:3001` exported as ENV before `next build`. If sharp/musl breaks the cms build, switch that Dockerfile's bases to `node:22-slim` and add a comment; capture the decision in the report.

**Verification (is the test cycle for this task):** `docker compose --profile stack build` succeeds; from a wiped stack (`docker compose --profile stack down -v` — disposable local demo data, established precedent) `docker compose --profile stack up -d --wait` exits 0; `curl localhost:3001/readyz` → 200; `curl localhost:3002` → 200; seeded demo visible; `docker stop <api-container>` completes in <10s with the shutdown log phases visible in `docker logs` (graceful-shutdown live proof). Then `pnpm --filter demo e2e` against the running containers → 3/3. Capture all outputs.

Commit: `feat: production docker images and one-command compose stack`

---

### Task 10: CI against containers + README quickstart — sprint DoD

**Files:** Modify `.github/workflows/ci.yml` (e2e job: drop the hand-rolled `pnpm start` service boots and `docker compose up -d postgres`; instead `docker compose --profile stack build` (with `docker/build-push-action`-style GHA layer cache OR plain build — prefer simple: `docker compose --profile stack build` with `cache-from: type=gha` only if straightforward via `docker buildx bake`; plain uncached build is acceptable if cache wiring fights compose — note the choice), write the CI env into a `.env` file for compose (same values the job env block has today; `NEXT_PUBLIC_*` become build args), `docker compose --profile stack up -d --wait`, keep `playwright install`, run `pnpm --filter demo e2e`, on failure `docker compose logs` dump step (`if: failure()`), teardown `docker compose --profile stack down -v`); root README (quickstart section: clone → `cp .env.example .env` → `docker compose --profile stack up` → URLs; dev-mode section unchanged, clarified as the profile-less flow).

Note: the unit `test` job is untouched. The e2e job no longer needs node/pnpm setup for the servers, but keeps it for playwright itself.

**DoD steps (in order):** CI-equivalent run locally (build → up --wait → e2e 3/3 → down); push branch and confirm the GitHub Actions e2e job goes green on the PR (this is the real gate — watch it); `pnpm turbo run typecheck build test` fully green locally; README quickstart followed verbatim from a clean `git clone` into a temp dir (scratchpad) to prove the one-command story.

Commit: `ci: build images and run e2e against the compose stack; one-command quickstart docs`

---

## Self-Review Notes

- **Spec coverage:** §3.1 images ✓ (T9); §3.2 compose + env contract ✓ (T9); §3.3 CI ✓ (T10); §3.4 webhook hardening ✓ (T1 messageId, T2 storage, T3 redelivery/retention/docs, T4 scan filter + shutdown); §3.5 memory bounds ✓ (T5); §3.6 offer-id ✓ (T6, uses T1's not_found); §3.7 polish + tests ✓ (T7, T8); §4 error handling distributed (healthcheck ordering T9, shutdown drain T4, redelivery idempotence T3, overflow bucket T5); §5 testing mapped 1:1; §6 DoD = T9 verification + T10.
- **Ordering rationale:** hardening (T1-T8) before Docker (T9) so images contain final code; CI (T10) last because it needs the images. T1→T3 known-break chain (required messageId) is two tasks long and recorded.
- **Type consistency check:** `WebhookDeliveryStore` additions named identically in T2 (port+impl) and T3 (consumer+fakes): `markDelivered`, `findStaleClaims(olderThan, maxAttempts)`, `incrementAttempts`, `deleteDeadLettersBefore`. Scheduler opts (`redeliveryGraceMinutes`, `scanGraceMinutes`, `deadLetterTtlDays`) named identically in T3 (plumb+assert) and T4 (scanGrace consumed via adapter constructor opt `allTimedEventsEndedWithinMinutes`). Env names consistent across T3/T4/T9 (`WEBHOOK_REDELIVERY_GRACE_MINUTES`, `TIMED_EVENT_SCAN_GRACE_MINUTES`, `WEBHOOK_DEAD_LETTER_TTL_DAYS`, `RATE_LIMIT_MAX_BUCKETS`).
- **Deliberate choices encoded:** required (not optional) `messageId` — single-producer wire format, updated atomically within the sprint; redelivery issues a FRESH messageId per attempt (each delivery is a new message; consumer dedup is per-message, replay protection is the signed createdAt window); `/docs` loads Redoc from CDN in the browser (API stays dependency-free) — acceptable for a docs page, noted for the reviewer.
- **Compression note:** as with Sprints 2-5, test code is specified behaviorally (patterns long established); production interfaces, env names, and defaults are exact.
