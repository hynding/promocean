import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgErasureStore, type Db } from '../src/index.js'
import type { Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
const scope: Scope = { projectId: 'p1', environment: 'test' }
const otherProjectScope: Scope = { projectId: 'p2', environment: 'test' }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)

  // Seed u1 + u2 rows in p1/test, and u1 rows in p2/test.
  const at = new Date()
  for (const s of [scope, otherProjectScope]) {
    const users = s === scope ? ['u1', 'u2'] : ['u1']
    for (const userId of users) {
      await db.$client.query(
        `insert into runtime.events (project_id, environment, user_id, type, idempotency_key, occurred_at) values ($1,$2,$3,$4,$5,$6)`,
        [s.projectId, s.environment, userId, 'lesson_completed', `idem-${s.projectId}-${userId}`, at],
      )
      await db.$client.query(
        `insert into runtime.achievement_progress (project_id, environment, user_id, achievement_id, current) values ($1,$2,$3,$4,$5)`,
        [s.projectId, s.environment, userId, 'a1', 3],
      )
      await db.$client.query(
        `insert into runtime.unlocks (project_id, environment, user_id, achievement_id, unlocked_at) values ($1,$2,$3,$4,$5)`,
        [s.projectId, s.environment, userId, 'a1', at],
      )
      await db.$client.query(
        `insert into runtime.offer_events (project_id, environment, offer_id, user_id, kind, created_at) values ($1,$2,$3,$4,$5,$6)`,
        [s.projectId, s.environment, 'o1', userId, 'impression', at],
      )
      await db.$client.query(
        `insert into runtime.monthly_active_users (project_id, environment, month, user_id) values ($1,$2,$3,$4)`,
        [s.projectId, s.environment, '2026-07', userId],
      )
    }
  }
})
afterAll(async () => { await db.$client.end(); await container.stop() })

describe('PgErasureStore', () => {
  it('erases a single user within a scope transactionally, leaving other users, other tenants, and MAU rows intact', async () => {
    const store = new PgErasureStore(db)
    const counts = await store.eraseUser(scope, 'u1')
    expect(counts).toEqual({ events: 1, progress: 1, unlocks: 1, offerEvents: 1 })

    const countRows = async (table: string, projectId: string, userId: string) => {
      const { rows } = await db.$client.query(
        `select count(*)::int as n from runtime.${table} where project_id=$1 and user_id=$2`,
        [projectId, userId],
      )
      return rows[0].n as number
    }

    // u1 in p1/test erased.
    expect(await countRows('events', 'p1', 'u1')).toBe(0)
    expect(await countRows('achievement_progress', 'p1', 'u1')).toBe(0)
    expect(await countRows('unlocks', 'p1', 'u1')).toBe(0)
    expect(await countRows('offer_events', 'p1', 'u1')).toBe(0)

    // u2 in p1/test survives.
    expect(await countRows('events', 'p1', 'u2')).toBe(1)
    expect(await countRows('achievement_progress', 'p1', 'u2')).toBe(1)
    expect(await countRows('unlocks', 'p1', 'u2')).toBe(1)
    expect(await countRows('offer_events', 'p1', 'u2')).toBe(1)

    // u1 in p2/test (other tenant) survives.
    expect(await countRows('events', 'p2', 'u1')).toBe(1)
    expect(await countRows('achievement_progress', 'p2', 'u1')).toBe(1)
    expect(await countRows('unlocks', 'p2', 'u1')).toBe(1)
    expect(await countRows('offer_events', 'p2', 'u1')).toBe(1)

    // MAU rows are deliberately not touched by erasure.
    expect(await countRows('monthly_active_users', 'p1', 'u1')).toBe(1)
    expect(await countRows('monthly_active_users', 'p1', 'u2')).toBe(1)
    expect(await countRows('monthly_active_users', 'p2', 'u1')).toBe(1)
  })
})
