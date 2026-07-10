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
    expect(await store.claimTransition('p1', 'e1', '', 'live')).toBe(true)
    expect(await store.claimTransition('p1', 'e1', '', 'live')).toBe(false)
    expect(await store.claimTransition('p1', 'e1', '', 'ended')).toBe(true)
    expect(await store.claimTransition('p2', 'e1', '', 'live')).toBe(true)
  })

  it('claims the same (project, event, transition) independently per occurrence key', async () => {
    const store = new PgWebhookDeliveryStore(db)
    // Two occurrences of a recurring event: same project/event/transition, different keys.
    const k1 = '2026-01-01T00:00:00.000Z'
    const k2 = '2026-01-08T00:00:00.000Z'
    expect(await store.claimTransition('p-occ', 'rec', k1, 'live')).toBe(true)
    expect(await store.claimTransition('p-occ', 'rec', k2, 'live')).toBe(true)
    // Each key is claimable exactly once.
    expect(await store.claimTransition('p-occ', 'rec', k1, 'live')).toBe(false)
    expect(await store.claimTransition('p-occ', 'rec', k2, 'live')).toBe(false)
    // The empty-key ('' — a non-recurring occurrence) coexists with ISO-keyed claims.
    expect(await store.claimTransition('p-occ', 'rec', '', 'live')).toBe(true)
    expect(await store.claimTransition('p-occ', 'rec', '', 'live')).toBe(false)
    const { rows } = await db.$client.query(
      `select count(*)::int as n from runtime.timed_event_notifications where project_id='p-occ' and event_id='rec' and transition='live'`,
    )
    expect(rows[0].n).toBe(3)
  })

  it('markDelivered and incrementAttempts hit only the addressed occurrence key', async () => {
    const store = new PgWebhookDeliveryStore(db)
    const kA = 'occ-A'
    const kB = 'occ-B'
    await store.claimTransition('p-key', 'e-key', kA, 'live')
    await store.claimTransition('p-key', 'e-key', kB, 'live')

    // Deliver only kA; kB stays undelivered.
    await store.markDelivered('p-key', 'e-key', kA, 'live')
    // Increment attempts only on kB; kA stays at 0.
    await store.incrementAttempts('p-key', 'e-key', kB, 'live')

    const { rows } = await db.$client.query(
      `select occurrence_key, delivered_at, attempts from runtime.timed_event_notifications where project_id='p-key' and event_id='e-key' and transition='live' order by occurrence_key`,
    )
    expect(rows.map((r: any) => ({ occurrence_key: r.occurrence_key, delivered: r.delivered_at !== null, attempts: r.attempts }))).toEqual([
      { occurrence_key: 'occ-A', delivered: true, attempts: 0 },
      { occurrence_key: 'occ-B', delivered: false, attempts: 1 },
    ])
  })
  it('records dead letters', async () => {
    const store = new PgWebhookDeliveryStore(db)
    await store.recordDeadLetter('p1', 'https://x.test/hook', '{"type":"t"}', 'server 500 after 4 attempts', new Date())
    const { rows } = await db.$client.query(`select url, error from runtime.webhook_dead_letters where project_id='p1'`)
    expect(rows).toEqual([{ url: 'https://x.test/hook', error: 'server 500 after 4 attempts' }])
  })

  it('markDelivered sets delivered_at on the claim row and is idempotent', async () => {
    const store = new PgWebhookDeliveryStore(db)
    await store.claimTransition('p-md', 'e-md', '', 'live')
    await store.markDelivered('p-md', 'e-md', '', 'live')
    const { rows: rows1 } = await db.$client.query(
      `select delivered_at from runtime.timed_event_notifications where project_id='p-md' and event_id='e-md' and transition='live'`,
    )
    expect(rows1[0].delivered_at).not.toBeNull()
    const deliveredAt1 = rows1[0].delivered_at
    // Idempotent: calling again on an already-delivered row is a no-op update, not an error.
    // Wait a bit to ensure any clock advancement would be visible if idempotency failed.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.markDelivered('p-md', 'e-md', '', 'live')
    const { rows: rows2 } = await db.$client.query(
      `select delivered_at from runtime.timed_event_notifications where project_id='p-md' and event_id='e-md' and transition='live'`,
    )
    const deliveredAt2 = rows2[0].delivered_at
    // Timestamp must be unchanged (exact equality) — the second call was a true no-op.
    expect(deliveredAt2.getTime()).toBe(deliveredAt1.getTime())
  })

  it('incrementAttempts increments the attempts counter', async () => {
    const store = new PgWebhookDeliveryStore(db)
    await store.claimTransition('p-ia', 'e-ia', '', 'live')
    await store.incrementAttempts('p-ia', 'e-ia', '', 'live')
    await store.incrementAttempts('p-ia', 'e-ia', '', 'live')
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
    // stale: old, undelivered, attempts < maxAttempts -> included (default '' occurrence key)
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-sc','stale','live',$1,null,1)`,
      [old],
    )
    // stale with an explicit occurrence key -> included, and its key comes back on the row.
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, occurrence_key, transition, fired_at, delivered_at, attempts) values ('p-sc','stale','occ-1','live',$1,null,2)`,
      [old],
    )

    const staleClaims = await store.findStaleClaims(cutoff, 5)
    const staleForScope = staleClaims
      .filter((c) => c.projectId === 'p-sc')
      .sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey))
    expect(staleForScope).toEqual([
      { projectId: 'p-sc', eventId: 'stale', occurrenceKey: '', transition: 'live', attempts: 1 },
      { projectId: 'p-sc', eventId: 'stale', occurrenceKey: 'occ-1', transition: 'live', attempts: 2 },
    ])
  })

  it('findExhaustedClaims returns only undelivered rows at or above minAttempts', async () => {
    const store = new PgWebhookDeliveryStore(db)
    const old = new Date(Date.now() - 60 * 60 * 1000)

    // below cap: undelivered, attempts < minAttempts -> excluded
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-ec','below-cap','live',$1,null,4)`,
      [old],
    )
    // delivered: attempts >= minAttempts but delivered -> excluded
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-ec','delivered','live',$1,now(),5)`,
      [old],
    )
    // exhausted: undelivered, attempts >= minAttempts -> included
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-ec','exhausted','live',$1,null,5)`,
      [old],
    )
    // over cap: undelivered, attempts > minAttempts -> included
    await db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ('p-ec','over-cap','live',$1,null,7)`,
      [old],
    )

    const exhaustedClaims = await store.findExhaustedClaims(5)
    const exhaustedForScope = exhaustedClaims.filter((c) => c.projectId === 'p-ec')
    expect(exhaustedForScope.map((c) => c.eventId).sort()).toEqual(['exhausted', 'over-cap'])
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

describe('PgWebhookDeliveryStore delivered-claims retention', () => {
  const insertClaim = (projectId: string, eventId: string, deliveredAt: Date | null, firedAt: Date) =>
    db.$client.query(
      `insert into runtime.timed_event_notifications (project_id, event_id, transition, fired_at, delivered_at, attempts) values ($1,$2,'live',$3,$4,0)`,
      [projectId, eventId, firedAt, deliveredAt],
    )

  it('deletes only delivered rows older than cutoff; boundary is strict and undelivered rows are never swept', async () => {
    const store = new PgWebhookDeliveryStore(db)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30d ago
    const justInside = new Date(cutoff.getTime() - 60_000) // delivered 1m before cutoff -> swept
    const justOutside = new Date(cutoff.getTime() + 60_000) // delivered 1m after cutoff -> kept
    const longAgo = new Date(cutoff.getTime() - 60 * 60 * 1000) // fired 1h before cutoff

    await insertClaim('p-dc', 'delivered-old-1', justInside, longAgo)
    await insertClaim('p-dc', 'delivered-old-2', justInside, longAgo)
    await insertClaim('p-dc', 'delivered-recent', justOutside, longAgo)
    // Undelivered but aged well past the cutoff: redelivery owns it, so it must never be swept.
    await insertClaim('p-dc', 'undelivered-old', null, longAgo)

    const deleted = await store.deleteDeliveredClaimsBefore(cutoff)
    expect(deleted).toBe(2)

    const { rows } = await db.$client.query(
      `select event_id from runtime.timed_event_notifications where project_id='p-dc' order by event_id`,
    )
    expect(rows.map((r: any) => r.event_id)).toEqual(['delivered-recent', 'undelivered-old'])
  })

  it('returns 0 and deletes nothing when no delivered rows precede the cutoff', async () => {
    const store = new PgWebhookDeliveryStore(db)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await insertClaim('p-dc2', 'undelivered-only', null, new Date(cutoff.getTime() - 60 * 60 * 1000))
    expect(await store.deleteDeliveredClaimsBefore(cutoff)).toBe(0)
  })
})

describe('migration 0005 — delivered_at backfill', () => {
  it('backfills delivered_at to fired_at for claims left null by pre-0004 data, and leaves delivered rows untouched', async () => {
    const store = new PgWebhookDeliveryStore(db)
    const firedAt = new Date(Date.now() - 60 * 60 * 1000)

    // Simulates a claim made before migration 0004 introduced delivered_at: null it out
    // via raw SQL exactly as it would appear on an existing database pre-upgrade.
    await store.claimTransition('p-bf', 'e-null', '', 'live')
    await db.$client.query(
      `update runtime.timed_event_notifications set fired_at = $1, delivered_at = null where project_id='p-bf' and event_id='e-null' and transition='live'`,
      [firedAt],
    )

    // An already-delivered row must be untouched by the backfill.
    await store.claimTransition('p-bf', 'e-delivered', '', 'live')
    await store.markDelivered('p-bf', 'e-delivered', '', 'live')
    const { rows: beforeRows } = await db.$client.query(
      `select delivered_at from runtime.timed_event_notifications where project_id='p-bf' and event_id='e-delivered' and transition='live'`,
    )
    const deliveredAtBefore = beforeRows[0].delivered_at

    // Execute the 0005 migration's UPDATE statement raw (mirrors migrations/0005_backfill_delivered_at.sql).
    await db.$client.query(
      `UPDATE "runtime"."timed_event_notifications" SET "delivered_at" = "fired_at" WHERE "delivered_at" IS NULL`,
    )

    const { rows: nullRows } = await db.$client.query(
      `select fired_at, delivered_at from runtime.timed_event_notifications where project_id='p-bf' and event_id='e-null' and transition='live'`,
    )
    expect(nullRows[0].delivered_at.getTime()).toBe(nullRows[0].fired_at.getTime())

    const { rows: deliveredRows } = await db.$client.query(
      `select delivered_at from runtime.timed_event_notifications where project_id='p-bf' and event_id='e-delivered' and transition='live'`,
    )
    expect(deliveredRows[0].delivered_at.getTime()).toBe(deliveredAtBefore.getTime())
  })
})
