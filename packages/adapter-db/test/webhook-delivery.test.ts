import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgWebhookDeliveryStore, type Db } from '../src/index.js'

let container: StartedPostgreSqlContainer
let db: Db

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

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
