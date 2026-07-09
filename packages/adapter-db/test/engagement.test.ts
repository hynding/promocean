import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgEngagementStore, PgIngestionStore, type Db } from '../src/index.js'
import type { EngagementWrite, Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
const scope: Scope = { projectId: 'p1', environment: 'test' }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

const rawEventCount = async (s: Scope, idempotencyKey: string) => {
  const { rows } = await db.$client.query(
    `select count(*)::int as n from runtime.events where project_id=$1 and environment=$2 and idempotency_key=$3`,
    [s.projectId, s.environment, idempotencyKey],
  )
  return rows[0].n as number
}

const rawLedgerRows = async (s: Scope, userId: string) => {
  const { rows } = await db.$client.query(
    `select delta, source, source_ref as "sourceRef" from runtime.points_ledger where project_id=$1 and environment=$2 and user_id=$3 order by created_at asc`,
    [s.projectId, s.environment, userId],
  )
  return rows as { delta: number; source: string; sourceRef: string }[]
}

const rawStreak = async (s: Scope, userId: string) => {
  const { rows } = await db.$client.query(
    `select current_streak as "currentStreak", longest_streak as "longestStreak", to_char(last_active_day, 'YYYY-MM-DD') as "lastActiveDay" from runtime.user_streaks where project_id=$1 and environment=$2 and user_id=$3`,
    [s.projectId, s.environment, userId],
  )
  return rows[0] as { currentStreak: number; longestStreak: number; lastActiveDay: string | null } | undefined
}

const insertLedgerAt = async (s: Scope, userId: string, delta: number, source: string, sourceRef: string, createdAt: Date) => {
  await db.$client.query(
    `insert into runtime.points_ledger (project_id, environment, user_id, delta, source, source_ref, created_at) values ($1,$2,$3,$4,$5,$6,$7)`,
    [s.projectId, s.environment, userId, delta, source, sourceRef, createdAt],
  )
}

describe('PgIngestionStore engagement writes', () => {
  it('writes an event ledger row when eventPoints is set', async () => {
    const store = new PgIngestionStore(db)
    const userId = 'eng-event-user'
    const engagement: EngagementWrite = { localDay: '2026-01-01', eventPoints: { points: 10, sourceRef: 'ev-1' }, unlockPoints: {} }
    await store.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey: 'eng-event-1', occurredAt: new Date() }, [], '2026-01', engagement)
    const rows = await rawLedgerRows(scope, userId)
    expect(rows).toEqual([{ delta: 10, source: 'event', sourceRef: 'ev-1' }])
  })

  it('writes an unlock ledger row only for newly-inserted unlocks with a positive point value', async () => {
    const store = new PgIngestionStore(db)
    const userId = 'eng-unlock-user'
    const achievementId = 'eng-a1'
    const target = 1

    const engagement: EngagementWrite = { localDay: '2026-01-01', eventPoints: null, unlockPoints: { [achievementId]: 50 } }
    const r1 = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey: 'eng-unlock-1', occurredAt: new Date() },
      [{ achievementId, delta: 1, target }],
      '2026-01',
      engagement,
    )
    expect(r1.deduped).toBe(false)
    if (!r1.deduped) expect(r1.newUnlocks).toHaveLength(1)

    const rows = await rawLedgerRows(scope, userId)
    expect(rows).toEqual([{ delta: 50, source: 'unlock', sourceRef: achievementId }])

    // A further ingest for the same (already-unlocked) achievement must not award a second bonus.
    const r2 = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey: 'eng-unlock-2', occurredAt: new Date() },
      [{ achievementId, delta: 1, target }],
      '2026-01',
      engagement,
    )
    expect(r2.deduped).toBe(false)
    if (!r2.deduped) expect(r2.newUnlocks).toEqual([])
    const rowsAfter = await rawLedgerRows(scope, userId)
    expect(rowsAfter).toHaveLength(1)
  })

  it('does not award a ledger row for an unlock with no positive point value', async () => {
    const store = new PgIngestionStore(db)
    const userId = 'eng-zero-unlock-user'
    const achievementId = 'eng-zero-a1'
    const engagement: EngagementWrite = { localDay: '2026-01-01', eventPoints: null, unlockPoints: {} } // no entry -> not > 0
    const r1 = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey: 'eng-zero-unlock-1', occurredAt: new Date() },
      [{ achievementId, delta: 1, target: 1 }],
      '2026-01',
      engagement,
    )
    expect(r1.deduped).toBe(false)
    if (!r1.deduped) expect(r1.newUnlocks).toHaveLength(1)
    const rows = await rawLedgerRows(scope, userId)
    expect(rows).toEqual([])
  })

  it('a deduped replay writes nothing new to the ledger or streak', async () => {
    const store = new PgIngestionStore(db)
    const userId = 'eng-dedup-user'
    const idempotencyKey = 'eng-dedup-1'
    const engagement: EngagementWrite = { localDay: '2026-01-01', eventPoints: { points: 7, sourceRef: 'r1' }, unlockPoints: {} }

    const first = await store.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey, occurredAt: new Date() }, [], '2026-01', engagement)
    expect(first.deduped).toBe(false)
    const second = await store.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey, occurredAt: new Date() }, [], '2026-01', engagement)
    expect(second).toEqual({ deduped: true })

    const rows = await rawLedgerRows(scope, userId)
    expect(rows).toEqual([{ delta: 7, source: 'event', sourceRef: 'r1' }])
    const streak = await rawStreak(scope, userId)
    expect(streak).toEqual({ currentStreak: 1, longestStreak: 1, lastActiveDay: '2026-01-01' })
  })

  it('rolls back event, ledger, and streak writes together on a mid-transaction failure', async () => {
    const store = new PgIngestionStore(db)
    const userId = 'eng-rollback-user'
    const idempotencyKey = 'eng-rollback-1'
    // An invalid local day passes through applyStreak as a plain string (JS doesn't validate
    // calendar correctness) but fails when Postgres tries to store it in the `date` column at
    // the streak UPDATE step, which runs after the event/ledger inserts within the same tx.
    const engagement: EngagementWrite = { localDay: '9999-99-99', eventPoints: { points: 5, sourceRef: 'r1' }, unlockPoints: {} }

    await expect(
      store.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey, occurredAt: new Date() }, [], '2026-01', engagement),
    ).rejects.toThrow()

    expect(await rawEventCount(scope, idempotencyKey)).toBe(0)
    expect(await rawLedgerRows(scope, userId)).toEqual([])
    expect(await rawStreak(scope, userId)).toBeUndefined()

    // A valid retry (same idempotencyKey, never committed) succeeds and writes everything.
    const validEngagement: EngagementWrite = { localDay: '2026-01-01', eventPoints: { points: 5, sourceRef: 'r1' }, unlockPoints: {} }
    const retry = await store.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey, occurredAt: new Date() }, [], '2026-01', validEngagement)
    expect(retry.deduped).toBe(false)
    expect(await rawEventCount(scope, idempotencyKey)).toBe(1)
    expect(await rawLedgerRows(scope, userId)).toEqual([{ delta: 5, source: 'event', sourceRef: 'r1' }])
    expect(await rawStreak(scope, userId)).toEqual({ currentStreak: 1, longestStreak: 1, lastActiveDay: '2026-01-01' })
  })

  it('streak transitions live across same-day, next-day, and gap ingests, preserving longest', async () => {
    const store = new PgIngestionStore(db)
    const userId = 'eng-streak-user'
    const ingest = (idempotencyKey: string, localDay: string) =>
      store.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey, occurredAt: new Date() }, [], '2026-01', { localDay, eventPoints: null, unlockPoints: {} })

    await ingest('streak-1', '2026-01-01')
    expect(await rawStreak(scope, userId)).toEqual({ currentStreak: 1, longestStreak: 1, lastActiveDay: '2026-01-01' })

    // Same day again: no-op.
    await ingest('streak-2', '2026-01-01')
    expect(await rawStreak(scope, userId)).toEqual({ currentStreak: 1, longestStreak: 1, lastActiveDay: '2026-01-01' })

    // Next day: increments.
    await ingest('streak-3', '2026-01-02')
    expect(await rawStreak(scope, userId)).toEqual({ currentStreak: 2, longestStreak: 2, lastActiveDay: '2026-01-02' })

    // Gap (skip a day): resets current but preserves longest.
    await ingest('streak-4', '2026-01-05')
    expect(await rawStreak(scope, userId)).toEqual({ currentStreak: 1, longestStreak: 2, lastActiveDay: '2026-01-05' })
  })

  it('concurrent same-user same-day ingests serialize the streak to exactly 1 and sum the ledger exactly', async () => {
    const store = new PgIngestionStore(db)
    const userId = 'eng-concurrent-user'
    const localDay = '2026-02-01'
    await Promise.all([
      store.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey: 'eng-conc-1', occurredAt: new Date() }, [], '2026-02', { localDay, eventPoints: { points: 5, sourceRef: 'r1' }, unlockPoints: {} }),
      store.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey: 'eng-conc-2', occurredAt: new Date() }, [], '2026-02', { localDay, eventPoints: { points: 5, sourceRef: 'r2' }, unlockPoints: {} }),
    ])
    const streak = await rawStreak(scope, userId)
    expect(streak).toEqual({ currentStreak: 1, longestStreak: 1, lastActiveDay: localDay })
    const rows = await rawLedgerRows(scope, userId)
    expect(rows).toHaveLength(2)
    expect(rows.reduce((sum, r) => sum + r.delta, 0)).toBe(10)
  })
})

describe('PgEngagementStore', () => {
  it('getWallet returns COALESCE(sum) balance and the 20 most-recent rows newest-first', async () => {
    const store = new PgEngagementStore(db)
    const userId = 'wallet-user'
    const base = new Date('2026-03-01T00:00:00.000Z')
    for (let i = 0; i < 25; i++) {
      await insertLedgerAt(scope, userId, 1, 'event', `r${i}`, new Date(base.getTime() + i * 1000))
    }
    const wallet = await store.getWallet(scope, userId)
    expect(wallet.balance).toBe(25)
    expect(wallet.recent).toHaveLength(20)
    // Newest first: the most recent insert (r24) comes first.
    expect(wallet.recent[0]?.sourceRef).toBe('r24')
    expect(wallet.recent[19]?.sourceRef).toBe('r5')
  })

  it('getWallet returns a stable order across repeated reads when two rows share the same created_at', async () => {
    const store = new PgEngagementStore(db)
    const userId = 'wallet-same-ts-user'
    const at = new Date('2026-03-05T00:00:00.000Z')
    await insertLedgerAt(scope, userId, 10, 'event', 'same-ts-a', at)
    await insertLedgerAt(scope, userId, 5, 'unlock', 'same-ts-b', at)

    const first = await store.getWallet(scope, userId)
    const second = await store.getWallet(scope, userId)
    expect(first.recent.map((r) => r.sourceRef)).toEqual(second.recent.map((r) => r.sourceRef))
  })

  it('getWallet returns zero balance and empty recent for a user with no ledger rows', async () => {
    const store = new PgEngagementStore(db)
    const wallet = await store.getWallet(scope, 'no-such-user')
    expect(wallet).toEqual({ balance: 0, recent: [] })
  })

  it('getStreak returns zeros/null for a user with no streak row', async () => {
    const store = new PgEngagementStore(db)
    const streak = await store.getStreak(scope, 'no-such-streak-user')
    expect(streak).toEqual({ current: 0, longest: 0, lastActiveDay: null })
  })

  it('getStreak reflects a written streak row', async () => {
    const ingestionStore = new PgIngestionStore(db)
    const engagementStore = new PgEngagementStore(db)
    const userId = 'streak-read-user'
    await ingestionStore.ingestEvent(scope, { userId, type: 'lesson_completed', idempotencyKey: 'streak-read-1', occurredAt: new Date() }, [], '2026-01', { localDay: '2026-01-10', eventPoints: null, unlockPoints: {} })
    const streak = await engagementStore.getStreak(scope, userId)
    expect(streak).toEqual({ current: 1, longest: 1, lastActiveDay: '2026-01-10' })
  })

  it('getLeaderboard 7d window includes a row just inside the boundary and excludes one just outside', async () => {
    const store = new PgEngagementStore(db)
    const now = Date.now()
    const justInside = new Date(now - 7 * 24 * 60 * 60 * 1000 + 60_000) // 6d23h59m ago
    const justOutside = new Date(now - 7 * 24 * 60 * 60 * 1000 - 60_000) // 7d00h01m ago
    await insertLedgerAt(scope, 'lb-inside-user', 100, 'event', 'r1', justInside)
    await insertLedgerAt(scope, 'lb-outside-user', 100, 'event', 'r1', justOutside)

    const board = await store.getLeaderboard(scope, '7d', 50)
    const userIds = board.map((b) => b.userId)
    expect(userIds).toContain('lb-inside-user')
    expect(userIds).not.toContain('lb-outside-user')
  })

  it('getLeaderboard 30d window includes a row just inside the boundary and excludes one just outside', async () => {
    const store = new PgEngagementStore(db)
    const now = Date.now()
    const justInside = new Date(now - 30 * 24 * 60 * 60 * 1000 + 60_000)
    const justOutside = new Date(now - 30 * 24 * 60 * 60 * 1000 - 60_000)
    await insertLedgerAt(scope, 'lb30-inside-user', 100, 'event', 'r1', justInside)
    await insertLedgerAt(scope, 'lb30-outside-user', 100, 'event', 'r1', justOutside)

    const board = await store.getLeaderboard(scope, '30d', 50)
    const userIds = board.map((b) => b.userId)
    expect(userIds).toContain('lb30-inside-user')
    expect(userIds).not.toContain('lb30-outside-user')
  })

  it('getLeaderboard ranks by points desc, ties broken by user_id asc, 1-based rank', async () => {
    const store = new PgEngagementStore(db)
    const now = new Date()
    await insertLedgerAt(scope, 'tie-b', 10, 'event', 'r1', now)
    await insertLedgerAt(scope, 'tie-a', 10, 'event', 'r1', now)
    await insertLedgerAt(scope, 'tie-c', 20, 'event', 'r1', now)

    const board = await store.getLeaderboard(scope, 'all', 50)
    const relevant = board.filter((b) => ['tie-a', 'tie-b', 'tie-c'].includes(b.userId))
    expect(relevant.map((b) => b.userId)).toEqual(['tie-c', 'tie-a', 'tie-b'])
    expect(relevant.map((b) => b.points)).toEqual([20, 10, 10])
    // Ranks are 1-based and assigned from the ordered result.
    expect(relevant.every((b, i) => b.rank === board.indexOf(b) + 1)).toBe(true)
  })

  it('getLeaderboard is isolated per tenant (project/environment)', async () => {
    const store = new PgEngagementStore(db)
    const p2: Scope = { projectId: 'p2', environment: 'test' }
    const now = new Date()
    await insertLedgerAt(scope, 'tenant-p1-user', 1000, 'event', 'r1', now)
    await insertLedgerAt(p2, 'tenant-p2-user', 1000, 'event', 'r1', now)

    const boardP1 = await store.getLeaderboard(scope, 'all', 50)
    const boardP2 = await store.getLeaderboard(p2, 'all', 50)
    expect(boardP1.map((b) => b.userId)).toContain('tenant-p1-user')
    expect(boardP1.map((b) => b.userId)).not.toContain('tenant-p2-user')
    expect(boardP2.map((b) => b.userId)).toContain('tenant-p2-user')
    expect(boardP2.map((b) => b.userId)).not.toContain('tenant-p1-user')
  })
})
