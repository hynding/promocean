# Promocean Sprint 4: Security Completion, Observability, OpenAPI, Publishing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the MVP: the spec's remaining security requirements (per-key rate limits, origin allowlist, GDPR erasure with secret-key enforcement), pino structured logging with request IDs, an OpenAPI document generated from the zod contracts, Changesets publishing setup for the MIT packages, and usage docs — ending with the full e2e suite green.

**Architecture:** All additions follow established seams. Rate limiting and origin checks are middleware in `apps/api` keyed off the existing `AuthContext` (which gains `allowedOrigins`); erasure is a new core port implemented in adapter-db with a transaction; OpenAPI is assembled at boot from `z.toJSONSchema` (zod v4 native — no new deps); logging swaps `console.*` for pino behind a tiny logger module.

**Spec:** `docs/superpowers/specs/2026-07-06-promocean-design.md` §3.4 (rate limits, origin allowlist, key types), §4.4 (erasure, OpenAPI), §5b (observability, Changesets). Hosting/deploy is intentionally NOT in this sprint (requires account decisions — user-level).

## Global Constraints

(All prior global constraints bind.)

Sprint-4 additions:
- New error code `forbidden` added to the contracts catalog (additive). Origin violations keep the existing `origin_not_allowed` code.
- Rate limit: fixed-window per key hash, `RATE_LIMIT_PER_MINUTE` env (default 300), applied to all `/v1/*` after auth; exceeded → 429 `rate_limited` envelope with a `retry-after` seconds header. In-memory (single-instance MVP; multi-instance limiting is a known follow-up — note in code comment).
- Origin allowlist: `Project` gains optional `allowedOrigins` (JSON array of origins). When non-empty AND the key is publishable AND the request carries an `Origin` header not in the list → 403 `origin_not_allowed`. Requests without an Origin header (server-to-server, curl) are allowed even on pk keys (the allowlist defends browsers, not servers — document this). Secret keys always skip the check.
- Erasure: `DELETE /v1/users/:userId` requires a SECRET key (`keyType === 'secret'`; publishable → 403 `forbidden`) — the first keyType-enforced endpoint. Deletes the user's events, progress, unlocks, and offer_events rows for the authenticated project+environment in one transaction; MAU rows retained (billing history, contains only the id — document). Response `{ erased: true, counts: { events, progress, unlocks, offerEvents } }`.
- Logging: `apps/api` gets `src/logger.ts` (pino; level via `LOG_LEVEL` default `info`; pretty-print NOT enabled in code — dev uses `pino-pretty` via CLI pipe, documented). Request middleware assigns `crypto.randomUUID()` request ids, logs method/path/status/duration; all `console.error/log` in `apps/api/src` replaced with logger calls carrying context objects. Webhook dispatcher/scheduler accept an optional logger (default: pino child).
- OpenAPI: document assembled from contracts schemas via `z.toJSONSchema(...)` (zod v4), served at `GET /v1/openapi.json` (auth-free like /healthz), title "Promocean API", version from apps/api package.json. Cover: POST /v1/events, GET /v1/users/:userId/achievements, DELETE /v1/users/:userId, GET /v1/placements/:slug/offer, POST /v1/offers/:id/click, GET /v1/events/live — request/response/error schemas referenced via components.
- Changesets: `@changesets/cli` at the root; config ignores `apps/*`, `@promocean/core`, `@promocean/adapter-*` from publishing (`"access": "public"` for the MIT four: contracts, sdk, widgets, config — actually config need not publish; ignore it too, publish exactly contracts/sdk/widgets); a `release.yml` workflow triggered manually (`workflow_dispatch`) running changesets publish (requires `NPM_TOKEN` secret — documented, not created).
- Docs: `packages/sdk/README.md` and `packages/widgets/README.md` with install + quickstart snippets; root README gains an API surface table.

---

### Task 1: contracts — `forbidden` code + erasure response schema

**Files:** Modify `packages/contracts/src/errors.ts`; create `packages/contracts/src/users.ts`; modify `src/index.ts`; test append `packages/contracts/test/contracts.test.ts`.

**Interfaces — produces:**
- `errorCodeSchema` gains `'forbidden'` (additive).
- `eraseUserResponseSchema` / `EraseUserResponse = { erased: true; counts: { events: number; progress: number; unlocks: number; offerEvents: number } }` (erased is `z.literal(true)`).

Steps: RED test (forbidden accepted by envelope; erasure schema round-trip; erased:false rejected) → implement → GREEN (build clean) → commit `feat(contracts): forbidden error code and erasure response schema`.

---

### Task 2: core + adapter-db — erasure port and store

**Files:** Modify `packages/core/src/ports.ts`, `packages/core/src/types.ts` (AuthContext gains `allowedOrigins: string[] | null`); modify `packages/adapter-db/src/stores.ts`, `src/index.ts`; test `packages/adapter-db/test/erasure.test.ts`.

**Interfaces — produces:**
```ts
// core ports.ts
export interface ErasureStore {
  eraseUser(scope: Scope, userId: string): Promise<{ events: number; progress: number; unlocks: number; offerEvents: number }>
}
// core types.ts — AuthContext becomes:
export interface AuthContext { projectId: string; environment: Environment; keyType: 'publishable' | 'secret'; allowedOrigins: string[] | null }
// adapter-db
export class PgErasureStore implements ErasureStore // db.transaction: four DELETEs scoped by project+environment+userId, each returning count; MAU rows untouched
```
Known break: adding `allowedOrigins` to `AuthContext` breaks adapter-strapi (verifyKey return) and api fakes — Tasks 3–4 fix; record, don't patch (established pattern). Adapter-db per-package gates green; Testcontainers test seeds rows across two users/tenants, erases one, asserts counts + surviving rows + MAU retention.

Commit: `feat(core,adapter-db): user erasure port and transactional store`
(Two packages in one task is deliberate — the port and its only implementation ship together; commit both paths in one commit.)

---

### Task 3: cms — allowedOrigins on Project, verify-key returns it

**Files:** Modify `apps/cms/src/api/project/content-types/project/schema.json` (add `"allowedOrigins": { "type": "json" }`); modify config-plane `verifyKey` handler to return `allowedOrigins: key.project.allowedOrigins ?? null` (validate: if present and not an array of strings, return null and `strapi.log.warn`); regenerate types.

Verification: live curl verify-key → response now carries `allowedOrigins: null`; set a value via admin (or documents service in strapi console) optional — code-level correctness + typecheck suffice if admin check is awkward; capture what you did.

Commit: `feat(cms): project origin allowlist surfaced through verify-key`

---

### Task 4: adapter-strapi + api — AuthContext propagation, rate limit + origin middleware, erasure route

**Files:** Modify `packages/adapter-strapi/src/index.ts` (verifyKey maps `allowedOrigins` with array-of-strings runtime check → null otherwise; test updated); modify `apps/api/src/auth.ts` (origin check after key verification), create `apps/api/src/rate-limit.ts`, create `apps/api/src/routes/users.ts` DELETE handler (file exists — extend), modify `app.ts` (mount rate limit after auth; AppDeps gains `erasureStore: ErasureStore`), `index.ts` (wire PgErasureStore), `test/fakes.ts` (auth fixtures gain allowedOrigins: null; erasure fake); tests `apps/api/test/security.test.ts`.

**Behavior:**
- Rate limiter: `createRateLimiter(limitPerMinute)` returning Hono middleware; fixed window keyed by the raw bearer token's sha256 (compute once — reuse the auth middleware's work if practical, else hash in middleware); on exceed → 429 `{ error: { code: 'rate_limited', ... } }` + `retry-after` header (seconds to window reset). Env `RATE_LIMIT_PER_MINUTE` default 300; limit=0 disables (for tests/e2e — set in CI? NO: leave default; tests construct middleware directly with small limits).
- Origin check in auth middleware after verifyKey: `if (auth.keyType === 'publishable' && auth.allowedOrigins?.length && originHeader && !auth.allowedOrigins.includes(originHeader)) → 403 origin_not_allowed`.
- DELETE `/v1/users/:userId`: secret key required (`keyType !== 'secret'` → 403 `forbidden`); userId bounded 1..128 → else 400; calls `erasureStore.eraseUser`; returns `EraseUserResponse` via `satisfies`.

**Tests (security.test.ts + updated fakes):** rate limit allows under limit / 429 over limit with retry-after; origin: pk key + disallowed Origin → 403, allowed Origin → 200, no Origin header → 200, sk key + disallowed Origin → 200, empty/null allowlist → 200; erasure: pk key → 403 forbidden, sk key → 200 with counts from fake, oversized userId → 400. Workspace typecheck fully green after this task.

Commit: `feat(api): rate limiting, origin allowlist enforcement, and secret-key user erasure`

---

### Task 5: api — pino logging + request ids

**Files:** Create `apps/api/src/logger.ts`; modify `app.ts` (request-logging middleware: id via randomUUID, log on completion with method/path/status/ms; store id on context; include `x-request-id` response header), all `apps/api/src` files replacing `console.*` (events.ts multiplier catch, placements.ts impression catch, webhooks.ts delivery/dead-letter/scheduler logs, index.ts boot log, app.ts onError); dependencies: `pino` (+ `@types` not needed; pino ships types).

Logger module: `export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })`; routes/dispatcher take child loggers or import directly (keep simple: direct import; webhooks dispatcher gains optional `logger` opt defaulting to a child). onError logs `{ err, requestId }`. Tests: existing suites must stay green AND pristine — pino writes to stdout; set level `silent` when `NODE_ENV === 'test'` (or `LOG_LEVEL` env in vitest config) so test output stays clean; one new test asserts the `x-request-id` header is present on responses.

Commit: `feat(api): pino structured logging with request ids`

---

### Task 6: api — OpenAPI document

**Files:** Create `apps/api/src/openapi.ts`; modify `app.ts` (serve `GET /v1/openapi.json`, auth-free — register BEFORE the auth middleware or outside `/v1/*` guard... it IS under /v1; register the route before `app.use('/v1/*', auth)` so it wins — verify Hono ordering honors registration order for middleware vs route; if not, mount at `/openapi.json` instead and note it); test `apps/api/test/openapi.test.ts`.

`openapi.ts`: `export function buildOpenApiDocument(version: string)` — assembles `{ openapi: '3.1.0', info: { title: 'Promocean API', version }, paths: {...}, components: { schemas, securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer' } } } }` using `z.toJSONSchema(schema, { target: 'openapi-3.0' } as never)` — CHECK the installed zod's `z.toJSONSchema` options signature first (it exists in zod 4; use plain `z.toJSONSchema(schema)` if the target option is unavailable) — for: trackEventRequest/Response, userAchievementsResponse, eraseUserResponse, placementOfferResponse, offerClickRequest/Response, liveEventsResponse, errorEnvelope. All six endpoint paths documented with 200 + error responses referencing the envelope. Document is built once at module load and served as static JSON.

Tests: document parses, `paths` has all six routes, `components.schemas.errorEnvelope` exists, endpoint reachable without auth (200 via app.request with no Authorization header).

Commit: `feat(api): openapi document generated from contracts`

---

### Task 7: Changesets + release workflow

**Files:** Root `package.json` (devDep `@changesets/cli`, script `"changeset": "changeset"`), `.changeset/config.json` (ignore `api`, `cms`, `demo`, `@promocean/core`, `@promocean/adapter-db`, `@promocean/adapter-strapi`, `@promocean/config`; `"access": "public"`; baseBranch main), `.github/workflows/release.yml` (`workflow_dispatch`; pnpm setup mirroring ci.yml; `pnpm turbo run build --filter='./packages/*'`; `npx changeset publish` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`), README note ("publishing requires the NPM_TOKEN repo secret; run the Release workflow manually").

Verification: `npx changeset status` runs without error (no changesets yet is fine — capture output); `pnpm install` lockfile committed. NO publish attempted.

Commit: `chore: changesets publishing setup for MIT packages`

---

### Task 8: docs + full-suite DoD

**Files:** Create `packages/sdk/README.md` (install `npm i @promocean/sdk`; init/identify/track/getAchievements/getPlacementOffer/clickOffer/dismiss/getLiveEvents snippets; error handling via PromoceanApiError; note creative URLs sanitized at widget layer only), `packages/widgets/README.md` (install; PromoceanProvider + all four components usage; SSR note; bundle philosophy), root README API surface table (method + path + auth + purpose for all seven endpoints incl. openapi.json). Replace the boilerplate `apps/demo/README.md` and `apps/cms/README.md` with three-line pointers to the root README.

**DoD steps:** boot the stack; run `pnpm --filter demo e2e` (3 passed — rate limiting default 300/min must not interfere; if it does, that's a bug to fix, not a test to weaken); `curl http://localhost:3001/v1/openapi.json | head` (valid JSON); `pnpm turbo run typecheck build test` fully green; stop servers; commit `docs: sdk/widgets usage docs, api surface table, sprint 4 wrap`.

---

## Self-Review Notes

- **Spec coverage:** per-key rate limits ✓ (T4, §3.4); origin allowlist ✓ (T3/T4, §3.4); keyType enforcement debut ✓ (T4 erasure, closes an acknowledged Sprint-1 security tradeoff for this endpoint class); `DELETE /v1/users/:id` erasure ✓ (T2/T4, §4.4); pino + request ids ✓ (T5, §5b); OpenAPI from contracts ✓ (T6, §4.4/§3.2's zod-single-source promise); Changesets ✓ (T7, §5b); docs ✓ (T8). Deliberately out: hosting/deploy (account decisions), Sentry (needs DSN decision — note as open question for the user), metrics dashboards (v1.x stats endpoint is backlog).
- **Known break pattern:** T2 widens AuthContext → adapter-strapi/api red until T4 (recorded per established process).
- **Erasure/MAU decision encoded:** MAU rows survive erasure (billing integrity; they contain only the external id). If full erasure is legally required later, that's a documented one-line change.
- **In-memory rate limiting** is explicitly single-instance MVP; the code comment + issue backlog carry the multi-instance caveat.
- **Compression note:** test code for Tasks 3–8 is specified behaviorally (patterns fully established across three sprints); production interfaces are exact.
