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

  it('markDelivered sets delivered_at on the claim row and is idempotent', async () => {
    const store = new PgWebhookDeliveryStore(db)
    await store.claimTransition('p-md', 'e-md', 'live')
    await store.markDelivered('p-md', 'e-md', 'live')
    const { rows } = await db.$client.query(
      `select delivered_at from runtime.timed_event_notifications where project_id='p-md' and event_id='e-md' and transition='live'`,
    )
    expect(rows[0].delivered_at).not.toBeNull()
    // Idempotent: calling again on an already-delivered row is a no-op update, not an error.
    await expect(store.markDelivered('p-md', 'e-md', 'live')).resolves.toBeUndefined()
  })

  it('incrementAttempts increments the attempts counter', async () => {
    const store = new PgWebhookDeliveryStore(db)
    await store.claimTransition('p-ia', 'e-ia', 'live')
    await store.incrementAttempts('p-ia', 'e-ia', 'live')
    await store.incrementAttempts('p-ia', 'e-ia', 'live')
    const { rows } = await db.$client.query(
      `select attempts from runtime.timed_event_notifications where project_id='p-ia' and event_id='e-ia' and transition='live'`,
    )
    expect(rows[0].attempts).toBe(2)
  })

  it('findStaleClaims returns only undelivered, aged, retryable rows', async () => {
    const store = new PgWebhookDeliveryStore(db)
    const old = new Date(Date.now() - 60 * 60 * 1000) // 1h ago
    const recent = new Date()
    const cutoff = new Date(Date.now() - 30 * 60 * 1000) // 30m ago

    // delivered: old + delivered -> excluded
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-sc','delivered','live',$1,now(),0)`,
      [old],
    )
    // fresh: recent, undelivered -> excluded (not old enough)
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-sc','fresh','live',$1,null,0)`,
      [recent],
    )
    // exhausted: old, undelivered, attempts >= maxAttempts -> excluded
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-sc','exhausted','live',$1,null,5)`,
      [old],
    )
    // stale: old, undelivered, attempts < maxAttempts -> included
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-sc','stale','live',$1,null,1)`,
      [old],
    )

    const staleClaims = await store.findStaleClaims(cutoff, 5)
    const staleForScope = staleClaims.filter((c) => c.projectId === 'p-sc')
    expect(staleForScope).toEqual([{ projectId: 'p-sc', eventId: 'stale', transition: 'live', attempts: 1 }])
  })
})

describe('PgWebhookDeliveryStore dead-letter retention', () => {
  it('deleteDeadLettersBefore deletes only older rows and returns the count', async () => {
    const store = new PgWebhookDeliveryStore(db)
    const old = new Date(Date.now() - 60 * 60 * 1000)
    const recent = new Date()
    const cutoff = new Date(Date.now() - 30 * 60 * 1000)

    await store.recordDeadLetter('p-dl', 'https://x.test/old1', '{}', 'err', old)
    await store.recordDeadLetter('p-dl', 'https://x.test/old2', '{}', 'err', old)
    await store.recordDeadLetter('p-dl', 'https://x.test/recent', '{}', 'err', recent)

    const deletedCount = await store.deleteDeadLettersBefore(cutoff)
    expect(deletedCount).toBe(2)

    const { rows } = await db.$client.query(`select url from runtime.webhook_dead_letters where project_id='p-dl'`)
    expect(rows).toEqual([{ url: 'https://x.test/recent' }])
  })
})
