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
    await store.recordImpression(scope, 'o1', 'u1', at)
    await store.recordImpression(scope, 'o1', null, at)
    await store.recordClick(scope, 'o1', 'u1', at)
    const { rows } = await db.$client.query(
      `select kind, user_id from runtime.offer_events where project_id='p1' and offer_id='o1' order by kind`,
    )
    expect(rows).toEqual([
      { kind: 'click', user_id: 'u1' },
      { kind: 'impression', user_id: 'u1' },
      { kind: 'impression', user_id: null },
    ])
  })
})
