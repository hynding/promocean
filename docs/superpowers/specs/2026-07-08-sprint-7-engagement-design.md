# Sprint 7 Design: Engagement Mechanics

**Date:** 2026-07-08
**Theme:** Points, ranks, streaks — the v1.x engagement trio in deliberately
thin, demo-visible slices, built on the transactional ingestion substrate
Sprint 5 made race-free.
**Parent spec:** `2026-07-06-promocean-design.md` §7 (v1.x: "Leaderboards,
streaks (needs per-user timezone windows), points/XP wallet")
**Branch:** `sprint-7-engagement` (off `main` at the PR #17 merge)

## 1. Scope

In scope (decided with Steve, 2026-07-08):

1. **Points ledger + wallet** — append-only `points_ledger`, awards inside
   the existing ingestion transaction, `GET /v1/users/:userId/wallet`
2. **Leaderboards** — points-ranked, all-time + rolling 7d/30d windows,
   `GET /v1/leaderboard`
3. **Streaks** — consecutive-local-day activity counter maintained in the
   ingestion transaction, `GET /v1/users/:userId/streak`
4. **SDK** — `getWallet()`, `getStreak()`, `getLeaderboard(opts)`; `track`
   automatically sends the device tz offset
5. **Widgets** — one new `Leaderboard` component
6. **Demo + e2e** — points/streak readouts + leaderboard in the demo; e2e
   extended; runs against the Docker stack in CI as established

Out of scope: spend/debit APIs (the future coupons/offerwall seam —
ledger deltas are ≥ 0 this sprint), leaderboard pagination beyond `limit`,
streak freeze/repair mechanics, per-user timezone settings, issues
#5/#15/#18 (backlog), coupons, remaining v1.x items.

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Sprint scope | All three mechanics, thin slices | Points are the substrate; leaderboards rank them, streaks complement them. Each minimal but demo-visible. Rejected: wallet-only-deep (least visible), wallet+leaderboards (ships engagement without the retention mechanic). |
| Points source | Achievements AND per-event rules | `pointsValue` on achievements (big bonus on unlock, idempotent by unlock semantics) + `pointRules` json on project (`{eventType: points}`, continuous flow so leaderboards move on activity). Rejected: unlock-only (leaderboards stagnate), rules-only (loses the unlock-bonus mechanic). |
| Streak day boundary | Client tz offset per event | SDK sends `tzOffsetMinutes` with each track; local day = `occurredAt + offset`. Works for anonymous users, no settings store. Offset changes (travel/DST) can occasionally double-count or skip a day — accepted and documented. Rejected: UTC days (evening-active users see random breaks — the exact wrongness the parent spec warns about); per-user tz setting (needs a user-settings subsystem that doesn't exist). |
| Balances | Computed (SUM over ledger), not maintained | Correct by construction, no new race surface, windows need the ledger timestamps anyway. Materialized balance is a later optimization if reads get hot. |
| Award point-in-time | Inside `PgIngestionStore.ingestEvent` | Inherits dedup and rollback semantics for free: a deduped event awards nothing, a rolled-back ingest leaves no points and no streak change. |
| Leaderboard privacy | External user ids exposed to pk holders, documented | The host app owns the ids and maps them to display names; apps needing pseudonymity pass opaque ids to `identify()`. Documented in README + SDK docs. |

## 3. Architecture

### 3.1 Config plane

- `achievement` content type gains `pointsValue` (integer ≥ 0, optional,
  default 0 = no award). Config-plane achievements endpoint + adapter-strapi
  schema + `AchievementDefinition` in core gain the field.
- `project` gains `pointRules` (json object `{ [eventType]: points }`);
  values validated server-side like `registeredEventTypes` (event-type
  pattern keys, non-negative integer values; invalid entries filtered +
  `strapi.log.warn`). New dedicated config-plane endpoint
  `GET /config-plane/projects/:projectId/point-rules` (same `x-config-secret`
  guard, one-endpoint-per-concern like event-types) +
  `ConfigStore.getPointRules(projectId)` port method with the standard TTL
  + stale-on-error cache.

### 3.2 Points ledger (migration 0006)

`points_ledger`: `id uuid PK`, tenancy (`project_id`, `environment`),
`user_id`, `delta integer` (≥ 0 enforced at write layer), `source text`
(`'event' | 'unlock'`), `source_ref text` (event type or achievement id),
`created_at timestamptz`. Indexes: `(project_id, environment, user_id)`
for balance sums; `(project_id, environment, created_at)` for windowed
leaderboards.

Awards inside `ingestEvent` (extending the Sprint 5 transaction):
1. After the dedup gate: if `pointRules[event.type]` > 0, insert one
   `'event'` ledger row.
2. For each `newUnlock` whose achievement has `pointsValue` > 0, insert one
   `'unlock'` row. Unlock idempotency (`onConflictDoNothing` on unlocks)
   gates the award — a replayed unlock awards nothing.
The route passes rule/points data into `ingestEvent` (evaluated from config
by the route, keeping the store config-free — mirrors how increments are
passed today).

### 3.3 Streaks (same transaction)

`user_streaks`: tenancy + `user_id` (unique), `current_streak integer`,
`longest_streak integer`, `last_active_day date`, `updated_at`.

- Local day: `occurredAt` shifted by `tzOffsetMinutes` (new OPTIONAL field
  on the track request, integer, clamped to ±840; missing/invalid → 0 =
  UTC day, documented fallback).
- Transition (pure function in core, `applyStreak(prevDay, prevStreak, day)`):
  same day → no change; `prevDay + 1 day` → increment; anything else →
  reset to 1. `longest_streak = GREATEST(longest, current)`.
- Applied via `SELECT ... FOR UPDATE` on the user's streak row inside the
  existing transaction (insert-if-absent first), then a plain UPDATE with
  the computed transition. Chosen over a conditional ON CONFLICT upsert
  because the three-way transition (no-op/increment/reset) plus
  `longest = GREATEST(...)` reads clearer as lock-compute-write, and the
  transaction is already open. Streak correctness must NOT rely on the
  incidental row-ordering of the progress upserts.

### 3.4 API

| Endpoint | Auth | Response |
|---|---|---|
| `GET /v1/users/:userId/wallet` | pk (any key) | `{ balance: int, recent: [{ delta, source, sourceRef, at }] }` — last 20 ledger entries, newest first |
| `GET /v1/users/:userId/streak` | pk | `{ current: int, longest: int, lastActiveDay: 'YYYY-MM-DD' \| null }` (all zeros/null when unseen) |
| `GET /v1/leaderboard?window=all\|7d\|30d&limit=1..100` | pk | `{ window, entries: [{ rank, userId, points }] }` — defaults window=all, limit=10; ties share points order deterministically (secondary sort by userId) |

userId path params bounded 1..128 as elsewhere; bad `window`/`limit` →
400 `invalid_payload`. All three documented in OpenAPI; contracts gain
`wallet.ts` / `streaks.ts` / `leaderboard.ts` schemas.

**Privacy (documented in README + SDK docs):** leaderboard entries expose
external user ids to any pk holder. The host app owns those ids and maps
them to display names; apps needing pseudonymity should pass opaque ids to
`identify()`.

### 3.5 SDK + widgets

- SDK: `getWallet(): Promise<WalletResponse>`, `getStreak(): Promise<StreakResponse>`
  (both require an identified user, like `getAchievements`),
  `getLeaderboard(opts?: { window?: 'all'|'7d'|'30d'; limit?: number })`.
  `track` gains automatic `tzOffsetMinutes` from
  `-new Date().getTimezoneOffset()` (sign-corrected to "minutes east of
  UTC"); automatic-only, no caller override (YAGNI — server-side SDK users
  who care can construct requests directly).
- Widgets: `Leaderboard` component — top-N table via `getLeaderboard`,
  highlights the identified user's row; styling consistent with existing
  widgets (inline styles, data-promocean attribute).

### 3.6 Demo, seed, e2e

Seed: `pointRules: { lesson_completed: 10, profile_completed: 25 }`;
existing achievements gain `pointsValue` (e.g. 50/100). Demo page shows
wallet balance + streak next to the badge cabinet and renders
`<Leaderboard />`. e2e (achievement-loop or a new engagement spec): track →
wallet balance > 0 → leaderboard contains the demo user with matching
points. Runs against the compose stack locally and in CI (established).

## 4. Data flow

Track → ingestion transaction: dedup-insert → progress increments → unlock
inserts → **points rows (event rule + unlock bonuses) → streak upsert** →
usage. Reads are scoped queries; leaderboard =
`SELECT user_id, SUM(delta) ... GROUP BY user_id ORDER BY points DESC,
user_id ASC LIMIT n`, with `created_at >= now - window` for 7d/30d.

## 5. Error handling

- No `pointRules` and no `pointsValue` configured → zero ledger writes;
  wallet/streak/leaderboard endpoints return empty-state shapes (feature
  dormant at no cost).
- Missing/invalid/out-of-range `tzOffsetMinutes` → treated as 0 (UTC day),
  never a 400 (additive, must not break existing SDK clients).
- Rollback semantics inherited: any failure inside the transaction removes
  the event, points, and streak change together; the SDK retry re-runs all
  of it.
- Leaderboard on an empty project → `{ window, entries: [] }`.

## 6. Testing

- `core`: `localDayFromOffset` (boundaries, ±840 clamp, invalid → 0) and
  `applyStreak` (same-day, increment, reset, month/year boundaries, DST-ish
  offset changes) exhaustive unit tests; points-from-rules calculation.
- `adapter-db` (Testcontainers): points rows written atomically with the
  event (rollback test removes event + points + streak together); unlock
  replay awards nothing; concurrent same-user ingests produce correct
  streak (no lost update) and correct ledger sum; leaderboard window
  boundaries inclusive/exclusive pinned; cross-tenant isolation.
- `api` (fakes): three routes — shapes, validation (bad window/limit →
  400), empty states, userId bounds.
- SDK: tz offset present + sign-correct on track; three new methods parse
  responses; identified-user guards. Widgets: Leaderboard renders rows +
  highlights current user.
- e2e: engagement flow green against the compose stack.

## 7. Definition of done

Workspace typecheck/build/test green; compose-stack e2e green locally and
in CI (including the new engagement assertions); demo exercises wallet,
streak, and leaderboard end-to-end; OpenAPI documents the three endpoints;
README + SDK/widgets docs updated (including the leaderboard privacy note
and tz-offset fallback); seed updated so a fresh `--profile stack` boot
shows a moving leaderboard.
