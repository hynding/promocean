import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgOfferMetricsStore, type Db } from '../src/index.js'
import type { Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
const scope: Scope = { projectId: 'p1', environment: 'test' }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

describe('PgOfferMetricsStore', () => {
  it('records impressions and clicks with tenancy and nullable user', async () => {
    const store = new PgOfferMetricsStore(db)
    const at = new Date()
    await store.recordImpression(scope, 'o1', 'u1', at, 'impr-1')
    await store.recordImpression(scope, 'o1', null, at, 'impr-2')
    await store.recordClick(scope, 'o1', 'u1', at)
    const { rows } = await db.$client.query(
      `select kind, user_id from runtime.offer_events where project_id='p1' and offer_id='o1' order by kind, user_id nulls last`,
    )
    expect(rows).toEqual([
      { kind: 'click', user_id: 'u1' },
      { kind: 'impression', user_id: 'u1' },
      { kind: 'impression', user_id: null },
    ])
  })

  it('dedupes impression beacons on idempotencyKey: a repeat call inserts no second row', async () => {
    const store = new PgOfferMetricsStore(db)
    const at = new Date()
    await store.recordImpression(scope, 'o2', 'u9', at, 'beacon-1')
    await store.recordImpression(scope, 'o2', 'u9', at, 'beacon-1')
    const { rows } = await db.$client.query(
      `select count(*)::int as n from runtime.offer_events where project_id='p1' and offer_id='o2' and kind='impression'`,
    )
    expect(rows[0].n).toBe(1)
  })
})
