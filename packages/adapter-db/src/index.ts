import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

export type Db = NodePgDatabase & { $client: pg.Pool }
export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString })
  // node-postgres requires an 'error' listener on the pool: idle clients emit
  // 'error' when the server terminates the connection (e.g. a Testcontainer
  // being stopped in test teardown). Without a listener, Node treats it as an
  // unhandled exception and the process exits non-zero even though all tests
  // passed. See: https://node-postgres.com/apis/pool#error
  pool.on('error', (err) => { console.error('[promocean/adapter-db] idle client error', err) })
  return drizzle(pool) as Db
}
export { runMigrations } from './migrate.js'
export { PgEngagementStore, PgErasureStore, PgEventStore, PgIngestionStore, PgOfferMetricsStore, PgProgressStore, PgRewardStore, PgStatsStore, PgUsageStore, PgWebhookDeliveryStore } from './stores.js'
export * as schema from './schema.js'
