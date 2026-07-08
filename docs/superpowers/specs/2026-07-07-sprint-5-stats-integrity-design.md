# Sprint 5 Design: Stats & Data Integrity

**Date:** 2026-07-07
**Theme:** Trustworthy numbers — the v1.x stats endpoint plus the data-integrity
fixes that make its numbers credible.
**Parent spec:** `2026-07-06-promocean-design.md` §7 (v1.x roadmap)
**Branch:** `sprint-5-stats-integrity` (branched from `sprint-4-polish`; PR #12
merges beneath it)

## 1. Scope

In scope (decided with Steve, 2026-07-07):

1. **Issue #2** — transactional event ingestion (dedup must record completion,
   not receipt)
2. **Issue #3** — lost-update race on achievement progress counters
3. **Issue #6** — offer impression accuracy (dismissed offers, retry duplicates,
   priority tie-break)
4. **Issue #4** — zod validation of config-plane responses + verifyKey
   cache-path tests
5. **Registered event types** with typo rejection (v1.x roadmap item)
6. **`GET /v1/stats`** — totals + per-entity breakdowns, optional date range,
   secret-key-only (v1.x roadmap item)
7. **SDK `getStats()`** via a new optional `secretKey` constructor option
8. **Demo stats page** (server component) — satisfies the demo-usage DoD

Out of scope: hosting/deploy and Sentry (pending platform decisions); issues
#8 (webhook hardening), #10 (rate-limiter memory), #11 (fast-follow polish);
remaining v1.x items (leaderboards/streaks/wallet, coupons, retroactive grants,
recurring events, config-as-code, React Native).

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Sprint theme | Stats + integrity over engagement mechanics | Stats is the marketer's proof-of-value; it is only credible if the counters beneath it aren't lossy. Fix writes before building reads. |
| Stats shape | Totals + per-entity breakdowns, optional `from`/`to`; no time-bucketing | Enough to quote numbers per campaign; bucketed series is v2 dashboard territory. |
| Stats auth | Secret-key-only | Aggregate business metrics don't belong behind browser-exposed publishable keys. Reuses the sk-only gate pattern from `DELETE /v1/users/:userId`. |
| Typo policy | Reject unregistered types with 400 + did-you-mean suggestion | Strict mode is the point of opting in; silent typos permanently corrupt stats. Projects wanting leniency don't enable the list. |
| Ingestion fix | Combined transactional store method | Mirrors the existing `PgErasureStore` pattern; keeps ports narrow; fixes #2 and #3 in one seam. Rejected: threading tx handles through ports (leaks persistence into core); dedup-marker-last (leaves the #3 race, creates partial replays). |
| Impression fix | Client-fired beacon with idempotency key | Solves dismissed-offer inflation and retry duplicates in one design; mirrors `clickOffer`. Rejected: dismissed-IDs param (half-fix); query-time dedup (leaves raw data wrong). |
| Registered types home | `registeredEventTypes` json on `project` + config-plane endpoint | Explicit per-project opt-in per spec. Rejected: deriving from achievement eventTypes (can't opt in/out, rejects legit non-achievement events); piggybacking on verifyKey (couples config to auth cache). |
| SDK sk story | Optional `secretKey` constructor option | One client class; `getStats()` throws without it; documented server-side-only. Separate server client deferred until there are 2–3 sk operations. |

## 3. Architecture

Order of work: integrity fixes (write path) land before the stats endpoint
(read path), so stats never reports numbers known to be lossy. All work follows
the existing layering — pure logic in `core`, persistence behind ports in
`adapter-db`, config plane behind `adapter-strapi`, wiring in `apps/api`.

### 3.1 Transactional ingestion (#2 + #3)

- New `IngestionStore` port (in `core/src/ports.ts`) with a single method that
  executes inside one `db.transaction` (pattern: `PgErasureStore.eraseUser`):
  1. Dedup-insert the event (`onConflictDoNothing` on
     `(project_id, environment, idempotency_key)`); if deduped, return early.
  2. Apply clamped SQL-side progress increments:
     `current = LEAST(achievement_progress.current + $delta, $target)
     … RETURNING current`.
  3. Insert unlocks gated on the *post-increment* `current >= target`
     (`onConflictDoNothing().returning()` keeps unlock idempotency and the
     webhook gate).
  4. Record usage.
- `evaluateEvent` contract change (`core/src/evaluate.ts`): returns
  **deltas + targets** per matching achievement instead of absolute values
  computed from pre-read counts. The pre-read `getCounts` call in the route
  goes away; the store's returned `current` decides unlocks.
- Config fetch stays outside the transaction (read-only, cached). Webhook
  dispatch stays outside (fire-and-forget, idempotent via
  `timed_event_notifications`).
- Semantics after the change: if anything inside the transaction throws, the
  event row rolls back too — dedup now records *completion*. An SDK retry
  re-runs the full chain instead of hitting `deduped: true` and silently
  skipping progress (the exact failure in issue #2).

### 3.2 Impression beacon (#6)

- `GET /v1/placements/:slug/offer` **stops recording impressions**.
- New `POST /v1/offers/:id/impression` with body `{ impressionId, userId? }` —
  `impressionId` is a client-generated idempotency key (UUID), `userId`
  optional to mirror the click payload.
- Migration `0003`: add `offer_events.idempotency_key` (nullable text) with a
  **partial unique index** on `(project_id, environment, idempotency_key)
  WHERE kind = 'impression' AND idempotency_key IS NOT NULL`; clicks unchanged.
  Also add the stats-covering index on
  `(project_id, environment, offer_id, kind)`.
- `Placement` widget fires the beacon only after the render decision passes
  `isOfferDismissed` — dismissed offers generate no request at all.
  Fire-and-forget like `clickOffer`.
- `resolveOffer` tie-break: equal priority resolves by lexicographic offer id
  (deterministic across config-cache refreshes). Documented in the function
  and README.

### 3.3 Registered event types

- `project` content type gains `registeredEventTypes` (json array of strings,
  each matching `EVENT_TYPE_PATTERN`).
- New config-plane endpoint exposes it; new `ConfigStore` port method
  `getRegisteredEventTypes(projectId)` with the standard 30s TTL +
  stale-on-error cache in `adapter-strapi`.
- Enforcement in `events.ts`: active iff the list is non-empty. Unknown type →
  `400 { error: "unregistered_event_type", suggestion: "level_complete" | null }`.
- Suggestion: Levenshtein distance ≤ 2 against the registered list, nearest
  match wins; pure function in `core` (`suggestEventType`).

### 3.4 Config-plane validation (#4)

- Zod schemas for all five `adapter-strapi` fetch responses: `getAchievements`
  (currently a blanket cast), `getOffers`, `getTimedEvents`,
  `getWebhookEndpoints`, and `verifyKey` (priority: the unchecked enum casts on
  `environment`/`keyType` flow straight into auth).
- Parse failure is treated as a fetch error → existing stale-on-error behavior
  applies.
- Add the three missing `verifyKey` cache-path tests: TTL-cache hit,
  stale-on-error, non-404 error does not cache. Drop the unnecessary
  `content-type` header on GETs.

### 3.5 Stats endpoint

- `GET /v1/stats?from=&to=` — sk-only (inline `keyType !== 'secret'` → 403,
  same as users route). Dates are ISO 8601; omitted bounds mean all-time.
- New `StatsStore` port; `PgStatsStore` runs aggregate queries scoped to
  `(project_id, environment)` with optional `created_at`/`occurred_at` range:
  - totals: events, unlocks, impressions, clicks, timed-event participants
  - per-achievement: unlock count
  - per-offer: impressions, clicks, CTR (clicks/impressions, null when no
    impressions)
  - per-timed-event: participation = distinct `user_id`s with at least one
    event whose `occurred_at` falls inside the event's `startsAt`–`endsAt`
    window. The route fetches the timed-event windows from the config store
    and passes them to `StatsStore` (runtime tables don't map events to timed
    events).
- `contracts/src/stats.ts`: `statsQuerySchema` + `statsResponseSchema`,
  exported from index; registered in `apps/api/src/openapi.ts` (schemas map +
  path entry with the sk security requirement).

### 3.6 SDK + demo

- SDK constructor gains optional `secretKey`; when present it is used as the
  bearer for sk-gated methods. `getStats()` throws a descriptive error if only
  a publishable key is configured. README documents: never ship `secretKey` to
  a browser.
- Demo: `app/stats/page.tsx` as a Next.js **server component** reading
  `PROMOCEAN_SECRET_KEY` from env (not `NEXT_PUBLIC_*`), calling `getStats()`
  server-side, rendering a simple table of the numbers. Satisfies the
  "no feature merges without demo-app usage" DoD without exposing the sk.

## 4. Data flow (stats read path)

Demo stats page (server) → SDK `getStats()` with sk → rate limiter → auth
(sk verified via config plane) → route sk gate → `StatsStore.getStats(projectId,
environment, from?, to?)` → aggregate queries → zod-shaped response → rendered
server-side.

## 5. Error handling

- **Stats:** 403 for publishable keys; 400 on invalid range (unparseable dates
  or `from > to`).
- **Ingestion:** transaction rollback → 500 → SDK retries → retry re-processes
  fully (dedup no longer lies).
- **Beacon:** fire-and-forget in the widget; impression loss on beacon failure
  is acceptable, inflation is not. Duplicate `impressionId` → no-op success.
- **Typo rejection:** 400 with `suggestion: null` when nothing is within
  distance 2.
- **Config-plane validation failure:** behaves as a fetch error; stale cache
  serves if present, otherwise the existing error paths apply.

## 6. Testing

- `core`: evaluate-delta contract tests; `suggestEventType` unit tests
  (exact, distance-1/2, no-match, empty list).
- `adapter-db` (Testcontainers): concurrent-increment race test (two parallel
  ingests of distinct events for the same user/achievement — both counted);
  rollback test (induced failure mid-transaction — event row absent, retry
  succeeds); beacon idempotency (duplicate `impressionId` → one row); stats
  aggregation correctness incl. date-range boundaries.
- `adapter-strapi`: zod rejection of malformed responses per method; the three
  verifyKey cache-path tests.
- `apps/api` (fakes): stats route (sk gate, 403 pk, date filters, empty
  project); typo rejection (400 + suggestion shape); impression beacon route;
  placements GET no longer records impressions.
- e2e (Playwright): extend `offer-loop.spec.ts` — dismissed offer produces no
  impression request on reload; stats page shows non-zero counts after the
  achievement loop runs.
- Migration `0003` applied via existing `runMigrations` path (API boot + test
  `beforeAll`).

## 7. Definition of done

Workspace typecheck + all unit/integration tests green; all Playwright specs
green including the new stats/dismissal assertions; demo stats page exercises
`GET /v1/stats` end-to-end; docs snippets for stats, the beacon, registered
event types, and `secretKey` usage; issues #2, #3, #4, #6 closable.
