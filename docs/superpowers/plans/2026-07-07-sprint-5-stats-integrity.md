# Promocean Sprint 5: Stats Endpoint & Data Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /v1/stats` (the v1.x proof-of-value endpoint) on top of a write path made trustworthy first: transactional event ingestion (#2), race-free SQL-side progress increments (#3), an idempotent client-fired impression beacon (#6), zod-validated config-plane responses (#4), and registered event types with typo rejection.

**Architecture:** Write path before read path. `evaluateEvent` shifts from deciding outcomes to returning deltas; a new `IngestionStore` applies them atomically in one `db.transaction` (pattern: `PgErasureStore`) and the post-increment value SQL returns decides unlocks. Impressions move from the placements GET to `POST /v1/offers/:id/impression` fired by the widget after the render decision, deduped by a partial unique index. Stats is aggregate SQL behind a new `StatsStore` port, sk-only. All work follows existing seams: pure logic in `core`, persistence in `adapter-db`, config plane in `adapter-strapi`, wiring in `apps/api`.

**Spec:** `docs/superpowers/specs/2026-07-07-sprint-5-stats-integrity-design.md`. Branch `sprint-5-stats-integrity` (PR #12 / `sprint-4-polish` merges beneath it — rebase onto main once Steve merges).

## Global Constraints

(All prior global constraints bind: error envelope `{ error: { code, message, details? } }`, zod contracts as single source of truth, TDD per task, per-package gates green before commit, known-break pattern recorded when a shared type widens.)

Sprint-5 additions:
- `GET /v1/stats` is **secret-key-only**: `keyType !== 'secret'` → 403 `forbidden` (inline gate, same as `DELETE /v1/users/:userId`). Optional `from`/`to` ISO-8601 query params; unparseable date or `from > to` → 400 `invalid_payload`. Omitted bounds = all-time.
- New error code `unregistered_event_type` (additive to the contracts catalog). Typo rejection uses the standard envelope: `{ error: { code: 'unregistered_event_type', message: 'Unknown event type "<type>".', details: { suggestion: string | null } } }` — suggestion is the nearest registered type at Levenshtein distance ≤ 2, else null. Enforcement is active iff the project's `registeredEventTypes` list is non-empty.
- Impression dedup key: `offer_events.idempotency_key` (nullable text), partial unique index on `(project_id, environment, idempotency_key) WHERE kind = 'impression' AND idempotency_key IS NOT NULL`. Clicks unchanged. Duplicate `impressionId` → no-op success (`{ recorded: true }` either way).
- The placements GET **stops recording impressions** — recording moves entirely to the beacon.
- Ingestion semantics after this sprint: if anything inside the ingestion transaction throws, the event row rolls back too (dedup records completion, not receipt). Config fetch and webhook dispatch stay outside the transaction.
- Progress increments happen in SQL (`LEAST(current + delta, target)`), never read-modify-write in JS. `delta = Math.round(1 * multiplier)` — non-integer multipliers were never truly supported (integer column); note this in code where delta is computed.
- `resolveOffer` equal-priority tie-break: lexicographic smallest offer `id` wins (deterministic across config-cache refreshes). Document in the function's JSDoc.
- SDK `secretKey` is server-side-only; README must say never ship it to a browser. Demo reads it from `PROMOCEAN_SECRET_KEY` (NOT `NEXT_PUBLIC_*`).

---

### Task 1: contracts — stats schemas, impression schemas, `unregistered_event_type` code

**Files:** Create `packages/contracts/src/stats.ts`; modify `packages/contracts/src/offers.ts`, `src/errors.ts`, `src/index.ts`; test append `packages/contracts/test/contracts.test.ts`.

**Interfaces — produces:**
```ts
// errors.ts: errorCodeSchema gains 'unregistered_event_type' (additive)

// offers.ts
export const offerImpressionRequestSchema = z.object({
  impressionId: z.uuid(),
  userId: z.string().min(1).max(128).optional(),
})
export type OfferImpressionRequest = z.infer<typeof offerImpressionRequestSchema>
export const offerImpressionResponseSchema = z.object({ recorded: z.boolean() })
export type OfferImpressionResponse = z.infer<typeof offerImpressionResponseSchema>

// stats.ts
export const statsQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})
export const statsResponseSchema = z.object({
  range: z.object({ from: z.iso.datetime().nullable(), to: z.iso.datetime().nullable() }),
  totals: z.object({
    events: z.number().int(), unlocks: z.number().int(),
    impressions: z.number().int(), clicks: z.number().int(),
    timedEventParticipants: z.number().int(),
  }),
  achievements: z.array(z.object({ achievementId: z.string(), unlocks: z.number().int() })),
  offers: z.array(z.object({
    offerId: z.string(), impressions: z.number().int(), clicks: z.number().int(),
    ctr: z.number().nullable(), // clicks/impressions, null when impressions === 0
  })),
  timedEvents: z.array(z.object({ eventId: z.string(), name: z.string(), participants: z.number().int() })),
})
export type StatsResponse = z.infer<typeof statsResponseSchema>
```

Tests (RED first): impression request round-trip; non-uuid impressionId rejected; stats response round-trip; ctr null accepted; `unregistered_event_type` accepted by the envelope. Commit: `feat(contracts): stats, offer impression, and unregistered-event-type schemas`

---

### Task 2: core — delta-based evaluate, event-type suggester, new ports, tie-break

**Files:** Modify `packages/core/src/evaluate.ts`, `src/types.ts`, `src/ports.ts`, `src/offers.ts`, `src/index.ts`; create `packages/core/src/suggest.ts`; tests in `packages/core/test/`.

**Interfaces — produces:**
```ts
// types.ts — EvaluationResult REPLACED by:
export interface EvaluationPlan {
  increments: { achievementId: string; name: string; delta: number; target: number }[]
}
// evaluate.ts — signature change (no more currentCounts; no unlock decision):
export function evaluateEvent(event: TrackedEvent, definitions: AchievementDefinition[], multiplier = 1): EvaluationPlan
// For each def with matching eventType: delta = Math.round(1 * multiplier), target = def.targetCount.
// No skip logic — SQL clamping makes at-target increments no-ops; unlocks decided by the store.

// suggest.ts
export function suggestEventType(input: string, registered: string[]): string | null
// Levenshtein distance ≤ 2; lowest distance wins; ties broken by registered-list order; null if no match or empty list.
// Implement levenshtein inline (small DP matrix) — no new dependency.

// ports.ts additions:
export interface IngestionStore {
  ingestEvent(
    scope: Scope,
    event: { userId: string; type: string; idempotencyKey: string; occurredAt: Date; meta?: Record<string, unknown> },
    increments: { achievementId: string; delta: number; target: number }[],
    month: string, // usage-counter month key 'YYYY-MM'
  ): Promise<
    | { deduped: true }
    | { deduped: false; progress: { achievementId: string; current: number; target: number }[]; newUnlocks: { achievementId: string; unlockedAt: Date }[] }
  >
}
export interface StatsStore {
  getStats(
    scope: Scope,
    range: { from: Date | null; to: Date | null },
    timedEventWindows: { eventId: string; startsAt: Date; endsAt: Date }[],
  ): Promise<{
    totals: { events: number; unlocks: number; impressions: number; clicks: number; timedEventParticipants: number }
    achievements: { achievementId: string; unlocks: number }[]
    offers: { offerId: string; impressions: number; clicks: number }[]
    timedEvents: { eventId: string; participants: number }[]
  }>
}
// ConfigStore gains: getRegisteredEventTypes(projectId: string): Promise<string[]>
// OfferMetricsStore.recordImpression gains a 5th param: idempotencyKey: string
```
`offers.ts` `resolveOffer`: tie-break — replace `offer.priority > best.priority` with `offer.priority > best.priority || (offer.priority === best.priority && offer.id < best.id)`; JSDoc the determinism guarantee.

**Known break (record, don't patch):** `evaluateEvent` signature + `ConfigStore`/`OfferMetricsStore` widening break `apps/api`, `adapter-db`, `adapter-strapi`, and api fakes until Tasks 3/5/6/7. Core's own gates green.

Tests: evaluate returns increments only for matching types, delta honors multiplier (1, 2, rounds 1.5→2), includes at-target achievements (no skip); suggester exact/distance-1/distance-2/no-match/empty-list/tie-order cases; resolveOffer equal-priority returns smallest id regardless of input order. Commit: `feat(core): delta-based evaluation plan, event-type suggester, ingestion and stats ports`

---

### Task 3: adapter-db — PgIngestionStore, PgStatsStore, migration 0003

**Files:** Modify `packages/adapter-db/src/stores.ts`, `src/schema.ts`, `src/index.ts`; create migration `packages/adapter-db/migrations/0003_*` (via `drizzle-kit generate` after schema change); tests `packages/adapter-db/test/ingestion.test.ts`, `test/stats.test.ts`; modify `test/offer-metrics.test.ts`.

**Schema changes:** `offerEvents` gains `idempotencyKey: text('idempotency_key')`; partial unique index per Global Constraints; new index `offer_events_stats_ix` on `(project_id, environment, offer_id, kind)`; new index `events_stats_ix` on `(project_id, environment, occurred_at)`; new index `unlocks_stats_ix` on `(project_id, environment, achievement_id)`.

**Interfaces — produces:**
```ts
export class PgIngestionStore implements IngestionStore // constructor(private db: Db)
// db.transaction(async (tx) => {
//   1. insert event onConflictDoNothing returning id → empty ⇒ return { deduped: true }
//   2. per increment: insert achievementProgress values current = LEAST(delta, target)
//      onConflictDoUpdate set current = LEAST(achievement_progress.current + delta, target), updatedAt = now()
//      .returning({ current }) — use sql`LEAST(...)` fragments; collect { achievementId, current, target }
//   3. where current >= target: insert unlocks onConflictDoNothing returning → newly-inserted rows become newUnlocks (unlockedAt = shared new Date() computed once before the loop)
//   4. usage: MAU onConflictDoNothing + usage_counters upsert increment (same SQL as PgUsageStore.recordUsage, executed on tx)
// })
export class PgStatsStore implements StatsStore // constructor(private db: Db)
// Aggregates, each scoped by (project_id, environment) + optional range:
//   totals.events: count(events) with occurred_at in range
//   totals.unlocks + per-achievement: count/group-by unlocks.achievement_id, unlocked_at in range
//   per-offer + totals impressions/clicks: group by offer_id, kind on offer_events, created_at in range
//   per-timed-event participants: per window, count(DISTINCT user_id) from events where occurred_at between
//     GREATEST(startsAt, from) and LEAST(endsAt, to) (range intersected with window)
//   totals.timedEventParticipants: count(DISTINCT user_id) from events where occurred_at falls in ANY window (union of window predicates; 0 when no windows)
// PgOfferMetricsStore.recordImpression(scope, offerId, userId, at, idempotencyKey): insert with onConflictDoNothing() (partial index absorbs duplicates)
```
`index.ts` exports the two new stores. Keep `PgEventStore`/`PgProgressStore.setProgress` in place (still exported; events route stops using them in Task 6 — removal is NOT this sprint's concern).

Tests (Testcontainers, existing pattern): **race** — `Promise.all` of two `ingestEvent` calls, distinct idempotency keys, same user/achievement (target 5) ⇒ raw-SQL current = 2, no lost update; **unlock exactly-once** — third call crossing target ⇒ one unlocks row, `newUnlocks` non-empty only on the crossing call; **rollback** — failure injection via `delta: Number.NaN` (Postgres rejects the parameter, transaction aborts) ⇒ event row absent, then retry with valid increments succeeds with `deduped: false`; **dedup** — same idempotencyKey twice ⇒ second returns `{ deduped: true }`, counters unchanged; **beacon idempotency** — recordImpression same idempotencyKey twice ⇒ one row; **stats** — seed events/unlocks/offer_events across two tenants and dates, assert totals, per-entity rows, CTR inputs, date-range boundaries (inclusive from, inclusive to), window participation (user inside vs outside window), cross-tenant isolation. Commit: `feat(adapter-db): transactional ingestion store, stats aggregation store, impression dedup migration`

---

### Task 4: cms — registeredEventTypes on Project + config-plane endpoint

**Files:** Modify `apps/cms/src/api/project/content-types/project/schema.json` (add `"registeredEventTypes": { "type": "json" }`); modify config-plane controller `apps/cms/src/api/config-plane/controllers/config-plane.ts` + routes `.../routes/config-plane.ts` (new handler `GET /config-plane/projects/:projectId/event-types`, same `x-config-secret` timingSafeEqual guard as siblings); regenerate `contentTypes.d.ts`.

**Behavior:** Response `{ eventTypes: string[] }` — from the project's `registeredEventTypes`; coerce defensively: not an array → `[]` + `strapi.log.warn`; filter to strings matching `EVENT_TYPE_PATTERN` (`/^[a-z][a-z0-9_]*$/` — mirror the literal, cms doesn't import contracts); missing project → 404. Update the seed script so the demo project registers its demo event types (check what types the demo tracks — seed exactly those, e.g. the types used by `apps/demo` and the e2e specs) — a seeded list makes typo rejection live in the demo without admin clicking.

Verification: live curl the new endpoint (guard rejects without secret; returns seeded list with it); typecheck green. Commit: `feat(cms): registered event types on project via config-plane`

---

### Task 5: adapter-strapi — zod response validation (#4) + getRegisteredEventTypes + verifyKey cache tests

**Files:** Modify `packages/adapter-strapi/src/index.ts`; test `packages/adapter-strapi/test/adapter.test.ts`.

**Behavior:**
- Internal zod schemas (module-local, not exported — contracts stays wire-API-only) for all config-plane response bodies: achievements, offers, timed events (both endpoints), webhook endpoints, verify-key, event-types. Replace every `as` cast / blind `String()`/`Number()` coercion with `schema.safeParse(await res.json())`; parse failure → treated exactly like a failed fetch (throw) so the existing TTL stale-on-error path applies. Priority: `verifyKey` — `environment` must be `z.enum(['test','live'])`, `keyType` `z.enum(['publishable','secret'])`; a bad enum from the CMS must yield `null` auth, never a corrupt `AuthContext`.
- New `getRegisteredEventTypes(projectId)` implementing the widened `ConfigStore`: same per-project TTL cache + stale-on-error machinery as `getAchievements`.
- Drop the unnecessary `content-type` header on GET requests.

Tests (stub fetchImpl, existing pattern): malformed body per method → throws (and stale cache serves when warm); bad `keyType` enum → verifyKey returns null; event-types happy path + cache hit (one fetch for two calls inside TTL); **the three missing verifyKey cache paths**: TTL-cache hit, stale-on-error after expiry, non-404 error does not cache. Workspace typecheck still red for `apps/api` (fakes) until Task 6 — record. Commit: `feat(adapter-strapi): zod-validated config-plane responses and registered event types (closes #4 scope)`

---

### Task 6: api — transactional events route + typo rejection

**Files:** Modify `apps/api/src/routes/events.ts`, `src/app.ts` (AppDeps: `+ ingestionStore: IngestionStore`, `+ statsStore: StatsStore` may land in Task 8 — add only ingestionStore here; `- eventStore`, `- usageStore`, `- progressStore` stays for the achievements GET route), `src/index.ts` (wire `PgIngestionStore`), `test/fakes.ts` (fake ingestion store; configStore fake gains `getRegisteredEventTypes` returning a settable list); tests `apps/api/test/app.test.ts` (adjust) + typo cases.

**Route sequence (events.ts):**
1. Parse body (unchanged).
2. `const registered = await deps.configStore.getRegisteredEventTypes(scope.projectId).catch(() => [])` — config-plane failure must not block ingestion (fail open, matching the multiplier catch pattern; log warn).
3. If `registered.length > 0 && !registered.includes(type)` → 400 `unregistered_event_type` envelope with `details.suggestion = suggestEventType(type, registered)`.
4. `getAchievements`, `activeMultiplier` (unchanged try/catch), `evaluateEvent(event, definitions, multiplier)` → plan.
5. `const outcome = await deps.ingestionStore.ingestEvent(scope, {...}, plan.increments.map(({achievementId, delta, target}) => ({achievementId, delta, target})), month)` — deduped → early return (unchanged shape).
6. Response: `progress` = outcome.progress; `unlocks` = outcome.newUnlocks mapped to `{ achievementId, name, unlockedAt: iso }` (name looked up from `plan.increments`); webhook dispatch on newUnlocks (unchanged pattern, still fire-and-forget outside the tx).

Tests: happy path unchanged shapes; deduped early-return; typo → 400 with suggestion / null suggestion; empty registered list → no enforcement; config-plane event-types failure → event still ingests; unlock fires webhook only when newUnlocks non-empty. Workspace typecheck fully green again after this task. Commit: `feat(api): transactional ingestion with registered-event-type rejection (closes #2, #3 scope)`

---

### Task 7: api — impression beacon + placements GET stops recording

**Files:** Modify `apps/api/src/routes/offers.ts` (add `POST /:id/impression`), `src/routes/placements.ts` (delete the recordImpression block), `src/openapi.ts` (new path + schemas), `test/fakes.ts` (metrics fake gains idempotency behavior); tests `apps/api/test/offers.test.ts`, `test/openapi.test.ts` counts.

**Behavior:** `POST /v1/offers/:id/impression` — validate body with `offerImpressionRequestSchema` (400 on bad); offer id bounded like click; `offerMetricsStore.recordImpression(scope, id, userId ?? null, new Date(), impressionId)`; respond `{ recorded: true } satisfies OfferImpressionResponse`. Duplicate impressionId is indistinguishable to the caller (idempotent success). pk keys allowed (browser-fired, like click).

Tests: 200 + recorded; duplicate impressionId → still 200, fake records once; invalid impressionId (non-uuid) → 400; placements GET no longer calls recordImpression (assert fake untouched after GET). OpenAPI test asserts the new path. Commit: `feat(api): idempotent offer impression beacon; placements read no longer records (closes #6 scope)`

---

### Task 8: api — stats route

**Files:** Create `apps/api/src/routes/stats.ts`; modify `src/app.ts` (mount `/v1/stats`, AppDeps `+ statsStore: StatsStore`), `src/index.ts` (wire `PgStatsStore`), `src/openapi.ts` (path with sk security note + response schema), `test/fakes.ts` (fake stats store); test `apps/api/test/stats.test.ts`.

**Route:** sk gate first (`keyType !== 'secret'` → 403 `forbidden`); parse `from`/`to` via `statsQuerySchema` (+ explicit `from > to` → 400); fetch timed events via `deps.configStore.getTimedEvents(scope.projectId)` in try/catch (failure → empty windows + warn, stats still serve); map to windows `{eventId: e.id, startsAt, endsAt}`; call `statsStore.getStats(scope, range, windows)`; assemble `StatsResponse` — `ctr = impressions === 0 ? null : clicks / impressions`; `timedEvents[].name` joined from config definitions; `range` echoes the parsed bounds as ISO or null. Respond with `satisfies StatsResponse`.

Tests: pk → 403; sk → 200 with fake data, ctr math incl. null; bad date → 400; `from > to` → 400; range forwarded to store (fake captures args); config failure → 200 with empty timedEvents. Commit: `feat(api): secret-key stats endpoint`

---

### Task 9: sdk + widgets — secretKey/getStats, impression beacon wiring

**Files:** Modify `packages/sdk/src/index.ts`, `packages/widgets/src/placement.tsx`; tests `packages/sdk/test/sdk.test.ts`, `packages/widgets/test/` (placement tests).

**Interfaces — produces:**
```ts
// PromoceanOptions gains: secretKey?: string  // server-side only — never ship to a browser
// request() gains an internal option { useSecretKey?: boolean }: bearer = secretKey when set
export async function getStats(query?: { from?: string; to?: string }): Promise<StatsResponse> // method on Promocean
// throws Error('getStats requires the secretKey option (server-side only).') when secretKey absent;
// builds ?from=&to= querystring; parses with statsResponseSchema.
async recordImpression(offerId: string): Promise<void>
// fire-and-forget like clickOffer; body { impressionId: crypto.randomUUID(), ...(userId ? { userId } : {}) };
// NOTE: generate impressionId ONCE outside the retry loop so retries reuse the same key (that is the point).
```
Verify `request()` retry behavior: the body is built by the caller, so a single `recordImpression` call's retries naturally resend the same impressionId — assert this in a test (5xx then 200 ⇒ both attempts carried the same impressionId, one logical impression).

**Widget:** `Placement` — after the fetch resolves with an offer that passes `client.isOfferDismissed(offer.offerId)`, fire `void client.recordImpression(offer.offerId)` exactly once (inside the existing effect's `.then`, guarded by `cancelled`; dismissed offers must produce NO beacon call).

Tests: sdk — getStats without secretKey throws; with secretKey sends sk bearer + parses response; from/to encoded; recordImpression fires POST with uuid body, swallows errors, stable impressionId across retries. widgets — render with offer fires beacon once; dismissed (localStorage set) → no beacon; unmount before resolve → no beacon. Commit: `feat(sdk,widgets): server-side stats access and render-attested impression beacon`

---

### Task 10: demo stats page, e2e, docs — sprint DoD

**Files:** Create `apps/demo/app/stats/page.tsx` (server component: `export const dynamic = 'force-dynamic'`; construct `new Promocean({ publishableKey: '', secretKey: process.env.PROMOCEAN_SECRET_KEY!, baseUrl: process.env.PROMOCEAN_API_URL ?? process.env.NEXT_PUBLIC_PROMOCEAN_API! })` — if the constructor requires a non-empty publishableKey, relax that requirement in the SDK when secretKey is present (adjust Task 9's validation accordingly); render totals + three tables, plain HTML); modify `apps/demo/.env.example` (`PROMOCEAN_SECRET_KEY` documented as server-only; seed script must print/provide an sk key — check how pk is provisioned and mirror it); e2e: extend `apps/demo/e2e/offer-loop.spec.ts` (after dismiss + reload: assert NO `POST **/impression` request fires — use `page.on('request')` collection), extend or add stats assertions to `apps/demo/e2e/achievement-loop.spec.ts` (visit `/stats` after the loop; assert events total ≥ 1 and the unlocked achievement's row shows ≥ 1); docs: `packages/sdk/README.md` (+getStats/secretKey section with the never-in-browser warning, +recordImpression note), `packages/widgets/README.md` (impression semantics note), root README API surface table (+2 rows: POST /v1/offers/:id/impression pk, GET /v1/stats sk) plus a short "Registered event types" subsection (opt-in via the project's `registeredEventTypes` list; 400 `unregistered_event_type` with `details.suggestion`).

**DoD steps:** boot the stack; `pnpm --filter demo e2e` — ALL specs green including new assertions; `curl -H "authorization: Bearer <sk>" 'http://localhost:3001/v1/stats'` returns real aggregates; `pnpm turbo run typecheck build test` fully green; stop servers. Commit: `feat(demo): server-rendered stats page; docs and e2e — sprint 5 wrap`

PR notes must state: closes #2, #3, #6; closes the #4 scope (adapter validation + cache tests); registered event types + stats are the first two v1.x roadmap items delivered.

---

## Self-Review Notes

- **Spec coverage:** §3.1 transactional ingestion ✓ (T2 ports, T3 store, T6 route); §3.2 beacon + tie-break + migration ✓ (T1 schemas, T2 tie-break, T3 migration/dedup, T7 route, T9 client); §3.3 registered types ✓ (T4 cms, T5 adapter, T6 enforcement, T2 suggester); §3.4 config validation + cache tests ✓ (T5); §3.5 stats ✓ (T1 contracts, T2/T3 store, T8 route + openapi); §3.6 SDK/demo ✓ (T9, T10); §5 error handling distributed into T6/T7/T8 behaviors; §6 testing mapped 1:1 onto task test lists; §7 DoD = T10.
- **Known-break chain:** T2 widens core (evaluate signature, ConfigStore, OfferMetricsStore) → adapter-db green at T3, adapter-strapi at T5, api at T6. Longer red window than prior sprints (three tasks) — acceptable because each task's own package gates green and the chain is recorded here.
- **Type consistency check:** `EvaluationPlan.increments` carries `name` (T2) so T6 can build unlock responses without a second definitions lookup; `IngestionStore.ingestEvent` takes increments WITHOUT `name` (T2/T3/T6 agree); `recordImpression` 5-arg form consistent across T2 port, T3 impl, T7 route; `StatsStore.getStats` window arg shape identical in T2/T3/T8.
- **Deliberate non-goals restated:** no time-bucketed stats, no PgEventStore/setProgress deletion (dead-code cleanup is post-sprint), no multi-instance rate limiting, no hosting. Issues #8/#10/#11 remain backlog.
- **Compression note:** as with Sprints 2–4, test code is specified behaviorally (patterns established); production interfaces are exact.
