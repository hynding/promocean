import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgIngestionStore, type Db } from '../src/index.js'
import type { EngagementWrite, Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
const scope: Scope = { projectId: 'p1', environment: 'test' }
const noEngagement: EngagementWrite = { localDay: '2026-07-01', eventPoints: null, unlockPoints: {} }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

const rawProgress = async (userId: string, achievementId: string) => {
  const { rows } = await db.$client.query(
    `select current from runtime.achievement_progress where project_id=$1 and environment=$2 and user_id=$3 and achievement_id=$4`,
    [scope.projectId, scope.environment, userId, achievementId],
  )
  return rows[0]?.current as number | undefined
}

const rawUnlockCount = async (userId: string, achievementId: string) => {
  const { rows } = await db.$client.query(
    `select count(*)::int as n from runtime.unlocks where project_id=$1 and environment=$2 and user_id=$3 and achievement_id=$4`,
    [scope.projectId, scope.environment, userId, achievementId],
  )
  return rows[0].n as number
}

const rawEventCount = async (idempotencyKey: string) => {
  const { rows } = await db.$client.query(
    `select count(*)::int as n from runtime.events where project_id=$1 and environment=$2 and idempotency_key=$3`,
    [scope.projectId, scope.environment, idempotencyKey],
  )
  return rows[0].n as number
}

const rawUnlockLedgerCount = async (userId: string, achievementId: string) => {
  const { rows } = await db.$client.query(
    `select count(*)::int as n from runtime.points_ledger where project_id=$1 and environment=$2 and user_id=$3 and source='unlock' and source_ref=$4`,
    [scope.projectId, scope.environment, userId, achievementId],
  )
  return rows[0].n as number
}

describe('PgIngestionStore', () => {
  // N-way ingestion race: N concurrent single-increment ingests must sum without a lost update.
  // The 2-way and 8-way cases share one body — the increments are structurally identical, only
  // the fan-out width and target differ — so they parameterize for free.
  it.each([
    { n: 2, userId: 'race-user', achievementId: 'a-race', target: 5 },
    { n: 8, userId: 'race-user-8', achievementId: 'a-race-8', target: 20 },
  ])('applies $n concurrent increments without a lost update (race)', async ({ n, userId, achievementId, target }) => {
    const store = new PgIngestionStore(db)
    const at = new Date()
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.ingestEvent(
          scope,
          { userId, type: 'lesson_completed', idempotencyKey: `${userId}-${i}`, occurredAt: at },
          [{ achievementId, delta: 1, target }],
          '2026-07',
          noEngagement,
        ),
      ),
    )
    expect(await rawProgress(userId, achievementId)).toBe(n)
  })

  it('unlock-crossing race: 8 concurrent increments summing across the target unlock exactly once (#18)', async () => {
    const store = new PgIngestionStore(db)
    const at = new Date()
    const userId = 'unlock-race-user'
    const achievementId = 'a-unlock-race'
    const target = 5 // 8 increments of 1 cross this; only one call may win the unlock
    const engagement: EngagementWrite = { localDay: '2026-07-01', eventPoints: null, unlockPoints: { [achievementId]: 100 } }

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.ingestEvent(
          scope,
          { userId, type: 'lesson_completed', idempotencyKey: `unlock-race-${i}`, occurredAt: at },
          [{ achievementId, delta: 1, target }],
          '2026-07',
          engagement,
        ),
      ),
    )

    // Exactly one call across the whole fan-out reports the new unlock.
    const emittedUnlocks = results.flatMap((r) => (r.deduped ? [] : r.newUnlocks)).filter((u) => u.achievementId === achievementId)
    expect(emittedUnlocks).toHaveLength(1)
    // Exactly one unlocks row and exactly one unlock bonus ledger row.
    expect(await rawUnlockCount(userId, achievementId)).toBe(1)
    expect(await rawUnlockLedgerCount(userId, achievementId)).toBe(1)
    // All 8 increments still landed (clamped at target).
    expect(await rawProgress(userId, achievementId)).toBe(target)
  })

  it('unlocks exactly once when a crossing call reaches the target, and only that call reports newUnlocks', async () => {
    const store = new PgIngestionStore(db)
    const at = new Date()
    const userId = 'unlock-user'
    const achievementId = 'a-unlock'
    const target = 3

    const r1 = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey: 'unlock-1', occurredAt: at },
      [{ achievementId, delta: 1, target }],
      '2026-07',
      noEngagement,
    )
    expect(r1).toEqual({ deduped: false, progress: [{ achievementId, current: 1, target }], newUnlocks: [] })

    const r2 = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey: 'unlock-2', occurredAt: at },
      [{ achievementId, delta: 1, target }],
      '2026-07',
      noEngagement,
    )
    expect(r2.deduped).toBe(false)
    if (!r2.deduped) expect(r2.newUnlocks).toEqual([])

    // Third call crosses the target: exactly one unlock row, newUnlocks non-empty only here.
    const r3 = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey: 'unlock-3', occurredAt: at },
      [{ achievementId, delta: 1, target }],
      '2026-07',
      noEngagement,
    )
    expect(r3.deduped).toBe(false)
    if (!r3.deduped) {
      expect(r3.progress).toEqual([{ achievementId, current: 3, target }])
      expect(r3.newUnlocks).toHaveLength(1)
      expect(r3.newUnlocks[0]?.achievementId).toBe(achievementId)
      expect(r3.newUnlocks[0]?.unlockedAt).toBeInstanceOf(Date)
    }
    expect(await rawUnlockCount(userId, achievementId)).toBe(1)

    // A further call after the unlock does not insert another unlocks row and reports no new unlocks.
    const r4 = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey: 'unlock-4', occurredAt: at },
      [{ achievementId, delta: 1, target }],
      '2026-07',
      noEngagement,
    )
    expect(r4.deduped).toBe(false)
    if (!r4.deduped) expect(r4.newUnlocks).toEqual([])
    expect(await rawUnlockCount(userId, achievementId)).toBe(1)
  })

  it('rolls back the entire transaction on a mid-transaction failure, and a subsequent valid retry succeeds', async () => {
    const store = new PgIngestionStore(db)
    const at = new Date()
    const userId = 'rollback-user'
    const achievementId = 'a-rollback'
    const idempotencyKey = 'rollback-1'

    await expect(
      store.ingestEvent(
        scope,
        { userId, type: 'lesson_completed', idempotencyKey, occurredAt: at },
        [{ achievementId, delta: Number.NaN, target: 5 }],
        '2026-07',
        noEngagement,
      ),
    ).rejects.toThrow()

    // The event row must not exist: the whole transaction rolled back, not just the increment.
    expect(await rawEventCount(idempotencyKey)).toBe(0)
    expect(await rawProgress(userId, achievementId)).toBeUndefined()

    // Retrying with valid increments (same idempotencyKey — dedup insert never committed) succeeds.
    const retry = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey, occurredAt: at },
      [{ achievementId, delta: 1, target: 5 }],
      '2026-07',
      noEngagement,
    )
    expect(retry).toEqual({ deduped: false, progress: [{ achievementId, current: 1, target: 5 }], newUnlocks: [] })
    expect(await rawEventCount(idempotencyKey)).toBe(1)
  })

  it('dedupes on idempotencyKey: the second call with the same key returns deduped:true and leaves counters unchanged', async () => {
    const store = new PgIngestionStore(db)
    const at = new Date()
    const userId = 'dedup-user'
    const achievementId = 'a-dedup'
    const idempotencyKey = 'dedup-1'

    const first = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey, occurredAt: at },
      [{ achievementId, delta: 1, target: 5 }],
      '2026-07',
      noEngagement,
    )
    expect(first.deduped).toBe(false)

    const second = await store.ingestEvent(
      scope,
      { userId, type: 'lesson_completed', idempotencyKey, occurredAt: at },
      [{ achievementId, delta: 1, target: 5 }],
      '2026-07',
      noEngagement,
    )
    expect(second).toEqual({ deduped: true })
    expect(await rawProgress(userId, achievementId)).toBe(1)
  })
})
