import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgStatsStore, type Db } from '../src/index.js'
import type { Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db

const p1: Scope = { projectId: 'p1', environment: 'test' }
const p2: Scope = { projectId: 'p2', environment: 'test' }

const d1 = new Date('2026-01-01T00:00:00.000Z')
const d2 = new Date('2026-01-02T00:00:00.000Z')
const d2h = new Date('2026-01-02T12:00:00.000Z')
const d3 = new Date('2026-01-03T00:00:00.000Z')
const d4 = new Date('2026-01-04T00:00:00.000Z')

const w1 = { eventId: 'w1', startsAt: d1, endsAt: d2 }
const w2 = { eventId: 'w2', startsAt: d3, endsAt: d4 }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)

  const insertEvent = (s: Scope, userId: string, idem: string, occurredAt: Date) =>
    db.$client.query(
      `insert into runtime.events (project_id, environment, user_id, type, idempotency_key, occurred_at) values ($1,$2,$3,$4,$5,$6)`,
      [s.projectId, s.environment, userId, 'lesson_completed', idem, occurredAt],
    )
  const insertUnlock = (s: Scope, userId: string, achievementId: string, unlockedAt: Date) =>
    db.$client.query(
      `insert into runtime.unlocks (project_id, environment, user_id, achievement_id, unlocked_at) values ($1,$2,$3,$4,$5)`,
      [s.projectId, s.environment, userId, achievementId, unlockedAt],
    )
  const insertOfferEvent = (s: Scope, offerId: string, userId: string, kind: 'impression' | 'click', createdAt: Date) =>
    db.$client.query(
      `insert into runtime.offer_events (project_id, environment, offer_id, user_id, kind, created_at) values ($1,$2,$3,$4,$5,$6)`,
      [s.projectId, s.environment, offerId, userId, kind, createdAt],
    )

  // p1/test events: d1..d4 plus one event (d2h, u-outside) that sits between the two
  // timed-event windows but inside the overall date range — proves range membership and
  // window membership are independent checks.
  await insertEvent(p1, 'u1', 'e1', d1)
  await insertEvent(p1, 'u2', 'e2', d2)
  await insertEvent(p1, 'u-outside', 'e-between', d2h)
  await insertEvent(p1, 'u3', 'e3', d3)
  await insertEvent(p1, 'u4', 'e4', d4)

  await insertUnlock(p1, 'u1', 'a1', d1)
  await insertUnlock(p1, 'u2', 'a1', d2)
  await insertUnlock(p1, 'u3', 'a2', d3)
  await insertUnlock(p1, 'u4', 'a2', d4)

  await insertOfferEvent(p1, 'o1', 'u1', 'impression', d1)
  await insertOfferEvent(p1, 'o1', 'u2', 'impression', d2)
  await insertOfferEvent(p1, 'o1', 'u2', 'click', d2)
  await insertOfferEvent(p1, 'o2', 'u4', 'impression', d4)
  await insertOfferEvent(p1, 'o2', 'u1', 'click', d1)

  // p2/test: entirely separate tenant, same dates/ids reused to prove scoping (not just
  // distinct values) keeps tenants apart.
  await insertEvent(p2, 'u5', 'e5', d2)
  await insertUnlock(p2, 'u5', 'a1', d2)
  await insertOfferEvent(p2, 'o1', 'u5', 'impression', d2)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

const sortByKey = <T extends Record<string, unknown>>(rows: T[], key: keyof T) =>
  [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])))

describe('PgStatsStore', () => {
  it('reports all-time totals and per-entity breakdowns scoped to the tenant', async () => {
    const store = new PgStatsStore(db)
    const stats = await store.getStats(p1, { from: null, to: null }, [w1, w2])

    expect(stats.totals.events).toBe(5)
    expect(stats.totals.unlocks).toBe(4)
    expect(stats.totals.impressions).toBe(3)
    expect(stats.totals.clicks).toBe(2)

    expect(sortByKey(stats.achievements, 'achievementId')).toEqual([
      { achievementId: 'a1', unlocks: 2 },
      { achievementId: 'a2', unlocks: 2 },
    ])
    expect(sortByKey(stats.offers, 'offerId')).toEqual([
      { offerId: 'o1', impressions: 2, clicks: 1 },
      { offerId: 'o2', impressions: 1, clicks: 1 },
    ])

    // All-time: window participants = distinct users whose events fall inside that window.
    expect(sortByKey(stats.timedEvents, 'eventId')).toEqual([
      { eventId: 'w1', participants: 2 }, // u1 (d1), u2 (d2)
      { eventId: 'w2', participants: 2 }, // u3 (d3), u4 (d4)
    ])
    // Union of both windows: u1, u2, u3, u4 (u-outside's event at d2h falls in neither window).
    expect(stats.totals.timedEventParticipants).toBe(4)
  })

  it('applies an inclusive date range on both boundaries', async () => {
    const store = new PgStatsStore(db)
    const stats = await store.getStats(p1, { from: d1, to: d3 }, [w1, w2])

    // e4 (d4) excluded; e1/e2/e-between/e3 included — d1 and d3 boundaries themselves count.
    expect(stats.totals.events).toBe(4)
    // u4's unlock at d4 excluded.
    expect(stats.totals.unlocks).toBe(3)
    expect(sortByKey(stats.achievements, 'achievementId')).toEqual([
      { achievementId: 'a1', unlocks: 2 },
      { achievementId: 'a2', unlocks: 1 },
    ])

    // o2's impression at d4 excluded; its click at d1 still included.
    expect(sortByKey(stats.offers, 'offerId')).toEqual([
      { offerId: 'o1', impressions: 2, clicks: 1 },
      { offerId: 'o2', impressions: 0, clicks: 1 },
    ])
    expect(stats.totals.impressions).toBe(2)
    expect(stats.totals.clicks).toBe(2)
  })

  it('intersects timed-event windows with the requested range (window participation, inside vs outside)', async () => {
    const store = new PgStatsStore(db)
    // Range upper bound (d3) squeezes w2's effective window down to exactly d3..d3.
    const stats = await store.getStats(p1, { from: d1, to: d3 }, [w1, w2])

    expect(sortByKey(stats.timedEvents, 'eventId')).toEqual([
      { eventId: 'w1', participants: 2 }, // u1, u2 fully inside [d1, d2]
      { eventId: 'w2', participants: 1 }, // only u3 (d3); u4 (d4) falls outside the range-clamped window
    ])
    // Union of the (range-clamped) windows: u1, u2, u3 — u-outside (d2h) and u4 (d4) excluded.
    expect(stats.totals.timedEventParticipants).toBe(3)
  })

  it('returns zero timed-event participants when no windows are supplied', async () => {
    const store = new PgStatsStore(db)
    const stats = await store.getStats(p1, { from: null, to: null }, [])
    expect(stats.timedEvents).toEqual([])
    expect(stats.totals.timedEventParticipants).toBe(0)
  })

  it('keeps tenants fully isolated', async () => {
    const store = new PgStatsStore(db)
    const stats = await store.getStats(p2, { from: null, to: null }, [])

    expect(stats.totals).toEqual({ events: 1, unlocks: 1, impressions: 1, clicks: 0, timedEventParticipants: 0 })
    expect(stats.achievements).toEqual([{ achievementId: 'a1', unlocks: 1 }])
    expect(stats.offers).toEqual([{ offerId: 'o1', impressions: 1, clicks: 0 }])
  })
})

describe('PgStatsStore multi-window (recurring occurrences)', () => {
  // Isolated tenant so these inserts don't perturb the shared p1/p2 fixtures.
  const p3: Scope = { projectId: 'p3', environment: 'test' }
  // One recurring event 'multi' with two occurrence windows: [d1,d2] and [d3,d4].
  const wa = { eventId: 'multi', startsAt: d1, endsAt: d2 }
  const wb = { eventId: 'multi', startsAt: d3, endsAt: d4 }

  beforeAll(async () => {
    const insertEvent = (userId: string, idem: string, occurredAt: Date) =>
      db.$client.query(
        `insert into runtime.events (project_id, environment, user_id, type, idempotency_key, occurred_at) values ($1,$2,$3,$4,$5,$6)`,
        [p3.projectId, p3.environment, userId, 'lesson_completed', idem, occurredAt],
      )
    // u-both is active in BOTH occurrence windows; u-a only in the first, u-b only in the second.
    await insertEvent('u-both', 'm1', d1)
    await insertEvent('u-both', 'm2', d3)
    await insertEvent('u-a', 'm3', d2)
    await insertEvent('u-b', 'm4', d4)
  })

  it('counts a user active in two windows of the same event exactly once', async () => {
    const store = new PgStatsStore(db)
    const stats = await store.getStats(p3, { from: null, to: null }, [wa, wb])

    // Two windows collapse to a single 'multi' row; u-both counted once → 3 distinct participants.
    expect(stats.timedEvents).toEqual([{ eventId: 'multi', participants: 3 }])
    // Union of both windows is likewise 3 (u-both, u-a, u-b).
    expect(stats.totals.timedEventParticipants).toBe(3)
  })

  it('counts users active in different windows of the same event (both included)', async () => {
    const store = new PgStatsStore(db)
    // Restrict range to the SECOND window only: u-both (d3) and u-b (d4) qualify; u-a (d2) drops.
    const stats = await store.getStats(p3, { from: d3, to: d4 }, [wa, wb])
    expect(stats.timedEvents).toEqual([{ eventId: 'multi', participants: 2 }])
    expect(stats.totals.timedEventParticipants).toBe(2)
  })
})

describe('PgStatsStore chunked cross-event totals', () => {
  // Two SEPARATE events, each with one window, so at chunkSize 1 they land in different chunks.
  const pc: Scope = { projectId: 'p-chunk', environment: 'test' }
  const evA = { eventId: 'evA', startsAt: d1, endsAt: d2 }
  const evB = { eventId: 'evB', startsAt: d3, endsAt: d4 }

  beforeAll(async () => {
    const insertEvent = (userId: string, idem: string, occurredAt: Date) =>
      db.$client.query(
        `insert into runtime.events (project_id, environment, user_id, type, idempotency_key, occurred_at) values ($1,$2,$3,$4,$5,$6)`,
        [pc.projectId, pc.environment, userId, 'lesson_completed', idem, occurredAt],
      )
    // u-shared is active in BOTH events (one in each window → different chunks at chunkSize 1);
    // u-onlyA and u-onlyB are each active in exactly one event.
    await insertEvent('u-shared', 'c1', d1) // evA window
    await insertEvent('u-shared', 'c2', d3) // evB window
    await insertEvent('u-onlyA', 'c3', d2) // evA window
    await insertEvent('u-onlyB', 'c4', d4) // evB window
  })

  it('produces identical results at chunkSize 1 and 50, counting a cross-chunk user once', async () => {
    const chunked = new PgStatsStore(db, 1)
    const unchunked = new PgStatsStore(db, 50)
    const range = { from: null, to: null }
    const resChunked = await chunked.getStats(pc, range, [evA, evB])
    const resUnchunked = await unchunked.getStats(pc, range, [evA, evB])

    // Bit-for-bit identical across chunk sizes.
    expect(resChunked).toEqual(resUnchunked)
    // Per-event counts are unaffected by chunking.
    expect(sortByKey(resChunked.timedEvents, 'eventId')).toEqual([
      { eventId: 'evA', participants: 2 }, // u-shared, u-onlyA
      { eventId: 'evB', participants: 2 }, // u-shared, u-onlyB
    ])
    // Cross-event total unions the two chunks: u-shared counted once → 3 distinct.
    expect(resChunked.totals.timedEventParticipants).toBe(3)
  })
})
