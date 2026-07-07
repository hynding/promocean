# Promocean Sprint 3: Timed Events + Lifecycle Webhooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the TimedEvent primitive end-to-end: a "Double Progress Weekend" defined in Strapi doubles achievement progress while live, offers can attach to event windows, the demo shows a live countdown, and lifecycle transitions + achievement unlocks fire signed webhooks with retry and dead-lettering.

**Architecture:** State is computed on read from `startsAt`/`endsAt` — no cron for correctness (spec §4.2). A lightweight in-process scheduler exists solely to fire lifecycle webhooks, deduplicating transitions through a claim table. Definitions (timed events, webhook endpoints) live in Strapi behind new config-plane endpoints; the webhook dispatcher and scheduler live in `apps/api`.

**Tech Stack:** unchanged (Node 22, pnpm/Turborepo, Zod 4, Hono 4, Drizzle, Strapi 5, Next 15, Vitest 3, Playwright).

**Spec:** `docs/superpowers/specs/2026-07-06-promocean-design.md` §4.1 (TimedEvent), §4.2 (lifecycle), §4.3 (unlock webhooks), §5 (signed webhooks, dead-letter). Recurrence and per-user timezone windows remain deferred (schema reserves `recurrence`).

## Global Constraints

(All prior global constraints bind: licensing, strict TS/ESM, tenancy, error envelope, conventional commits, tsconfig outDir pattern, lockfile committed, append-only metrics.)

Sprint-3 additions:
- Lifecycle: `draft → scheduled → live → ending_soon → ended`. `draft` = `enabled: false`. `scheduled` = `now < startsAt`. `ended` = `now >= endsAt`. `ending_soon` = live AND `endsAt - now <= endingSoonMinutes` (default 1440 = 24h). `live` otherwise when `startsAt <= now < endsAt`. All instants UTC.
- Multiplier applies while state is `live` OR `ending_soon`. Multiple concurrent events: the **max** multiplier wins (never multiply together); floor 1.
- An offer with `timedEventId` set is resolvable only while that event is live/ending_soon.
- Webhooks: body is the JSON message; header `X-Promocean-Signature` = hex HMAC-SHA256 of the raw body using the endpoint's secret. 3 retries with 250ms-base exponential backoff; exhaustion → dead-letter row. Disabled endpoints skipped. Webhook failures never affect API responses.
- Lifecycle transitions (`live`, `ending_soon`, `ended`) fire **exactly once per (project, event, transition)** — enforced by a unique-claim insert, not by scheduler memory.
- Webhook message types: `timed_event.live`, `timed_event.ending_soon`, `timed_event.ended`, `achievement.unlocked`.
- Known cross-task break (same pattern as Sprint 2): Task 2 widens `ConfigStore` and `OfferDefinition`, leaving adapter-strapi/apps/api typecheck RED until Tasks 5–6. Record, don't patch early.
- Seed timing: the seeded event must be live at seed time (`startsAt = now − 1h`, `endsAt = now + 7d`) — the ONLY permitted use of wall-clock in seed code.
- The seeded live multiplier changes the existing achievement e2e: one `lesson_completed` click now yields `2/10` on Getting Started. Task 10 explicitly updates that assertion.

---

### Task 1: `@promocean/contracts` — timed-event + webhook schemas

**Files:**
- Create: `packages/contracts/src/timed-events.ts`, `packages/contracts/src/webhooks.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/timed-events.test.ts`

**Interfaces:**
- Produces:
  - `liveTimedEventSchema` / `LiveTimedEvent = { eventId: string; name: string; description: string | null; state: 'scheduled' | 'live' | 'ending_soon'; startsAt: string; endsAt: string; multiplier: number; secondsUntilStart: number | null; secondsUntilEnd: number }`
  - `liveEventsResponseSchema` / `LiveEventsResponse = { events: LiveTimedEvent[] }`
  - `webhookMessageSchema` / `WebhookMessage = { type: 'timed_event.live' | 'timed_event.ending_soon' | 'timed_event.ended' | 'achievement.unlocked'; data: Record<string, unknown>; createdAt: string }`
  - `WEBHOOK_SIGNATURE_HEADER = 'x-promocean-signature'`

- [ ] **Step 1: Write the failing tests**

`packages/contracts/test/timed-events.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { liveEventsResponseSchema, webhookMessageSchema, WEBHOOK_SIGNATURE_HEADER } from '../src/index.js'

const event = {
  eventId: 'e1', name: 'Double Progress Weekend', description: null, state: 'live',
  startsAt: '2026-07-07T00:00:00.000Z', endsAt: '2026-07-14T00:00:00.000Z',
  multiplier: 2, secondsUntilStart: null, secondsUntilEnd: 604800,
}

describe('timed event schemas', () => {
  it('round-trips a live events response', () => {
    expect(liveEventsResponseSchema.parse({ events: [event] })).toEqual({ events: [event] })
  })
  it('rejects draft/ended states on the wire', () => {
    for (const state of ['draft', 'ended', 'nope'])
      expect(liveEventsResponseSchema.safeParse({ events: [{ ...event, state }] }).success).toBe(false)
  })
  it('validates webhook messages and exports the signature header', () => {
    expect(webhookMessageSchema.parse({ type: 'achievement.unlocked', data: { userId: 'u1' }, createdAt: event.startsAt }).type).toBe('achievement.unlocked')
    expect(webhookMessageSchema.safeParse({ type: 'other', data: {}, createdAt: event.startsAt }).success).toBe(false)
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-promocean-signature')
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @promocean/contracts test` — Expected: new file FAILS, existing 10 pass.

- [ ] **Step 3: Implement**

`packages/contracts/src/timed-events.ts`:
```ts
import { z } from 'zod'

export const liveTimedEventSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  state: z.enum(['scheduled', 'live', 'ending_soon']),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  multiplier: z.number().int().min(1),
  secondsUntilStart: z.number().int().nullable(),
  secondsUntilEnd: z.number().int(),
})
export type LiveTimedEvent = z.infer<typeof liveTimedEventSchema>

export const liveEventsResponseSchema = z.object({ events: z.array(liveTimedEventSchema) })
export type LiveEventsResponse = z.infer<typeof liveEventsResponseSchema>
```

`packages/contracts/src/webhooks.ts`:
```ts
import { z } from 'zod'

export const webhookMessageSchema = z.object({
  type: z.enum(['timed_event.live', 'timed_event.ending_soon', 'timed_event.ended', 'achievement.unlocked']),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
})
export type WebhookMessage = z.infer<typeof webhookMessageSchema>

export const WEBHOOK_SIGNATURE_HEADER = 'x-promocean-signature'
```

Append both exports to `src/index.ts`.

- [ ] **Step 4: GREEN + build**

Run: `pnpm --filter @promocean/contracts test && pnpm --filter @promocean/contracts build` — Expected: 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): live timed event and webhook message schemas"
```

---

### Task 2: `@promocean/core` — state machine, multiplier, offer attachment, webhook ports

**Files:**
- Create: `packages/core/src/timed-events.ts`
- Modify: `packages/core/src/types.ts`, `packages/core/src/ports.ts`, `packages/core/src/offers.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/timed-events.test.ts`; modify `packages/core/test/offers.test.ts`

**Interfaces:**
- Produces (exact signatures):

```ts
// types.ts additions
export type TimedEventState = 'draft' | 'scheduled' | 'live' | 'ending_soon' | 'ended'
export type TimedEventTransition = 'live' | 'ending_soon' | 'ended'
export interface TimedEventDefinition {
  id: string; name: string; description: string | null
  startsAt: Date; endsAt: Date; endingSoonMinutes: number
  multiplier: number; enabled: boolean
}
export interface WebhookEndpointDefinition { id: string; url: string; secret: string; enabled: boolean }
// OfferDefinition gains: timedEventId: string | null

// timed-events.ts
export function timedEventState(event: TimedEventDefinition, now: Date): TimedEventState
export function activeMultiplier(events: TimedEventDefinition[], now: Date): number      // max over live/ending_soon, floor 1
export function activeEventIds(events: TimedEventDefinition[], now: Date): Set<string>   // ids of live/ending_soon events

// offers.ts — signature change
export function resolveOffer(placementSlug: string, offers: OfferDefinition[], now: Date, activeEvents?: ReadonlySet<string>): OfferDefinition | null
// an offer with timedEventId !== null resolves only when activeEvents?.has(timedEventId)

// ports.ts — ConfigStore gains:
getTimedEvents(projectId: string): Promise<TimedEventDefinition[]>
getAllTimedEvents(): Promise<Array<TimedEventDefinition & { projectId: string }>>   // scheduler sweep
getWebhookEndpoints(projectId: string): Promise<WebhookEndpointDefinition[]>
// new port:
export interface WebhookDeliveryStore {
  claimTransition(projectId: string, eventId: string, transition: TimedEventTransition): Promise<boolean>
  recordDeadLetter(projectId: string, url: string, payload: string, error: string, at: Date): Promise<void>
}
```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/timed-events.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { activeEventIds, activeMultiplier, timedEventState, type TimedEventDefinition } from '../src/index.js'

const mk = (over: Partial<TimedEventDefinition>): TimedEventDefinition => ({
  id: 'e1', name: 'E', description: null,
  startsAt: new Date('2026-07-10T00:00:00Z'), endsAt: new Date('2026-07-17T00:00:00Z'),
  endingSoonMinutes: 1440, multiplier: 2, enabled: true, ...over,
})

describe('timedEventState', () => {
  const e = mk({})
  it('walks the full lifecycle', () => {
    expect(timedEventState(mk({ enabled: false }), new Date('2026-07-12T00:00:00Z'))).toBe('draft')
    expect(timedEventState(e, new Date('2026-07-09T00:00:00Z'))).toBe('scheduled')
    expect(timedEventState(e, new Date('2026-07-10T00:00:00Z'))).toBe('live')      // startsAt inclusive
    expect(timedEventState(e, new Date('2026-07-16T00:00:00Z'))).toBe('ending_soon') // exactly 24h left
    expect(timedEventState(e, new Date('2026-07-17T00:00:00Z'))).toBe('ended')     // endsAt exclusive
  })
})

describe('activeMultiplier / activeEventIds', () => {
  const now = new Date('2026-07-12T00:00:00Z')
  it('takes the max across live events, floor 1', () => {
    expect(activeMultiplier([], now)).toBe(1)
    expect(activeMultiplier([mk({ multiplier: 2 }), mk({ id: 'e2', multiplier: 3 })], now)).toBe(3)
    expect(activeMultiplier([mk({ enabled: false, multiplier: 5 })], now)).toBe(1)
    expect(activeMultiplier([mk({ startsAt: new Date('2026-08-01T00:00:00Z'), multiplier: 5 })], now)).toBe(1)
  })
  it('collects live and ending_soon ids only', () => {
    const events = [mk({}), mk({ id: 'e2', endsAt: new Date('2026-07-12T12:00:00Z') }), mk({ id: 'e3', enabled: false })]
    expect(activeEventIds(events, now)).toEqual(new Set(['e1', 'e2']))
  })
})
```

Append to `packages/core/test/offers.test.ts`:
```ts
describe('resolveOffer with event attachment', () => {
  const attached: OfferDefinition = { ...base, id: 'event-offer', placementSlug: 'homepage-banner', startsAt: null, endsAt: null, priority: 99, timedEventId: 'e1' }
  it('resolves attached offers only while their event is active', () => {
    expect(resolveOffer('homepage-banner', [attached], now, new Set(['e1']))?.id).toBe('event-offer')
    expect(resolveOffer('homepage-banner', [attached], now, new Set())).toBeNull()
    expect(resolveOffer('homepage-banner', [attached], now)).toBeNull()
  })
})
```
(Existing offer fixtures in that file gain `timedEventId: null` in `base`.)

- [ ] **Step 2: RED**

Run: `pnpm --filter @promocean/core test` — Expected: FAIL (new exports missing; offers test type errors).

- [ ] **Step 3: Implement**

`packages/core/src/timed-events.ts`:
```ts
import type { TimedEventDefinition, TimedEventState } from './types.js'

export function timedEventState(event: TimedEventDefinition, now: Date): TimedEventState {
  if (!event.enabled) return 'draft'
  if (now < event.startsAt) return 'scheduled'
  if (now >= event.endsAt) return 'ended'
  const msLeft = event.endsAt.getTime() - now.getTime()
  return msLeft <= event.endingSoonMinutes * 60_000 ? 'ending_soon' : 'live'
}

const isActive = (s: TimedEventState) => s === 'live' || s === 'ending_soon'

export function activeMultiplier(events: TimedEventDefinition[], now: Date): number {
  let max = 1
  for (const e of events) if (isActive(timedEventState(e, now)) && e.multiplier > max) max = e.multiplier
  return max
}

export function activeEventIds(events: TimedEventDefinition[], now: Date): Set<string> {
  const ids = new Set<string>()
  for (const e of events) if (isActive(timedEventState(e, now))) ids.add(e.id)
  return ids
}
```

`offers.ts` — add the fourth parameter; inside the loop, before schedule checks:
```ts
if (offer.timedEventId !== null && !activeEvents?.has(offer.timedEventId)) continue
```

Add types/ports exactly per the Interfaces block; `export * from './timed-events.js'` in index.

- [ ] **Step 4: GREEN + record the expected downstream break**

Run: `pnpm --filter @promocean/core test && pnpm --filter @promocean/core build && pnpm turbo run typecheck`
Expected: core green; **typecheck RED in adapter-strapi and apps/api** (missing ConfigStore methods, OfferDefinition.timedEventId). Record failures; do not patch (Tasks 5–6).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): timed event lifecycle, multiplier resolution, offer attachment, webhook ports"
```

---

### Task 3: `@promocean/adapter-db` — webhook delivery store

**Files:**
- Modify: `packages/adapter-db/src/schema.ts`, `packages/adapter-db/src/stores.ts`, `packages/adapter-db/src/index.ts`
- Create (generated): new migration
- Test: `packages/adapter-db/test/webhook-delivery.test.ts`

**Interfaces:**
- Produces: `class PgWebhookDeliveryStore implements WebhookDeliveryStore`; tables `runtime.timed_event_notifications` (unique `(project_id, event_id, transition)`) and `runtime.webhook_dead_letters`.

- [ ] **Step 1: Schema + migration**

Append to `schema.ts`:
```ts
export const timedEventNotifications = runtime.table('timed_event_notifications', {
  projectId: text('project_id').notNull(),
  eventId: text('event_id').notNull(),
  transition: text('transition').notNull(),
  firedAt: timestamp('fired_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('event_notif_uq').on(t.projectId, t.eventId, t.transition)])

export const webhookDeadLetters = runtime.table('webhook_dead_letters', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: text('project_id').notNull(),
  url: text('url').notNull(),
  payload: text('payload').notNull(),
  error: text('error').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})
```
Run `pnpm --filter @promocean/adapter-db db:generate`.

- [ ] **Step 2: RED test**

`test/webhook-delivery.test.ts` (same Testcontainers scaffold as `offer-metrics.test.ts`, pool closed before container stop):
```ts
describe('PgWebhookDeliveryStore', () => {
  it('claims a transition exactly once', async () => {
    const store = new PgWebhookDeliveryStore(db)
    expect(await store.claimTransition('p1', 'e1', 'live')).toBe(true)
    expect(await store.claimTransition('p1', 'e1', 'live')).toBe(false)
    expect(await store.claimTransition('p1', 'e1', 'ended')).toBe(true)
    expect(await store.claimTransition('p2', 'e1', 'live')).toBe(true)
  })
  it('records dead letters', async () => {
    const store = new PgWebhookDeliveryStore(db)
    await store.recordDeadLetter('p1', 'https://x.test/hook', '{"type":"t"}', 'server 500 after 4 attempts', new Date())
    const { rows } = await db.$client.query(`select url, error from runtime.webhook_dead_letters where project_id='p1'`)
    expect(rows).toEqual([{ url: 'https://x.test/hook', error: 'server 500 after 4 attempts' }])
  })
})
```

- [ ] **Step 3: Implement (GREEN)**

Append to `stores.ts`:
```ts
export class PgWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private db: Db) {}
  async claimTransition(projectId: string, eventId: string, transition: TimedEventTransition) {
    const inserted = await this.db.insert(timedEventNotifications)
      .values({ projectId, eventId, transition })
      .onConflictDoNothing()
      .returning({ eventId: timedEventNotifications.eventId })
    return inserted.length > 0
  }
  async recordDeadLetter(projectId: string, url: string, payload: string, error: string, at: Date) {
    await this.db.insert(webhookDeadLetters).values({ projectId, url, payload, error, createdAt: at })
  }
}
```
Export from index. Run `pnpm --filter @promocean/adapter-db test && ... build` — Expected: 7/7.

- [ ] **Step 4: Commit**

```bash
git add packages/adapter-db
git commit -m "feat(adapter-db): webhook transition claims and dead-letter store"
```

---

### Task 4: `apps/cms` — TimedEvent + WebhookEndpoint types, config-plane endpoints, seed

**Files:**
- Create: `apps/cms/src/api/timed-event/content-types/timed-event/schema.json` (+ factory files)
- Create: `apps/cms/src/api/webhook-endpoint/content-types/webhook-endpoint/schema.json` (+ factory files), `.../webhook-endpoint/lifecycles.ts`
- Modify: `apps/cms/src/api/offer/content-types/offer/schema.json` (add `timedEvent` relation), config-plane routes/controller, `apps/cms/src/index.ts` (seed)

**Interfaces:**
- Produces protocol (Task 5 consumes):
  - `GET /api/config-plane/timed-events?projectId=<id>` → `{ events: [{ id, name, description, startsAt, endsAt, endingSoonMinutes, multiplier, enabled }] }` (ISO strings, explicit nulls; 400 without projectId)
  - `GET /api/config-plane/timed-events/all` → same items plus `projectId` (no query param)
  - `GET /api/config-plane/webhook-endpoints?projectId=<id>` → `{ endpoints: [{ id, url, secret, enabled }] }`
  - Offers endpoint mapping gains `timedEventId: r.timedEvent?.documentId ?? null` (populate `timedEvent`)
  - All guarded by `configSecretOk`.
- Content types: `timed-event` — name (req), description (text), startsAt/endsAt (datetime req), endingSoonMinutes (int default 1440 min 1), multiplier (int default 1 min 1), enabled (bool default true), recurrence (json, reserved/unused), project relation. `webhook-endpoint` — url (req), secret (string, configurable false), enabled (bool default true), project relation; beforeCreate lifecycle generates `whsec_<32 hex>` when absent, logs prefix only unless `LOG_PLAINTEXT_KEYS==='true'` (same pattern as api-key lifecycle).
- Seed additions (inside existing gate): timed event **Double Progress Weekend** — description "All achievement progress counts double.", `startsAt = new Date(Date.now() - 3600_000)`, `endsAt = new Date(Date.now() + 7 * 24 * 3600_000)`, endingSoonMinutes 1440, multiplier 2, enabled true. (Wall-clock permitted here only.) No seeded webhook endpoint (nothing listens in dev).

- [ ] **Step 1: Content types + lifecycle + relation** — per Interfaces block, mirroring existing patterns (achievement schema, api-key lifecycle).
- [ ] **Step 2: Config-plane routes + handlers** — three new routes; reuse `configSecretOk`; the `/timed-events/all` route must be registered BEFORE `/timed-events` if the router is prefix-greedy (verify; Strapi matches exact paths, but confirm).
- [ ] **Step 3: Offers mapping** — add `populate: ['placement', 'timedEvent']` and `timedEventId` to the offers handler.
- [ ] **Step 4: Seed** — append per Interfaces block.
- [ ] **Step 5: Verify live** — fresh DB (`docker compose down -v && docker compose up -d postgres`), boot cms; curl all three endpoints (+ offers endpoint now carrying `timedEventId: null` for the welcome offer) with/without secret; capture outputs; stop Strapi. `pnpm --filter cms typecheck` green (regenerate types via `npx strapi ts:generate-types` as in Sprint 2).
- [ ] **Step 6: Commit**

```bash
git add apps/cms
git commit -m "feat(cms): timed-event and webhook-endpoint types, config-plane endpoints, live demo event seed"
```

---

### Task 5: `@promocean/adapter-strapi` — timed events, webhook endpoints, offer mapping

**Files:**
- Modify: `packages/adapter-strapi/src/index.ts`
- Test: append to `packages/adapter-strapi/test/adapter.test.ts`

**Interfaces:**
- Produces on `StrapiConfigPlane`: `getTimedEvents(projectId)` (TTL cache + stale-on-error, dates → `Date`, per Interfaces of Task 2), `getAllTimedEvents()` (cache key `'*'`, maps `projectId` through), `getWebhookEndpoints(projectId)` (cached), and the offers mapping gains `timedEventId: (o.timedEventId as string | null) ?? null`.
- Package typecheck green again after this task (apps/api still red until Task 6).

- [ ] **Step 1: RED tests** — four new: timed-events fetch+mapping (ISO→Date, enabled boolean), stale-on-error for timed events, getAllTimedEvents URL + projectId passthrough, webhook-endpoints fetch. Follow the existing offers-test style with `makePlane`.
- [ ] **Step 2: Implement (GREEN)** — mirror `getOffers` structure; three new cache maps. `pnpm --filter @promocean/adapter-strapi test` (12/12) + typecheck + build green.
- [ ] **Step 3: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): timed events, webhook endpoints, and offer event attachment"
```

---

### Task 6: `apps/api` — multiplier wiring, event-gated offers, live events endpoint

**Files:**
- Create: `apps/api/src/routes/live-events.ts`
- Modify: `apps/api/src/routes/events.ts`, `apps/api/src/routes/placements.ts`, `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/test/fakes.ts`
- Test: `apps/api/test/timed-events.test.ts`

**Interfaces:**
- Produces:
  - `POST /v1/events` now computes `const multiplier = activeMultiplier(await deps.configStore.getTimedEvents(scope.projectId), occurredAt)` and passes it to `evaluateEvent(event, definitions, counts, multiplier)`. Config-plane failure on the timed-events fetch must NOT fail ingestion — wrap in try/catch defaulting to 1 (log), since multipliers are an enhancement, not correctness.
  - `GET /v1/placements/:slug/offer` passes `activeEventIds(events, now)` as `resolveOffer`'s fourth arg (same failure tolerance: on error pass `undefined`... no — attached offers must NOT appear if event state is unknown; on fetch failure pass `new Set()` and log).
  - `GET /v1/events/live` → `LiveEventsResponse`: all non-draft, non-ended events mapped with `state`, `secondsUntilStart` (null unless scheduled), `secondsUntilEnd` (ceil((endsAt−now)/1000)).
  - Fakes: `makeFakes` gains `timedEvents: TimedEventDefinition[] = []`; config fake gains `getTimedEvents`/`getAllTimedEvents`/`getWebhookEndpoints` (returning the param / [] / []).
  - Workspace typecheck fully green after this task.

- [ ] **Step 1: RED tests** (`test/timed-events.test.ts`): (a) with a live multiplier-2 event, one `lesson_completed` yields `progress current 2` and unlocks a target-2 achievement; (b) with no events, multiplier 1 behavior unchanged; (c) config-store timed-events failure still ingests at multiplier 1; (d) `/v1/events/live` maps states and countdowns (scheduled event → `secondsUntilStart` number; live → null) and excludes draft/ended; (e) placements: an offer attached to a live event resolves; attached to an inactive event does not. Complete test code written at implementation time following `offers.test.ts` conventions — fixtures per Task 2's `mk` pattern.
- [ ] **Step 2: Implement (GREEN)** — per Interfaces block. `pnpm --filter api test` (14 existing + ~6 new) and `pnpm turbo run typecheck` fully green.
- [ ] **Step 3: Commit**

```bash
git add apps/api
git commit -m "feat(api): timed-event multipliers, event-gated offers, and live events endpoint"
```

---

### Task 7: `apps/api` — webhook dispatcher + lifecycle scheduler + unlock webhooks

**Files:**
- Create: `apps/api/src/webhooks.ts`
- Modify: `apps/api/src/routes/events.ts` (fire unlock webhooks), `apps/api/src/app.ts` (AppDeps gains optional `webhooks?: WebhookDispatcher`), `apps/api/src/index.ts` (construct dispatcher + start scheduler)
- Test: `apps/api/test/webhooks.test.ts`

**Interfaces:**
- Produces in `src/webhooks.ts`:

```ts
export class WebhookDispatcher {
  constructor(opts: {
    configStore: ConfigStore
    deliveryStore: WebhookDeliveryStore
    fetchImpl?: typeof fetch
    maxRetries?: number      // default 3, 250ms-base exponential backoff
  })
  async deliver(projectId: string, message: WebhookMessage): Promise<void>
  // For each enabled endpoint: POST JSON body, header WEBHOOK_SIGNATURE_HEADER = hex hmac-sha256(body, endpoint.secret).
  // Per-endpoint isolation: one endpoint failing never blocks others. Exhausted retries → deliveryStore.recordDeadLetter.
  // NEVER throws.
}

export function startLifecycleScheduler(opts: {
  configStore: ConfigStore; deliveryStore: WebhookDeliveryStore; dispatcher: WebhookDispatcher; intervalMs?: number // default 30_000
}): () => void
// Each tick: getAllTimedEvents(); for each event compute state(now); for each REACHED transition in order
// ('live' if state is live|ending_soon|ended, 'ending_soon' if ending_soon|ended, 'ended' if ended) and enabled events only:
// if claimTransition(...) returns true → dispatcher.deliver(projectId, { type: `timed_event.${transition}`, data: {...event fields ISO...}, createdAt: now }).
// Catch-all inside the tick; returns a stop function clearing the interval.
```

- Unlock webhooks: in the events route, after building `unlocks`, when non-empty and `deps.webhooks` present: `void deps.webhooks.deliver(scope.projectId, { type: 'achievement.unlocked', data: { userId, environment: scope.environment, unlocks }, createdAt: unlockedAt.toISOString() })` — fire-and-forget, never awaited into the response path.
- Backfill semantics are intentional: an event already `ending_soon` when first observed claims+fires `live` then `ending_soon` on the same tick (ordered), so subscribers always see a complete transition history.

- [ ] **Step 1: RED tests** (`test/webhooks.test.ts`, mocked fetch + in-memory fakes):
  (a) deliver posts to both enabled endpoints with correct HMAC (recompute with `createHmac` in the test and compare), skips disabled;
  (b) 5xx then success → retried, single dead-letter-free delivery; persistent failure → `recordDeadLetter` called with the payload and each OTHER endpoint still delivered;
  (c) scheduler tick claims and fires `live` exactly once across two ticks (fake claim store), fires `live`+`ending_soon` in order for an event first seen ending_soon, skips disabled events, and stop() halts ticking (use `vi.useFakeTimers`).
- [ ] **Step 2: Implement (GREEN)** — per Interfaces block; wire in `index.ts` (`new WebhookDispatcher(...)`, `startLifecycleScheduler(...)`; pass dispatcher into `createApp` deps). `pnpm --filter api test` all green; workspace typecheck green.
- [ ] **Step 3: Commit**

```bash
git add apps/api
git commit -m "feat(api): signed webhook dispatcher, lifecycle scheduler, and unlock webhooks"
```

---

### Task 8: `@promocean/sdk` — getLiveEvents

**Files:** Modify `packages/sdk/src/index.ts`; append to `packages/sdk/test/sdk.test.ts`

**Interfaces:**
- Produces: `getLiveEvents(): Promise<LiveTimedEvent[]>` — GET `/v1/events/live`, parsed via `liveEventsResponseSchema`, works without identify.

- [ ] **Step 1: RED test** — mocks fetch, asserts URL and parsed array round-trip (one live event fixture from Task 1's test).
- [ ] **Step 2: Implement (GREEN)** — three-line method using `request()`. 12/12 tests; build clean.
- [ ] **Step 3: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): live timed events query"
```

---

### Task 9: `@promocean/widgets` — EventCountdown

**Files:** Create `packages/widgets/src/event-countdown.tsx`; modify `src/index.ts`; append to `test/widgets.test.tsx`

**Interfaces:**
- Produces: `<EventCountdown />` — fetches `getLiveEvents()` on mount (fail silent-to-empty); renders each scheduled/live/ending_soon event as a row (`data-promocean-event={eventId}`): name, state badge text (`Starts in`/`Ends in`), and a `HHh MMm SSs` countdown ticking every second (single interval for the component, cleared on unmount; recompute from `endsAt`/`startsAt` and wall clock each tick — never decrement a counter). Renders nothing when no events.

- [ ] **Step 1: RED tests** — (a) renders event name + countdown container from a mocked client (fake timers; advance 1s, assert text changes); (b) renders nothing on fetch failure; (c) unmount clears the interval (spy on clearInterval or assert no act warnings after unmount+advance).
- [ ] **Step 2: Implement (GREEN)** — inline styles; derive remaining time from dates each tick. 10/10 widget tests pristine; build clean.
- [ ] **Step 3: Commit**

```bash
git add packages/widgets
git commit -m "feat(widgets): live event countdown component"
```

---

### Task 10: `apps/demo` — countdown integration + timed-events e2e (Sprint 3 DoD)

**Files:**
- Modify: `apps/demo/app/promocean.tsx` (add `<EventCountdown />` between Placement and the buttons), `apps/demo/e2e/achievement-loop.spec.ts` (multiplier-aware assertion)
- Test: `apps/demo/e2e/timed-event-loop.spec.ts`

**Interfaces:**
- Consumes the seeded live "Double Progress Weekend" (multiplier 2). Fresh dev DB required so the new seed ran (`docker compose down -v` flow from Task 4). CI unchanged (fresh DB every run).

- [ ] **Step 1: Integrate** — one import + one JSX line.
- [ ] **Step 2: Update achievement e2e** — `1/10` → `2/10` with a comment: `// seeded "Double Progress Weekend" (multiplier 2) is live — one lesson counts double`.
- [ ] **Step 3: New e2e** (`timed-event-loop.spec.ts`):
```ts
import { expect, test } from '@playwright/test'

test('live event shows countdown and doubles progress', async ({ page }) => {
  const user = `e2e-event-${Date.now()}`
  await page.goto(`/?user=${user}`)
  const event = page.locator('[data-promocean-event]')
  await expect(event.getByText('Double Progress Weekend')).toBeVisible()
  await expect(event.getByText(/Ends in/)).toBeVisible()
  await page.getByRole('button', { name: 'Complete a lesson' }).click()
  await expect(page.getByRole('status')).toContainText('First Lesson')
  await expect(page.getByText('2/10')).toBeVisible()
})
```
- [ ] **Step 4: Run the full e2e suite** (stack running, fresh-seeded DB): `pnpm --filter demo e2e` — Expected: **3 passed**. This green run is the Sprint 3 definition of done.
- [ ] **Step 5: Full workspace green, stop servers, no env files staged, commit**

```bash
git add apps/demo
git commit -m "feat(demo): live event countdown with multiplier e2e"
```

---

## Self-Review Notes

- **Spec coverage:** TimedEvent entity + full lifecycle incl. `ending_soon` ✓ (T2/T4); state computed on read, scheduler only for webhooks ✓ (T2/T7); multiplier effect on achievement progress ✓ (T6); offer attachment to event windows ✓ (T2/T4/T5/T6); `GET /v1/events/live` with server-computed countdown ✓ (T6); signed webhooks (HMAC, `X-Promocean-Signature`), retries, dead-letter table ✓ (T3/T7); unlock webhooks (deferred from Sprint 1) ✓ (T7); webhook endpoints as Strapi content type with secret lifecycle ✓ (T4); reserved `recurrence` field ✓ (T4). Deferred per spec: recurrence semantics, per-user timezone windows, SSE/realtime channel.
- **Cross-task break:** Task 2 → RED workspace typecheck → closed by Tasks 5–6 (same managed pattern as Sprint 2).
- **Known trade-offs encoded:** multiplier fetch failure degrades to 1 (ingestion never blocked); attached offers fail closed when event state is unavailable; scheduler backfills missed transitions in order via the claim table (restart-safe, exactly-once per transition).
- **Type consistency:** `TimedEventDefinition` fields, transition literals, `WEBHOOK_SIGNATURE_HEADER`, `getTimedEvents`/`getAllTimedEvents`/`getWebhookEndpoints`, `claimTransition`/`recordDeadLetter`, `getLiveEvents`, `data-promocean-event` verified consistent across tasks.
- **Placeholder check:** Tasks 5, 6, and 9 specify test intent + exact behavioral assertions rather than full verbatim test code (the fixtures and helper patterns they must follow are named); all production-code interfaces are fully specified. This is a deliberate compression — implementers have the Sprint 1/2 test files as executable style guides.
