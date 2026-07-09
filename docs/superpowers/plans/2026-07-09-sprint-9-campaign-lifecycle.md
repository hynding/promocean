# Promocean Sprint 9: Campaign Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Definitions reach backward and forward in time: `POST /v1/achievements/:id/backfill` replays the stored event log against a definition (idempotent, bonus-awarding), and timed events recur (`daily|weekly|monthly`) as virtual occurrences with per-occurrence webhooks — no new tables beyond one additive column.

**Architecture:** Pure occurrence-window arithmetic in `core` (any instant maps to at most one occurrence deterministically); the scheduler, live feed, multiplier, and stats all ask core "which window?" instead of reading `startsAt`/`endsAt` directly. Runtime state that must distinguish occurrences (webhook claims) gains an `occurrence_key` (`''` for non-recurring — zero behavior change for existing rows). Backfill is one adapter-db transaction: SQL aggregate over `events`, GREATEST-only progress raises, returning-gated unlock bonuses — the exact live-path idioms, so wallets match. Layering as always: pure calc in core, persistence in adapter-db, config in cms/adapter-strapi, routes/scheduler in apps/api, then SDK → demo/e2e.

**Spec:** `docs/superpowers/specs/2026-07-09-sprint-9-campaign-lifecycle-design.md`. Branch `sprint-9-campaign-lifecycle` off main (PR #22 merge).

## Global Constraints

(All prior global constraints bind: error envelope, zod contracts single source of truth, TDD per task, per-package gates green before commit, known-break pattern recorded on port widening, compose-stack e2e in CI. The api package's pnpm filter name is `api`.)

Sprint-9 additions (values verbatim from the spec):
- `recurrence ∈ 'none' | 'daily' | 'weekly' | 'monthly'` (default `'none'`), `recurrenceEndsAt: Date | null` (null = forever). `startsAt`/`endsAt` define occurrence 0; every occurrence keeps that duration. Daily = 86_400_000 ms, weekly = 604_800_000 ms, monthly = UTC calendar-month stepping with day-of-month clamping (Jan 31 + 1mo → Feb 28/29). Recurrence is UTC-instant arithmetic — occurrences drift against local wall clocks across DST; document, don't compensate.
- An occurrence exists iff its `startsAt` is strictly before `recurrenceEndsAt` (when set). Duration ≤ interval (monthly validates against 28 days) — enforced in cms lifecycles; core documents the precondition.
- `occurrenceKey` = the occurrence's `startsAt` ISO string (`.toISOString()`); `''` for `recurrence === 'none'` and for all pre-existing claim rows. Window containment is start-inclusive, end-exclusive (`now < startsAt` → not started; `now >= endsAt` → over) — identical to existing `timedEventState` semantics.
- Webhook payload: `data.startsAt`/`data.endsAt` stay the DEFINITION's values (unchanged); recurring transitions add `data.occurrence: { startsAt, endsAt }` (additive). `messageId`/HMAC contract unchanged.
- Backfill: sk-only; awards progress (GREATEST — only ever raises), unlocks (`onConflictDoNothing`), and `pointsValue` bonuses ONLY when the unlock insert returned a row (`source: 'unlock'`, `sourceRef: achievementId` — byte-identical to the live path); backfilled `unlockedAt = now()`; NO webhooks; single transaction under `pg_advisory_xact_lock(hashtext('{projectId}:{environment}'), hashtext('backfill:' + achievementId))`. Re-running is a no-op. Response `{ usersEvaluated, progressRaised, unlocksGranted, pointsAwarded }` — `pointsAwarded` is the SUM of bonus deltas; the other three are row counts.
- Stats: a recurring event's participation windows are its occurrence windows intersecting the query range, capped at the most recent 400 within range (clamp documented in OpenAPI); a user active in several occurrences counts once per event.
- Scheduler-downtime edge (accepted, documented): an entire occurrence missed while the scheduler is down past scan grace drops that occurrence's transitions — the existing at-least-once posture.

---

### Task 1: contracts — recurrence fields + backfill response

**Files:** Modify `packages/contracts/src/timed-events.ts`, `src/achievements.ts`, `src/index.ts` (export additions); test append `packages/contracts/test/contracts.test.ts`.

**Interfaces — produces:**
```ts
// timed-events.ts
export const recurrenceSchema = z.enum(['none', 'daily', 'weekly', 'monthly'])
export type Recurrence = z.infer<typeof recurrenceSchema>
// liveTimedEventSchema gains (additive-with-defaults so old-server responses still parse):
//   recurrence: recurrenceSchema.default('none'),
//   nextOccurrenceStartsAt: z.iso.datetime().nullable().default(null),
// nextOccurrenceStartsAt = start of the occurrence AFTER the one reported in startsAt/endsAt; null when none.

// achievements.ts
export const backfillResponseSchema = z.object({
  usersEvaluated: z.number().int().min(0),
  progressRaised: z.number().int().min(0),
  unlocksGranted: z.number().int().min(0),
  pointsAwarded: z.number().int().min(0),
})
export type BackfillResponse = z.infer<typeof backfillResponseSchema>
```
Tests (RED first): recurrence enum accepts the four values, rejects others; live event WITHOUT the two new fields still parses (defaults applied — the back-compat property, assert the parsed values are `'none'`/`null`); live event with them round-trips; backfill response round-trips, negative counts rejected. Additive only — no known break. Commit: `feat(contracts): timed-event recurrence fields and backfill response`

---

### Task 2: core — occurrence math, occurrence-aware state, port widenings

**Files:** Modify `packages/core/src/types.ts`, `src/timed-events.ts`, `src/ports.ts`, `src/index.ts`; tests `packages/core/test/occurrences.test.ts` + adjust `test/timed-events.test.ts` fixtures (existing `TimedEventDefinition` literals gain the two new required fields).

**Interfaces — produces:**
```ts
// types.ts
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly'
// TimedEventDefinition gains: recurrence: Recurrence; recurrenceEndsAt: Date | null

// timed-events.ts
export interface OccurrenceWindow { index: number; startsAt: Date; endsAt: Date; key: string }
export function occurrenceWindow(event: TimedEventDefinition, now: Date): OccurrenceWindow | null
// The occurrence containing `now`, else the NEXT upcoming one, else null (no current-or-future
// occurrence: a non-recurring event past endsAt, or recurrence past recurrenceEndsAt).
// This is the DISPLAY/multiplier view.
export function transitionOccurrence(event: TimedEventDefinition, now: Date): OccurrenceWindow | null
// The latest EXISTING occurrence with startsAt <= now, else null (nothing started yet).
// This is the SCHEDULER view: between occurrences it returns the just-elapsed occurrence so its
// 'ended' transition can fire; occurrenceWindow would already be pointing at the next one.
export function occurrenceFromKey(event: TimedEventDefinition, key: string): OccurrenceWindow | null
// '' -> the definition's own window (index 0). Otherwise parse the ISO key, validate it lands
// exactly on an existing occurrence start, derive the window. null on garbage/misaligned keys.
// Used by the redelivery sweep to rebuild messages for stale per-occurrence claims.
export function occurrenceWindowsInRange(event: TimedEventDefinition, from: Date, to: Date, cap?: number): Array<{ startsAt: Date; endsAt: Date }>
// Occurrence windows intersecting [from, to]. Takes CONCRETE bounds — core stays clock-free;
// the caller defaults nulls (stats route: from ?? event.startsAt, to ?? new Date()).
// cap (default 400): keep the most RECENT `cap` windows in range, dropping the oldest.
// key convention: recurrence 'none' -> key '', single window; index N startsAt = startsAt + N·interval
// (monthly: UTC month stepping with day clamping); every window's endsAt = its startsAt + (event.endsAt - event.startsAt).

// timedEventState / activeMultiplier / activeEventIds: signatures UNCHANGED, now occurrence-aware:
// disabled -> 'draft'; occurrenceWindow null -> 'ended'; now < window.startsAt -> 'scheduled'
// (covers both before-first and between-occurrences); inside -> 'ending_soon' when
// msLeft <= endingSoonMinutes·60_000 else 'live'.

// ports.ts — WebhookDeliveryStore, occurrenceKey inserted after eventId in every signature:
//   claimTransition(projectId, eventId, occurrenceKey: string, transition): Promise<boolean>
//   markDelivered(projectId, eventId, occurrenceKey, transition): Promise<void>
//   findStaleClaims(olderThan, maxAttempts): Promise<Array<{ projectId; eventId; occurrenceKey: string; transition; attempts }>>
//   incrementAttempts(projectId, eventId, occurrenceKey, transition): Promise<void>
//   findExhaustedClaims(minAttempts): Promise<Array<{ projectId; eventId; occurrenceKey: string; transition; attempts }>>
//   (recordDeadLetter / deleteDeadLettersBefore unchanged)
export interface BackfillStore {
  backfillAchievement(scope: Scope, def: AchievementDefinition): Promise<{
    usersEvaluated: number; progressRaised: number; unlocksGranted: number; pointsAwarded: number
  }>
}
```
Tests: occurrenceWindow — non-recurring before/inside/after (window, window, null); daily/weekly containment at exact start (inclusive) and exact end (exclusive → next); between-occurrences returns next; recurrenceEndsAt cutoff (occurrence starting AT the cutoff does not exist; one starting 1ms before does); monthly stepping incl. Jan 31 → Feb 28 clamp and leap-year Feb 29; duration=interval back-to-back (end of N = start of N+1, containment unambiguous by end-exclusivity); key is '' for none, ISO of occurrence start otherwise. transitionOccurrence — nothing-started null; inside = current; between = previous; after final = final. occurrenceFromKey — '' → definition window; valid ISO on-grid → correct index; off-grid ISO / garbage → null; key beyond recurrenceEndsAt → null. occurrenceWindowsInRange — range spanning 3 occurrences → 3 windows; partial overlap at both edges included; cap keeps most recent (5 dailies, cap 3 → the latest 3). timedEventState — occurrence-aware matrix incl. between-occurrences 'scheduled' and ending_soon inside a later occurrence; activeMultiplier active inside occurrence 2 of a recurring event, inactive between occurrences.

**Known break (record, don't patch):** `TimedEventDefinition` widening + `WebhookDeliveryStore` signature changes + new `BackfillStore` break adapter-db, adapter-strapi, apps/api until Tasks 3/5/6-7. Core gates green. Commit: `feat(core): occurrence windows, occurrence-aware state, backfill and per-occurrence webhook ports`

---

### Task 3: adapter-db — migration 0008, per-occurrence claims, PgBackfillStore, stats multi-window

**Files:** Modify `packages/adapter-db/src/schema.ts` (timedEventNotifications), `src/stores.ts` (PgWebhookDeliveryStore, PgStatsStore aggregation, new PgBackfillStore), `src/index.ts`; create migration `packages/adapter-db/migrations/0008_*` (drizzle-kit generate); tests `packages/adapter-db/test/backfill.test.ts` + extend `test/webhooks.test.ts` (or wherever delivery-store claims are covered) + extend the stats test file.

**Schema:** `timedEventNotifications` gains `occurrenceKey: text('occurrence_key').notNull().default('')`; unique index `event_notif_uq` widens to `.on(t.projectId, t.eventId, t.occurrenceKey, t.transition)`. Migration is additive (column with default + index swap) — no data backfill; existing rows keep `''`.

**Behavior:**
- `PgWebhookDeliveryStore`: all five widened methods thread `occurrenceKey` through values/where clauses exactly as `transition` is threaded today; `findStaleClaims`/`findExhaustedClaims` select and return it.
- `PgStatsStore.getStats`: the `timedEventWindows` param may now contain MULTIPLE windows per `eventId`. Participants per event = COUNT(DISTINCT user_id) over events falling in ANY of that event's windows (union the window predicates per eventId with OR before counting) — a user active in two occurrences counts once.
- `PgBackfillStore implements BackfillStore` — one `db.transaction`: (1) `pg_advisory_xact_lock(hashtext(${projectId + ':' + environment}), hashtext(${'backfill:' + def.id}))`; (2) aggregate `SELECT user_id, COUNT(*)::int AS cnt FROM runtime.events WHERE scope AND type = ${def.eventType} GROUP BY user_id`; `usersEvaluated` = row count; empty → all-zero summary, no writes; (3) batch-SELECT existing progress rows for those users + achievement; compute per user `desired = LEAST(cnt, def.targetCount)`; for users where `desired > (existing ?? 0)`: upsert progress `INSERT ... ON CONFLICT DO UPDATE SET current = GREATEST(current, LEAST(${cnt}, ${target})), updated_at = now()` (the GREATEST in SQL keeps a concurrent live ingest race safe even though we pre-filtered in JS); `progressRaised` = number of such users; (4) for users with `cnt >= def.targetCount`: `unlockedAt = new Date()` computed once, insert unlock `onConflictDoNothing().returning(...)`; per returned row `unlocksGranted++` and, when `def.pointsValue > 0`, insert ledger row (`delta: def.pointsValue, source: 'unlock', sourceRef: def.id`) and `pointsAwarded += def.pointsValue`; (5) return the summary.

Tests (Testcontainers): **true retroactivity** — insert events via PgIngestionStore for a type with NO matching increment (empty increments array — the definition "doesn't exist yet"), then backfill a definition for that type → progress raised, unlocks granted, bonuses in the ledger, wallet SUM reflects them; **idempotent re-run** → all-zero deltas, ledger unchanged; **GREATEST never lowers** — pre-existing progress 8 (live multiplier inflated) + only 3 stored events, target 10 → progress stays 8, `progressRaised` 0; **bonus gating** — user already unlocked live → backfill grants nothing, no second bonus; **live-ingest race** — concurrent `backfillAchievement` + `ingestEvent` whose increment crosses the same user's target → exactly one unlock row, exactly one bonus ledger row; **zero-event type** → all-zero summary; **cross-tenant isolation**; pointsValue 0 → unlocks granted, `pointsAwarded` 0, no ledger rows. Delivery store: same (project, event, transition) claimable under two different occurrenceKeys; `''` and ISO-key claims coexist; markDelivered/incrementAttempts hit only their key's row; stale/exhausted rows return their key. Stats: one eventId with two windows, a user active in both → participants 1; users in different windows both counted; single-window events unaffected. Workspace still red (adapter-strapi, api) — known break continues. Commit: `feat(adapter-db): per-occurrence webhook claims, retroactive backfill store, multi-window stats (migration 0008)`

---

### Task 4: cms — recurrence fields, timed-event lifecycles, scan-feed fix, seed

**Files:** Modify `apps/cms/src/api/timed-event/content-types/timed-event/schema.json`, create `apps/cms/src/api/timed-event/content-types/timed-event/lifecycles.ts`; modify config-plane controller `apps/cms/src/api/config-plane/controllers/config-plane.ts` (timedEvents + timedEventsAll mappers and the timedEventsAll scan filter), seed in `apps/cms/src/index.ts`; regenerate `contentTypes.d.ts`.

**Schema:** REPLACE the reserved `"recurrence": { "type": "json" }` with `"recurrence": { "type": "enumeration", "enum": ["none", "daily", "weekly", "monthly"], "default": "none", "required": true }` (the json field was reserved-and-unused since Sprint 3 — no data migration; any pre-existing NULL maps to `'none'` in the controller). ADD `"recurrenceEndsAt": { "type": "datetime" }`.

**Lifecycles (beforeCreate/beforeUpdate, merged-record pattern from the reward lifecycles INCLUDING the populated-relation lesson — though no relation is needed here, only scalars):** when `recurrence !== 'none'`: `endsAt - startsAt` ≤ interval length (daily 86_400_000, weekly 604_800_000, monthly 28 · 86_400_000) — reject with a message naming the limit; `recurrenceEndsAt`, when set, must be > `startsAt`. `endsAt > startsAt` (add if not already enforced).

**Controller:** both `timedEvents` and `timedEventsAll` mappers gain `recurrence: r.recurrence ?? 'none'`, `recurrenceEndsAt: r.recurrenceEndsAt ?? null`. **Scan-feed fix (spec seam, load-bearing):** `timedEventsAll`'s `endedWithinMinutes` filter currently drops events whose `endsAt` predates the cutoff — a months-old weekly event's occurrence-0 `endsAt` is ancient, so the scheduler would never see it. Widen the filter: keep rows where (existing endsAt-within-cutoff condition) OR (`recurrence != 'none'` AND (`recurrenceEndsAt` IS NULL OR `recurrenceEndsAt` >= cutoff)).

**Seed:** add a second demo timed event `Weekly Happy Hour` — `recurrence: 'weekly'`, a 2-hour window (startsAt = seed-time date at a fixed UTC hour, endsAt = +2h), `multiplier: 2`, `endingSoonMinutes: 30`, `recurrenceEndsAt: null`, enabled. Existing one-shot demo event untouched.

Verification: live curl — timed-events config-plane responses carry both fields (defaulted for the pre-existing event); timedEventsAll includes an old-but-recurring event when `endedWithinMinutes` is small (create one dated last month via the bootstrap-script method from Task 4 of Sprint 8, documented in .superpowers/sdd/task-4-report.md); lifecycle rejections (26h daily, recurrenceEndsAt ≤ startsAt) and acceptance (2h weekly); fresh-DB seed carries the recurring event; second-boot idempotence; typecheck green. Commit: `feat(cms): timed-event recurrence fields, validation, recurring-aware scan feed, seed`

---

### Task 5: adapter-strapi — recurrence field parsing

**Files:** Modify `packages/adapter-strapi/src/schemas.ts` (timedEventFieldsSchema), `src/index.ts` (both timed-event mappers); test `packages/adapter-strapi/test/adapter.test.ts`.

**Behavior:** `timedEventFieldsSchema` gains `recurrence: z.enum(['none','daily','weekly','monthly']).default('none')` and `recurrenceEndsAt: z.string().nullable().default(null)`; `getTimedEvents` and `getAllTimedEvents` mappers gain `recurrence: e.recurrence, recurrenceEndsAt: e.recurrenceEndsAt ? new Date(e.recurrenceEndsAt) : null` — this makes the package's `TimedEventDefinition` construction complete again (package goes green). Tests: recurring event parsed with Date-typed recurrenceEndsAt; response WITHOUT the fields (old cms) parses to `'none'`/`null` (the defaults — back-compat assertion); bad recurrence value → schema throws → stale-on-error path. apps/api still red until Tasks 6–7 — recorded. Commit: `feat(adapter-strapi): timed-event recurrence parsing`

---

### Task 6: api — occurrence-aware scheduler, live feed, stats windows

**Files:** Modify `apps/api/src/webhooks.ts` (scheduler tick, message builder, reachedTransitions), `src/routes/live-events.ts`, `src/routes/stats.ts`, `apps/api/test/fakes.ts` (delivery-store fake signatures + timed-event fixtures gain the new fields); tests extend `apps/api/test/webhooks.test.ts` (or the scheduler's test home), `test/live-events.test.ts`, `test/stats.test.ts` equivalents.

**webhooks.ts:**
- Tick phase 1 becomes occurrence-centric: for each event, `const occ = transitionOccurrence(event, now); if (!occ) continue;` then compute reached transitions AGAINST the occurrence window — replace `reachedTransitions(timedEventState(event, now))` with a local `reachedTransitionsFor(occ, now, event.endingSoonMinutes)`: `now >= occ.endsAt` → `['live','ending_soon','ended']`; `occ.endsAt - now <= endingSoonMinutes·60_000` → `['live','ending_soon']`; `now >= occ.startsAt` → `['live']`; else `[]`. Skip when `!event.enabled` (preserve the current draft-fires-nothing behavior — `timedEventState` returned 'draft' before; keep an explicit enabled check now). Claims/markDelivered calls pass `occ.key`.
- `buildTransitionMessage(event, occ, transition, now)`: `data.startsAt`/`data.endsAt` remain the definition's; when `event.recurrence !== 'none'` add `data.occurrence: { startsAt: occ.startsAt.toISOString(), endsAt: occ.endsAt.toISOString() }`.
- Redelivery sweep: stale claims carry `occurrenceKey`; rebuild via `occurrenceFromKey(event, claim.occurrenceKey)` — null (misaligned key / definition changed) → dead-letter `<unresolvable>` + markDelivered, the existing pattern; pass the key through incrementAttempts/markDelivered/claims.
- `WebhookDispatcher.deliverTransition` gains the `occurrenceKey` param, threaded to `markDelivered`.

**live-events.ts:** compute `const w = occurrenceWindow(e, now)`; skip when null; `state` from `timedEventState(e, now)` (unchanged filter — scheduled/live/ending_soon); report `startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString()`, seconds fields computed from `w`; additive `recurrence: e.recurrence` and `nextOccurrenceStartsAt: occurrenceWindow(e, w.endsAt)?.startsAt.toISOString() ?? null` — evaluating at `w.endsAt` yields the next occurrence because containment is end-exclusive; guard the self-return case for non-recurring (occurrenceWindow at endsAt returns null for 'none').

**stats.ts:** `const now = new Date(); const windows = timedEventDefs.flatMap((e) => occurrenceWindowsInRange(e, from ?? e.startsAt, to ?? now).map((w) => ({ eventId: e.id, startsAt: w.startsAt, endsAt: w.endsAt })))` — the 400-cap is inside the core function; note the clamp in the OpenAPI stats description (one sentence).

Tests: scheduler with fake clocks — occurrence 1 runs (live/ending_soon/ended claimed under key K1), advance past occurrence 2 start → fresh live claim under K2 while K1 rows remain delivered; non-recurring event still claims under `''` (back-compat assertion on the fake's recorded keys); disabled recurring event fires nothing; redelivery rebuild for an ISO-keyed stale claim produces a message with the right `occurrence` payload; unresolvable key dead-letters. Live feed — recurring event between occurrences reports next window + scheduled + correct nextOccurrenceStartsAt; inside a window reports live + the occurrence's bounds; non-recurring unchanged shape with `recurrence: 'none'`, `nextOccurrenceStartsAt: null`. Stats — recurring event with two occurrences in range yields two windows for one eventId (assert the fake/store receives them). apps/api still red on the missing backfill wiring? NO — Task 6 leaves AppDeps untouched; api package goes green only after Task 7 adds BackfillStore wiring IF Task 7 introduces it. To keep Task 6 independently green: Task 6 does NOT reference BackfillStore anywhere; api compiles once delivery-store signatures align (this task). Record: api package green at end of Task 6. Commit: `feat(api): per-occurrence scheduler and webhooks, occurrence-aware live feed and stats windows`

---

### Task 7: api — backfill endpoint

**Files:** Create `apps/api/src/routes/achievements.ts`; modify `src/app.ts` (AppDeps gains `backfillStore: BackfillStore`; mount `app.route('/v1/achievements', achievementsRoute(deps))`), `src/index.ts` (wire `PgBackfillStore`), `src/openapi.ts` (one path; count 15 → 16; note the stats occurrence-windows clamp sentence here if Task 6 didn't add it), `test/fakes.ts` (fake backfill store with settable summary + recorded calls); tests `apps/api/test/backfill.test.ts`.

**Route:** `POST /:id/backfill` — sk guard first (`auth.keyType !== 'secret'` → 403 forbidden, coupons.ts precedent); no body parsing; `const defs = await deps.configStore.getAchievements(scope.projectId)`; unknown id → 404 not_found; `const summary = await deps.backfillStore.backfillAchievement(scope, def)`; respond `summary satisfies BackfillResponse` (200). Config-plane failure → app-level onError 500 (fail closed, never backfill against unknown config — established posture).

Tests: 403 on pk; 404 unknown id; happy path passes the resolved def to the store (capture args) and maps the summary verbatim; openapi asserts sixteen paths + the backfill entry documents 403/404. Workspace typecheck fully green again after this task. Commit: `feat(api): retroactive achievement backfill endpoint`

---

### Task 8: sdk — backfill method + live-events widening

**Files:** Modify `packages/sdk/src/index.ts`; test `packages/sdk/test/sdk.test.ts`.

**Interfaces — produces:**
```ts
async backfillAchievement(achievementId: string): Promise<BackfillResponse>
// requires the secretKey option (redeemCoupon posture + coined message template:
// 'backfillAchievement requires the secretKey option (server-side only).');
// POST /v1/achievements/:id/backfill (encodeURIComponent on the id), useSecretKey: true,
// no body; parse backfillResponseSchema.
// getLiveEvents(): no signature change — liveEventsResponseSchema already carries the
// additive recurrence/nextOccurrenceStartsAt fields with defaults (Task 1).
```
Tests: sk guard throws without secretKey; sends sk bearer + right path with an id needing encoding; parses the summary; getLiveEvents parses a recurring event carrying the new fields AND an old-shape event without them (defaults — one test each). Commit: `feat(sdk): achievement backfill and recurring live-event parsing`

---

### Task 9: demo, e2e, docs — sprint DoD

**Files:** Modify `apps/demo/app/stats/page.tsx` + create `apps/demo/app/stats/backfill-actions.ts` and `apps/demo/app/stats/backfill-form.tsx` (server action + client form, mirroring the coupon-check pair: achievement-id input, submit, render the summary JSON or the error envelope — sk stays server-side); create `apps/demo/e2e/campaign-lifecycle.spec.ts`; docs: root README (recurrence semantics — per-occurrence webhooks, multiplier in every occurrence, UTC-instant drift note, scheduler-downtime edge; backfill operator flow incl. the wallet/leaderboard-moving decision and idempotence), `packages/sdk/README.md` (backfillAchievement + sk posture; live-events new fields), changeset (minor: contracts/sdk; the widened WebhookDeliveryStore is core-internal — patch-note it).

**e2e (`campaign-lifecycle.spec.ts`):** (1) live feed carries the seeded `Weekly Happy Hour` with `recurrence: 'weekly'`, a current-or-next occurrence window, and consistent `nextOccurrenceStartsAt` (assert it equals reported `startsAt` + 7 days when present; the EventCountdown demo section renders it); (2) backfill idempotence: fresh user tracks `lesson_completed` ×1 (unlocks the seeded target-1 achievement live), sk `POST /v1/achievements/:id/backfill` for that achievement → summary shows `unlocksGranted: 0, pointsAwarded: 0` with `usersEvaluated ≥ 1` (already granted live — proves endpoint + idempotence; TRUE retroactivity is covered in adapter-db/api tests where definitions are controllable); (3) the demo backfill form round-trips the same call and renders the summary.

**DoD steps (in order):** `pnpm turbo run typecheck build test` fully green; fresh compose stack (`docker compose --profile stack down -v && build && up -d --wait`); `pnpm --filter demo e2e` — ALL specs green; hand-verification: (a) create a NEW achievement via the admin bootstrap script (Sprint 8 Task 4 method) for an event type the e2e user already has history on, sk-curl its backfill → summary shows real grants, wallet reflects the bonus (record transcript); (b) short recurring event (bootstrap-script created, 2-minute window, daily) — watch the scheduler fire `live`/`ended` for occurrence 0 under its ISO key in the DB (`SELECT * FROM runtime.timed_event_notifications`); stack down; push branch; PR next (CI runs on the PR event; checks read on the PR page — no gh CLI here).

PR notes must state: `WebhookDeliveryStore` signature widening (occurrenceKey — internal port, patch-level for consumers); additive webhook `data.occurrence` field for recurring transitions (HMAC/messageId unchanged); additive live-events `recurrence`/`nextOccurrenceStartsAt`; migration 0008 additive (no data backfill, `''` default preserves existing claims); backfill moves wallets/leaderboards by design (bonus points for retroactive unlocks); the cms `recurrence` json→enumeration swap (reserved-unused since Sprint 3, no data risk); delivers the final two campaign-engine v1.x slices. Commit: `feat(demo): backfill operator form and recurring-event demo; docs — sprint 9 wrap`

---

## Self-Review Notes

- **Spec coverage:** §3.1 occurrence math ✓ (T2 exhaustive, T1 contracts enum); §3.2 per-occurrence webhooks ✓ (T3 migration/store, T6 scheduler/payload/redelivery incl. `occurrenceFromKey` rebuild path); §3.3 stats ✓ (T2 windowsInRange + cap, T3 distinct-across-windows aggregation, T6 route enumeration); §3.4 backfill ✓ (T2 port, T3 transaction, T7 route, T8 sdk); §3.5 config/SDK/demo/seed ✓ (T4, T5, T8, T9); §4 flows = T9 e2e + DoD hand-verification; §5 error handling distributed (fail-closed config T7, schema-throw→stale T5, claim pipeline untouched T3/T6); §6 testing mapped 1:1 (true-retroactivity + race in T3, rollover fake-clocks in T6); §7 DoD = T9.
- **Beyond-spec seams the plan adds (flagged for reviewers, both load-bearing):** (1) the `timedEventsAll` scan-feed `endedWithinMinutes` filter must exempt still-recurring events (T4) — without it the scheduler goes blind to any recurring event older than the scan window, and no spec section said so explicitly; (2) `transitionOccurrence` (current-or-last-started) is distinct from `occurrenceWindow` (current-or-next) — the spec's "scheduler asks for the current state" phrasing hides that `ended` transitions fire BETWEEN occurrences, when the display view already points at the next window.
- **Deviation from spec text:** the cms schema already had a reserved `"recurrence": { "type": "json" }` (Sprint 3); the spec said "gains recurrence" — the plan REPLACES the json field with the enumeration (reserved-unused, no data migration). Flagged in T4 and the PR notes.
- **Known-break chain:** T2 widens TimedEventDefinition + WebhookDeliveryStore + adds BackfillStore → adapter-db green at T3, adapter-strapi at T5, api at T6 (delivery signatures) with backfill wiring landing at T7 (T6 deliberately avoids any BackfillStore reference so the api package is green at T6's gate) — recorded.
- **Type consistency:** `OccurrenceWindow { index, startsAt, endsAt, key }` identical T2/T6; occurrenceKey param position (after eventId) identical T2 (port), T3 (impl), T6 (call sites incl. deliverTransition); `Recurrence` values identical T1 (contracts enum) / T2 (core type) / T4 (cms enum) / T5 (adapter schema); `BackfillResponse` field names identical T1/T2 (store return) /T3/T7/T8/T9 (`usersEvaluated, progressRaised, unlocksGranted, pointsAwarded`); `nextOccurrenceStartsAt` null-when-none semantics identical T1/T6/T8/T9.
- **Deliberate choices encoded:** `data.startsAt`/`endsAt` in webhook payloads stay definition-level (wire-stable) with the occurrence window additive; `occurrenceWindow(e, w.endsAt)` as the next-occurrence trick (end-exclusive containment makes it exact); backfill pre-filters raise-candidates in JS but keeps GREATEST in the SQL upsert (belt for the live-ingest race the advisory lock does not cover — ingestion never takes the backfill lock); e2e asserts idempotent-zero backfill while true retroactivity lives in Testcontainers (clock/definition control), with a mandated live hand-verified real backfill in the DoD.
- **Compression note:** as with Sprints 2–8, test code specified behaviorally; production interfaces, lock keys, intervals, cap values, and validation bounds are exact.
