import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgProgressStore, PgUsageStore, type Db } from '../src/index.js'
import type { Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
const scope: Scope = { projectId: 'p1', environment: 'test' }
const otherScope: Scope = { projectId: 'p2', environment: 'test' }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

// Seeds achievement_progress directly (the only writer of that table is now PgIngestionStore;
// these read-path tests just need a known row).
const seedProgress = (s: Scope, userId: string, achievementId: string, current: number) =>
  db.$client.query(
    `insert into runtime.achievement_progress (project_id, environment, user_id, achievement_id, current) values ($1,$2,$3,$4,$5)
     on conflict (project_id, environment, user_id, achievement_id) do update set current = excluded.current`,
    [s.projectId, s.environment, userId, achievementId, current],
  )

describe('PgProgressStore', () => {
  it('reads progress scoped by tenant', async () => {
    const store = new PgProgressStore(db)
    await seedProgress(scope, 'u1', 'a1', 4)
    const counts = await store.getCounts(scope, 'u1', ['a1', 'a2'])
    expect(counts.get('a1')).toBe(4)
    expect(counts.get('a2')).toBeUndefined()
    expect((await store.getCounts(otherScope, 'u1', ['a1'])).size).toBe(0)
  })
  it('records unlocks idempotently', async () => {
    const store = new PgProgressStore(db)
    const at = new Date()
    expect(await store.recordUnlock(scope, 'u1', 'a1', at)).toBe(true)
    expect(await store.recordUnlock(scope, 'u1', 'a1', at)).toBe(false)
    const rows = await store.getUserAchievements(scope, 'u1')
    expect(rows).toContainEqual({ achievementId: 'a1', current: 4, unlockedAt: expect.any(Date) })
  })
})

describe('PgUsageStore', () => {
  it('counts events and distinct MAU', async () => {
    const store = new PgUsageStore(db)
    await store.recordUsage(scope, 'u1', '2026-07')
    await store.recordUsage(scope, 'u1', '2026-07')
    await store.recordUsage(scope, 'u2', '2026-07')
    // no exception = pass; counters are asserted via direct query
    const { rows } = await db.$client.query(
      `select events_count from runtime.usage_counters where project_id='p1' and month='2026-07'`,
    )
    expect(rows[0].events_count).toBe(3)
    const mau = await db.$client.query(
      `select count(*)::int as n from runtime.monthly_active_users where project_id='p1' and month='2026-07'`,
    )
    expect(mau.rows[0].n).toBe(2)
  })
})
