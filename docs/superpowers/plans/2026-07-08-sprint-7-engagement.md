# Promocean Sprint 7: Engagement Mechanics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Points ledger + wallet, windowed leaderboards, and local-day streaks — the v1.x engagement trio in thin demo-visible slices, all awarded inside the existing ingestion transaction.

**Architecture:** One new substrate (append-only `points_ledger`) written inside `PgIngestionStore.ingestEvent` so dedup/rollback semantics are inherited; `user_streaks` maintained in the same transaction via explicit lock-compute-write; two read surfaces (wallet, leaderboard) as computed queries behind a new `EngagementStore` port. Config: `pointsValue` on achievements + `pointRules` json on project, served by a dedicated config-plane endpoint. Layering as always: pure calc in `core`, persistence in `adapter-db`, config in cms/adapter-strapi, routes in `apps/api`, then SDK → widgets → demo/e2e.

**Spec:** `docs/superpowers/specs/2026-07-08-sprint-7-engagement-design.md`. Branch `sprint-7-engagement` off main (PR #17 merge).

## Global Constraints

(All prior global constraints bind: error envelope, zod contracts single source of truth, TDD per task, per-package gates green before commit, known-break pattern recorded on port widening, compose-stack e2e in CI.)

Sprint-7 additions (values verbatim from the spec):
- Ledger deltas are ≥ 0 this sprint (no spend surface). `source` ∈ `'event' | 'unlock'`; `source_ref` = event type or achievement id.
- Awards happen INSIDE `ingestEvent`: deduped event → zero writes; rollback removes event + points + streak together. Unlock idempotency gates unlock bonuses (replayed unlock awards nothing).
- Balances computed (`SUM(delta)`), never maintained.
- `tzOffsetMinutes`: optional int on the track request; contracts schema accepts any int (NEVER a 400 for range); core clamps to ±840, missing/invalid → 0 (UTC day). SDK sends `-new Date().getTimezoneOffset()` automatically, no caller override.
- Streak transition: same local day → no-op; previous day → increment; else reset to 1. `longest = GREATEST(longest, current)`. Applied via `SELECT ... FOR UPDATE` (insert-if-absent first) then plain UPDATE — never rely on incidental row-ordering of the progress upserts.
- Leaderboard: `window ∈ all|7d|30d` (default `all`), `limit 1..100` (default 10); bad values → 400 `invalid_payload`; ordering `points DESC, user_id ASC` (deterministic ties); empty project → `{ window, entries: [] }`.
- Wallet: balance + last 20 ledger entries newest-first. Streak: zeros/null when user unseen. All three endpoints pk-accessible; userId params bounded 1..128.
- Privacy note (README + SDK docs): leaderboard exposes external user ids to any pk holder; host apps map ids to display names; pass opaque ids to `identify()` for pseudonymity.
- Config validation in cms mirrors registeredEventTypes: `pointRules` keys must match `/^[a-z][a-z0-9_]*$/`, values non-negative integers; invalid entries filtered + `strapi.log.warn`. `pointsValue` integer ≥ 0, default 0.

---

### Task 1: contracts — engagement schemas + tzOffsetMinutes

**Files:** Create `packages/contracts/src/wallet.ts`, `src/streaks.ts`, `src/leaderboard.ts`; modify `src/events.ts` (track request), `src/index.ts`; test append `packages/contracts/test/contracts.test.ts`.

**Interfaces — produces:**
```ts
// events.ts: trackEventRequestSchema gains tzOffsetMinutes: z.number().int().optional()  (NO min/max — clamping is core's job)

// wallet.ts
export const walletResponseSchema = z.object({
  balance: z.number().int(),
  recent: z.array(z.object({
    delta: z.number().int(), source: z.enum(['event', 'unlock']),
    sourceRef: z.string(), at: z.iso.datetime(),
  })),
})
export type WalletResponse = z.infer<typeof walletResponseSchema>

// streaks.ts
export const streakResponseSchema = z.object({
  current: z.number().int(), longest: z.number().int(),
  lastActiveDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
})
export type StreakResponse = z.infer<typeof streakResponseSchema>

// leaderboard.ts
export const leaderboardWindowSchema = z.enum(['all', '7d', '30d'])
export const leaderboardResponseSchema = z.object({
  window: leaderboardWindowSchema,
  entries: z.array(z.object({ rank: z.number().int().min(1), userId: z.string(), points: z.number().int() })),
})
export type LeaderboardWindow = z.infer<typeof leaderboardWindowSchema>
export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>
```
Tests (RED first): each schema round-trips; track request with/without tzOffsetMinutes accepted, non-int rejected; bad source enum rejected; lastActiveDay format enforced + nullable. Additive only — no known break. Commit: `feat(contracts): wallet, streak, leaderboard schemas and track tz offset`

---

### Task 2: core — pure engagement logic, ports, type widening

**Files:** Modify `packages/core/src/types.ts`, `src/ports.ts`, `src/index.ts`; create `src/engagement.ts`; tests `packages/core/test/engagement.test.ts`.

**Interfaces — produces:**
```ts
// types.ts: AchievementDefinition gains pointsValue: number (0 = no award)
export type PointRules = Record<string, number> // eventType -> points

// engagement.ts (pure, exhaustive tests)
export function localDayFromOffset(occurredAt: Date, tzOffsetMinutes: number | undefined): string
// clamp to [-840, 840]; undefined/NaN/non-finite -> 0; returns 'YYYY-MM-DD' of occurredAt shifted by offset minutes (east-positive)
export interface StreakState { current: number; longest: number; lastActiveDay: string | null }
export function applyStreak(prev: StreakState, day: string): StreakState | null
// null = same-day no-op; prev.lastActiveDay === day-1 (calendar-aware) -> current+1; else -> 1; longest = max(longest, new current)
export function pointsForEvent(rules: PointRules, eventType: string): number // rules[type] ?? 0, floor negative/non-finite to 0

// ports.ts:
// ConfigStore gains getPointRules(projectId: string): Promise<PointRules>
// IngestionStore.ingestEvent gains a 5th param:
export interface EngagementWrite {
  localDay: string // 'YYYY-MM-DD', already offset-resolved by the route
  eventPoints: { points: number; sourceRef: string } | null // null when no rule matched
  unlockPoints: Record<string, number> // achievementId -> pointsValue (>0 entries only)
}
// ingestEvent(scope, event, increments, month, engagement: EngagementWrite): Promise<...unchanged return...>
export interface EngagementStore {
  getWallet(scope: Scope, userId: string): Promise<{ balance: number; recent: Array<{ delta: number; source: 'event' | 'unlock'; sourceRef: string; at: Date }> }>
  getStreak(scope: Scope, userId: string): Promise<{ current: number; longest: number; lastActiveDay: string | null }>
  getLeaderboard(scope: Scope, window: 'all' | '7d' | '30d', limit: number): Promise<Array<{ rank: number; userId: string; points: number }>>
}
```
Calendar math in `applyStreak`/`localDayFromOffset`: implement with UTC Date arithmetic on the shifted timestamp (no tz libraries — zero new deps); "day-1" comparison must be calendar-correct across month/year boundaries (compare via Date.UTC of the parsed day strings).

**Known break (record, don't patch):** `ingestEvent` widening + `ConfigStore.getPointRules` break adapter-db, adapter-strapi, apps/api until Tasks 3/5/6. Core gates green.

Tests: localDayFromOffset — offset 0/positive/negative crossing midnight both directions, ±840 clamp, undefined/NaN→0, exact day-boundary instants; applyStreak — same-day null, consecutive increment (incl. month/year rollover), gap reset, longest tracking, first-ever event (lastActiveDay null → current 1); pointsForEvent — hit/miss/zero/negative-floored. Commit: `feat(core): engagement calculations, ports, and ingest widening`

---

### Task 3: adapter-db — migration 0006, transactional awards, engagement reads

**Files:** Modify `packages/adapter-db/src/schema.ts`, `src/stores.ts`, `src/index.ts`; create migration `packages/adapter-db/migrations/0006_*` (drizzle-kit generate); tests `packages/adapter-db/test/engagement.test.ts` + extend `test/ingestion.test.ts`.

**Schema:** `points_ledger` (`id uuid PK default random`, `project_id`, `environment`, `user_id`, `delta integer NOT NULL`, `source text NOT NULL`, `source_ref text NOT NULL`, `created_at timestamptz default now()`), indexes `points_ledger_user_ix (project_id, environment, user_id)` and `points_ledger_window_ix (project_id, environment, created_at)`. `user_streaks` (`project_id`, `environment`, `user_id`, `current_streak integer NOT NULL default 0`, `longest_streak integer NOT NULL default 0`, `last_active_day date`, `updated_at timestamptz default now()`, unique `(project_id, environment, user_id)`).

**Behavior:**
- `PgIngestionStore.ingestEvent(..., engagement)` — inside the existing transaction, after unlock inserts, before usage: (1) if `engagement.eventPoints`, insert one `'event'` ledger row; (2) for each `newUnlocks` entry with `engagement.unlockPoints[achievementId] > 0`, insert one `'unlock'` row (only NEWLY-inserted unlocks — the returning-gated list, so replays award nothing); (3) streak: `INSERT ... ON CONFLICT DO NOTHING` the user's streak row, `SELECT ... FOR UPDATE`, compute via `applyStreak(prev, engagement.localDay)` (import from @promocean/core — pure fn usable in the adapter), plain UPDATE when non-null.
- `PgEngagementStore implements EngagementStore`: wallet = `COALESCE(SUM(delta),0)` + last-20 newest-first; streak = row or zeros/null; leaderboard = `SUM(delta) GROUP BY user_id ORDER BY points DESC, user_id ASC LIMIT n`, `created_at >= now() - interval` for 7d/30d, rank assigned in JS from result order (1-based).

Tests (Testcontainers): rollback (NaN-delta style injection or invalid day) removes event + ledger rows + streak change together; deduped replay writes nothing; unlock replay awards no second bonus; streak transitions live (two ingests same day → 1; next-day → 2; gap → 1; longest preserved); concurrent same-user same-day ingests → streak exactly 1, ledger sum exact (FOR UPDATE serializes); leaderboard window boundary (row just inside vs just outside 7d), tie ordering by user_id, cross-tenant isolation; wallet recent capped at 20 newest-first. Workspace still red (api) — known break continues until Task 6. Commit: `feat(adapter-db): points ledger, user streaks, engagement reads (migration 0006)`

---

### Task 4: cms — pointsValue, pointRules, point-rules endpoint, seed

**Files:** Modify `apps/cms/src/api/achievement/content-types/achievement/schema.json` (add `"pointsValue": { "type": "integer", "min": 0, "default": 0 }`), `apps/cms/src/api/project/content-types/project/schema.json` (add `"pointRules": { "type": "json" }`); config-plane controller + routes (new `GET /config-plane/projects/:projectId/point-rules`, same `configSecretOk` guard; response `{ pointRules: Record<string, number> }` — filter keys to `/^[a-z][a-z0-9_]*$/`, values to non-negative integers, invalid entries dropped + `strapi.log.warn`, missing project → 404, null/absent field → `{}`); achievements config-plane response gains `pointsValue: r.pointsValue ?? 0`; seed (`apps/cms/src/index.ts`): demo project gains `pointRules: { lesson_completed: 10, profile_completed: 25 }`, seeded achievements gain `pointsValue` 50 and 100; regenerate contentTypes.d.ts.

Verification: live curl — point-rules guard/404/happy/filter paths + achievements now carrying pointsValue; typecheck green. Commit: `feat(cms): achievement points and project point rules via config-plane`

---

### Task 5: adapter-strapi — pointsValue schema + getPointRules

**Files:** Modify `packages/adapter-strapi/src/index.ts`, `src/schemas.ts`; test `packages/adapter-strapi/test/adapter.test.ts`.

**Behavior:** achievements response schema gains `pointsValue: z.number().int().min(0).default(0)` mapped into `AchievementDefinition`; new `getPointRules(projectId)` implementing the widened ConfigStore — same TTL + stale-on-error machinery, zod schema `{ pointRules: z.record(z.string(), z.number()) }` with values floored to non-negative ints on map (defense in depth; cms already filters). Tests: pointsValue parsed/defaulted; point-rules happy path, cache hit, malformed → throws → stale-on-error, missing field tolerated. apps/api still red until Task 6 — recorded. Commit: `feat(adapter-strapi): achievement points and point-rules config fetch`

---

### Task 6: api — engagement wiring + three read endpoints

**Files:** Modify `apps/api/src/routes/events.ts`, create `src/routes/wallet.ts` (or one `src/routes/engagement.ts` housing all three handlers — one file, they share nothing but deps), modify `src/app.ts` (mount routes; AppDeps gains `engagementStore: EngagementStore`), `src/index.ts` (wire `PgEngagementStore`), `src/openapi.ts` (three paths + schemas), `test/fakes.ts` (ingestion fake accepts+records the engagement param; engagement read fake with settable data); tests `apps/api/test/engagement.test.ts` + adjust `test/app.test.ts` call sites.

**events.ts additions (order):** after the registered-type gate and before evaluate — `const pointRules = await deps.configStore.getPointRules(scope.projectId).catch(() => ({}))` (fail-open + child-logger warn, mirroring event-types); build `engagement: EngagementWrite` = `{ localDay: localDayFromOffset(occurredAt, parsed.data.tzOffsetMinutes), eventPoints: pointsForEvent(pointRules, type) > 0 ? { points: pointsForEvent(pointRules, type), sourceRef: type } : null, unlockPoints: Object.fromEntries(plan.increments.filter(i => defsById.get(i.achievementId)!.pointsValue > 0).map(i => [i.achievementId, defsById.get(i.achievementId)!.pointsValue])) }` — build `defsById` from the already-fetched definitions (no second config fetch; use a safe lookup, not `!`, consistent with the Sprint 6 nameById fallback). Pass as 5th arg to `ingestEvent`. Response shapes unchanged.

**Engagement routes:** `GET /v1/users/:userId/wallet` and `/streak` (userId bounds 1..128 → 400; pk allowed) map store results to contract shapes (`at` → ISO). `GET /v1/leaderboard` — parse `window` via `leaderboardWindowSchema` (default 'all'), `limit` int 1..100 (default 10), bad → 400 `invalid_payload`; respond `{ window, entries }` `satisfies LeaderboardResponse`.

Tests: track with tzOffsetMinutes forwards correct localDay to the fake (capture args); rule-hit/rule-miss eventPoints; unlockPoints only for pointsValue>0 achievements; config failure → empty rules, event still ingests; wallet/streak/leaderboard shapes incl. empty states, validation cases, userId bounds; openapi test asserts eleven paths. Workspace typecheck fully green again after this task. Commit: `feat(api): engagement awards in ingestion and wallet/streak/leaderboard endpoints`

---

### Task 7: sdk — engagement reads + automatic tz offset

**Files:** Modify `packages/sdk/src/index.ts`; test `packages/sdk/test/sdk.test.ts`.

**Interfaces — produces:**
```ts
// track body gains tzOffsetMinutes: -new Date().getTimezoneOffset()  (east-positive; computed per call, no override)
async getWallet(): Promise<WalletResponse>      // requires identified user; GET /v1/users/:id/wallet; parse walletResponseSchema
async getStreak(): Promise<StreakResponse>      // same pattern
async getLeaderboard(opts?: { window?: 'all' | '7d' | '30d'; limit?: number }): Promise<LeaderboardResponse>
// GET /v1/leaderboard with only the provided params in the querystring; parse leaderboardResponseSchema
get currentUserId(): string | undefined  // read-only accessor for the identified user (Task 8's Leaderboard highlight consumes this)
```
Tests: track body carries the sign-corrected offset (mock Date.prototype.getTimezoneOffset returning e.g. -120 → body tzOffsetMinutes 120); the three methods hit the right paths, parse, and the user-required guards throw the established descriptive error; leaderboard querystring encodes only provided opts. Commit: `feat(sdk): wallet, streak, leaderboard reads and automatic tz offset`

---

### Task 8: widgets — Leaderboard component

**Files:** Create `packages/widgets/src/leaderboard.tsx`; modify `src/index.ts` (export); tests `packages/widgets/test/widgets.test.tsx`.

**Behavior:** `<Leaderboard window?: 'all'|'7d'|'30d' limit?: number title?: string />` — fetches via `usePromocean().getLeaderboard(...)` in a cancelled-guarded effect (the established Placement pattern, StrictMode-safe); renders rank/userId/points rows with the identified user's row visually highlighted (compare against `client.currentUserId` — the read-only getter Task 7 adds to the SDK); `data-promocean-leaderboard` attribute; inline styles consistent with existing widgets; fail-silent-to-empty on fetch error.

Tests: renders rows from fake client; highlights current user; unmount-before-resolve safe; error → renders nothing. Commit: `feat(widgets): leaderboard component`

---

### Task 9: demo, seed e2e, docs — sprint DoD

**Files:** Modify `apps/demo/app/promocean.tsx` (wallet balance + streak readouts near the badge cabinet — client-side via `getWallet`/`getStreak` after track events, simple text; plus `<Leaderboard limit={5} />`), e2e: extend `apps/demo/e2e/achievement-loop.spec.ts` or add `engagement-loop.spec.ts` (track → wallet balance equals seeded rule+bonus math → leaderboard shows the demo user with the same points); docs: root README (engagement endpoints in the API table + a short "Points, streaks, leaderboards" section incl. the privacy note and tz-offset fallback), `packages/sdk/README.md` (three methods + tz note + privacy note), `packages/widgets/README.md` (Leaderboard usage).

**DoD steps (in order):** `pnpm turbo run typecheck build test` fully green; boot the compose stack (`docker compose --profile stack build && up -d --wait` — images now contain Sprint 7 code) and run `pnpm --filter demo e2e` — ALL specs green including the new engagement assertions; verify by hand-curl: wallet shows rule points + unlock bonus after the e2e run; stop the stack; push branch; confirm the GitHub Actions compose e2e goes green (poll the public checks API as established). Commit: `feat(demo): engagement readouts and leaderboard; docs — sprint 7 wrap`

PR notes must state: no existing wire shapes changed (tzOffsetMinutes additive; three new endpoints); leaderboard privacy posture; delivers the third v1.x roadmap slice (leaderboards, streaks, points wallet).

---

## Self-Review Notes

- **Spec coverage:** §3.1 config plane ✓ (T4 cms, T5 adapter, T2 port); §3.2 ledger + transactional awards ✓ (T2 EngagementWrite, T3 migration/store, T6 route wiring); §3.3 streaks ✓ (T2 pure fns + T3 FOR UPDATE + T6 localDay pass-through); §3.4 API ✓ (T1 contracts, T6 routes + openapi); §3.5 SDK/widgets ✓ (T7, T8 — incl. the `currentUserId` getter added in T7, consumed in T8); §3.6 demo/seed/e2e ✓ (T4 seed, T9); §5 error handling distributed (dormant-feature zero-cost T3/T6, tz fallback T2, validation T6); §6 testing mapped 1:1; §7 DoD = T9.
- **Known-break chain:** T2 widens ingestEvent + ConfigStore → adapter-db green at T3, adapter-strapi at T5, api at T6 (same three-task shape as Sprint 5; recorded).
- **Type consistency:** `EngagementWrite` shape identical in T2 (port), T3 (impl), T6 (builder); `EngagementStore` method names/returns identical in T2/T3/T6; `leaderboardWindowSchema` values `'all'|'7d'|'30d'` consistent across T1/T2/T6/T7/T8; `getPointRules` name consistent T2/T5/T6.
- **Deliberate choices encoded:** rank computed in JS from ordered results (no window functions needed at limit ≤ 100); `applyStreak` imported into adapter-db from core (pure fn — same dependency direction as evaluate helpers); `currentUserId` getter is the one SDK surface addition beyond the spec's literal list, exists solely so the widget can highlight without prop-drilling — flagged for reviewers.
- **Compression note:** as with Sprints 2–6, test code specified behaviorally; production interfaces, env-free defaults, and validation bounds are exact.
