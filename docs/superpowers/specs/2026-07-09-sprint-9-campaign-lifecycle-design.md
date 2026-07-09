# Sprint 9 Design: Campaign Lifecycle — Retroactive Granting & Recurring Timed Events

Approved via brainstorming session 2026-07-09. Rounds out the campaign engine with
the two remaining time-shaped v1.x features: definitions can now reach *backward*
(retroactive achievement granting replays the stored event log) and *forward*
(timed events recur on a schedule). Both live in the same evaluation/scheduler
internals, so one sprint amortizes the context.

Roadmap lineage: "Retroactive achievement granting (evaluate new definitions
against stored events)" and "Recurring timed events (recurrence rule on the
reserved field)" (v1.x, design doc §7).

## 1. Scope

In scope:

- `recurrence: 'none' | 'daily' | 'weekly' | 'monthly'` + `recurrenceEndsAt` on
  timed events (contracts, core, cms, adapter-strapi)
- Pure occurrence-window math in core; occurrence-aware `timedEventState`,
  `activeMultiplier`, `activeEventIds`
- Per-occurrence webhook transitions: `occurrence_key` on
  `timed_event_notifications` (migration 0008), widened claim unique index,
  additive `occurrence: { startsAt, endsAt }` webhook payload field
- Stats participation windows enumerated per occurrence within the query range
- `POST /v1/achievements/:id/backfill` (sk-only): transactional, idempotent
  retroactive granting with summary response
- SDK `backfillAchievement(id)`; additive live-events fields (`recurrence`,
  `nextOccurrenceStartsAt`); demo backfill button; seed's second (weekly
  recurring) demo event; OpenAPI/READMEs/changeset

Out of scope (explicitly): RRULE/cron recurrence, per-occurrence overrides
(skip/reschedule one occurrence), dry-run backfill, per-user backfill webhooks,
materialized occurrence storage, backlog issues #5/#15/#18/#20/#21, remaining
v1.x items (config-as-code CLI, React Native SDK).

## 2. Decisions and rationale

| Decision | Choice |
|---|---|
| Theme | Campaign lifecycle — both features touch the evaluation/scheduler internals |
| Backfill trigger | Explicit sk endpoint — operator-initiated, auditable, config plane stays read-only (no auto-detection, no CMS write-path into the runtime) |
| Backfill awards | Progress + unlocks + unlock `pointsValue` bonuses; NO per-user webhooks (summary response instead). Two users with identical histories get identical wallets regardless of when the definition shipped |
| Recurrence model | Simple interval enum, occurrence keeps the original duration, optional `recurrenceEndsAt` — zero new dependencies; RRULE would force materialization |
| Recurrence architecture | Virtual occurrences: pure arithmetic in core, no new tables, no materializer job. Any instant maps to at most one occurrence deterministically |
| Occurrence discriminator | `occurrenceKey` = the occurrence's `startsAt` ISO string; `''` for non-recurring events and all pre-existing rows (zero behavior change) |
| Sprint purity | Pure lifecycle sprint (~9 tasks); the 5-issue backlog waits for a Sprint-6-style hardening sprint |

## 3. Architecture

### 3.1 Occurrence math (core, pure)

`TimedEventDefinition` gains `recurrence` (default `'none'`) and
`recurrenceEndsAt: Date | null` (null = forever). `startsAt`/`endsAt` define
occurrence 0's window; every occurrence keeps that duration.

New pure function:

```
occurrenceWindow(event, now): { index, startsAt, endsAt, key } | null
```

Returns the occurrence whose window contains `now`, else the next upcoming
occurrence, else null (past `recurrenceEndsAt`, or a non-recurring event that
ended). `key` is the occurrence `startsAt` ISO string (`''` when
`recurrence === 'none'`). Daily/weekly are fixed-millisecond arithmetic
(86_400_000 / 604_800_000 ms); monthly is UTC calendar-month arithmetic with
day-of-month clamping (Jan 31 + 1mo → Feb 28/29 — the Sprint 7 streak-math
precedent; no tz libraries). An occurrence whose `startsAt` is not strictly
before `recurrenceEndsAt` does not exist.

Precondition (documented on the function, enforced in cms validation §3.4):
occurrence duration ≤ interval, so windows never self-overlap.

`timedEventState(event, now)` becomes occurrence-aware: `draft` when disabled;
`live`/`ending_soon` inside the current occurrence window (ending-soon measured
against the occurrence's `endsAt`); `scheduled` before the first occurrence AND
between occurrences; `ended` when `occurrenceWindow` returns null.
`activeMultiplier`/`activeEventIds` delegate unchanged in signature — multipliers
apply during every occurrence automatically.

### 3.2 Per-occurrence webhooks (migration 0008)

`timed_event_notifications` gains `occurrence_key text NOT NULL DEFAULT ''`; the
unique index widens to `(project_id, event_id, occurrence_key, transition)`.
Pre-existing rows and non-recurring events keep `''` — no data backfill, no
behavior change. Each occurrence of a recurring event gets fresh claims under its
key, so `live`/`ending_soon`/`ended` fire per occurrence through the existing
claim → deliver → redeliver → dead-letter pipeline, which is otherwise untouched.

`WebhookDeliveryStore` signatures (`claimTransition`, `markDelivered`,
`findStaleClaims`, `incrementAttempts`, `findExhaustedClaims`) gain
`occurrenceKey` (known-break chain, resolved within the sprint). Webhook payloads
for recurring events gain an additive `occurrence: { startsAt, endsAt }` field;
`messageId`/HMAC contract unchanged.

Scheduler scan structure is unchanged: each tick asks core for the current state;
a new occurrence beginning produces transitions under a new claim key. Accepted
edge (documented, same at-least-once posture as today): if the scheduler is down
across an entire occurrence and past the scan grace, that occurrence's
transitions are dropped.

### 3.3 Stats

`GET /v1/stats` participation windows for a recurring event enumerate the
occurrence windows intersecting the from/to range (pure math in the route),
aggregated under the one event id. Guard: at most 400 windows enumerated per
event (a year of dailies); beyond that the enumeration clamps to the most recent
400 within range, with the clamp documented in the OpenAPI description.

### 3.4 Retroactive backfill

**Endpoint:** `POST /v1/achievements/:id/backfill` — sk-only (`keyType !==
'secret'` → 403), no request body; unknown achievement id in config → 404
`not_found`. Synchronous in-request at MVP scale; the queue seam is documented
(same posture as live evaluation).

**Operation** (`BackfillStore.backfillAchievement(scope, def)` in adapter-db, one
transaction):

1. `pg_advisory_xact_lock(hashtext('{projectId}:{environment}'),
   hashtext('backfill:' + achievementId))` — serializes concurrent backfills of
   the same achievement (Sprint 8 lock idiom).
2. One aggregate: `SELECT user_id, COUNT(*) FROM events WHERE scope AND type =
   def.eventType GROUP BY user_id`.
3. Per user: progress upserts to `GREATEST(current, LEAST(count, target))` —
   backfill only ever raises progress (live progress may exceed the raw count
   because multipliers applied at ingest); unlock inserted
   `onConflictDoNothing` when `count >= target`; the `pointsValue` bonus ledger
   row (`source: 'unlock'`, `sourceRef: achievementId` — identical to the live
   path) is written ONLY when the unlock insert returned a row.
4. Backfilled `unlockedAt = now()` — the grant happens now, the qualification is
   historical; backdating would corrupt time-ranged unlock stats.

**Idempotence and races:** re-running is a no-op by construction (GREATEST +
unique unlock index + returning-gated bonus). A live ingest racing the backfill
resolves through the same unique indexes — whichever inserts the unlock awards
the bonus, the other awards nothing.

**Response:** `{ usersEvaluated, progressRaised, unlocksGranted, pointsAwarded }`
— summary only; `pointsAwarded` is the TOTAL points credited (sum of bonus
deltas), the other three are row counts; no per-user payload; no webhooks
(decided §2).

### 3.5 Config plane, SDK, demo

- **cms:** timed-event schema gains `recurrence` (enumeration, default `none`,
  required) and `recurrenceEndsAt` (datetime, nullable). Lifecycle validation:
  when recurring, `endsAt - startsAt` ≤ interval length (monthly validates
  against 28 days, the shortest month); `recurrenceEndsAt > startsAt` when set.
  Config-plane timed-event responses carry both fields.
- **adapter-strapi:** timed-event schemas gain the two fields with defaults
  (`recurrence` defaults `'none'`, `recurrenceEndsAt` nullable-defaulted) so
  pre-existing definitions parse unchanged.
- **Live events** (`GET /v1/events/live`): for recurring events the existing
  `startsAt`/`endsAt` fields report the CURRENT (or next) occurrence's window —
  existing `EventCountdown` widgets work with zero changes. Additive fields:
  `recurrence` and `nextOccurrenceStartsAt` (ISO or null) — the start of the
  occurrence AFTER the one reported in `startsAt`/`endsAt`, null when no further
  occurrence exists.
- **SDK:** `backfillAchievement(achievementId)` — secretKey posture
  (redeemCoupon precedent). `getLiveEvents` parses the widened (additive) shape.
  No widget changes.
- **Demo:** stats page gains a backfill form (achievement id input + button,
  server action, renders the summary JSON) next to the coupon check form.
- **Seed:** adds a second, weekly-recurring demo timed event alongside the
  existing one-shot event.

## 4. Data flow

Recurrence: marketer sets `recurrence: 'weekly'` in Strapi → TTL cache → core
computes the active window per request/tick → multiplier applies inside every
occurrence → scheduler fires per-occurrence webhooks under fresh claim keys →
live feed reports the current occurrence window → countdown widgets just work.

Backfill: operator ships a new achievement in Strapi → calls
`POST /v1/achievements/:id/backfill` with the sk → one SQL aggregate over the
event log → transactional grants (progress raised, unlocks inserted, bonuses
gated on the insert) → summary response → wallets/leaderboards reflect the
retroactive bonuses immediately.

## 5. Error handling

- Backfill: 403 on pk; 404 unknown achievement id; config-plane failure →
  fail-closed (established config-unavailable path, never backfill against
  unknown config). Response is the summary or the error envelope — no partial
  writes (single transaction).
- Recurrence: malformed/unknown `recurrence` value from the CMS fails the
  adapter-strapi schema → stale-on-error (issue-#4 posture). `occurrenceWindow`
  never throws on valid definitions; the duration≤interval precondition is
  enforced at config write time.
- Scheduler: per-occurrence claims inherit all existing failure semantics
  (redelivery sweep, exhausted-claim dead-lettering, TTL cleanup).

## 6. Testing

- **core:** exhaustive occurrence-math suite — window containment at boundary
  instants (start inclusive, end exclusive matching existing state semantics),
  between-occurrence `scheduled`, `recurrenceEndsAt` cutoff (occurrence at the
  cutoff does not exist), monthly day-clamping incl. leap Feb, duration=interval
  edge (back-to-back windows never overlap), `''` key for non-recurring,
  occurrence-aware state/multiplier delegation.
- **adapter-db (Testcontainers):** backfill — true retroactivity (events stored
  BEFORE the definition exists → grants); idempotent re-run (zero deltas);
  GREATEST never lowers live progress; bonus awarded exactly once and only with
  the unlock insert; live-ingest race (concurrent backfill + ingest → one bonus);
  cross-tenant isolation. Webhook claims: same (event, transition) claimable
  under two occurrence keys; `''` back-compat.
- **api:** scheduler occurrence rollover with fake clocks (occurrence N ended +
  occurrence N+1 live under fresh keys); backfill route guards (403/404) and
  summary mapping; live-events recurring shape; stats occurrence-window
  enumeration incl. the 400-window clamp.
- **adapter-strapi:** recurrence fields parsed/defaulted; pre-existing
  definitions (no recurrence field) still parse.
- **sdk:** backfillAchievement sk guard + path + parse; live-events additive
  parse.
- **e2e (compose):** recurring event appears in the live feed with `recurrence`
  + current-occurrence window and the countdown renders; backfill endpoint on an
  already-granted achievement returns an idempotent zero-grant summary. (True
  retroactivity is proven at the adapter/api layer where clocks and definitions
  are controllable; the DoD adds a hand-verified live backfill of a definition
  created mid-flight via the admin bootstrap script.)

## 7. Definition of done

- Full turbo suite green; compose e2e green from a fresh seed
- Hand-verified live: backfill of an achievement created mid-flight grants
  retroactively (bootstrap-script-created definition, sk curl, summary + wallet
  checked); recurring demo event's live feed window advances across an
  occurrence boundary (short test occurrence)
- OpenAPI covers the backfill endpoint and the widened live-events shape; README
  documents recurrence semantics (per-occurrence webhooks, multiplier-in-every-
  occurrence, scheduler-downtime edge) and the backfill operator flow incl. the
  points-award decision; changeset per house style
- PR notes call out: `WebhookDeliveryStore` signature widening (occurrenceKey),
  additive webhook `occurrence` payload field, additive live-events fields,
  migration 0008 (additive, no data backfill), backfill's
  leaderboard/wallet-moving semantics
