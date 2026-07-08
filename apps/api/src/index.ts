import { serve } from '@hono/node-server'
import { createDb, runMigrations, PgErasureStore, PgIngestionStore, PgOfferMetricsStore, PgProgressStore, PgStatsStore, PgWebhookDeliveryStore } from '@promocean/adapter-db'
import { StrapiConfigPlane } from '@promocean/adapter-strapi'
import { createApp } from './app.js'
import { logger } from './logger.js'
import { WebhookDispatcher, startLifecycleScheduler } from './webhooks.js'

const db = createDb(process.env.DATABASE_URL!)
await runMigrations(db)
const plane = new StrapiConfigPlane({
  baseUrl: process.env.STRAPI_URL ?? 'http://localhost:1337',
  configSecret: process.env.CONFIG_PLANE_SECRET!,
})
const webhookDeliveryStore = new PgWebhookDeliveryStore(db)
const webhooks = new WebhookDispatcher({ configStore: plane, deliveryStore: webhookDeliveryStore })
startLifecycleScheduler({
  configStore: plane,
  deliveryStore: webhookDeliveryStore,
  dispatcher: webhooks,
  redeliveryGraceMinutes: Number(process.env.WEBHOOK_REDELIVERY_GRACE_MINUTES ?? 5),
  scanGraceMinutes: Number(process.env.TIMED_EVENT_SCAN_GRACE_MINUTES ?? 60),
  deadLetterTtlDays: Number(process.env.WEBHOOK_DEAD_LETTER_TTL_DAYS ?? 30),
})
const app = createApp({
  configStore: plane,
  apiKeyStore: plane,
  ingestionStore: new PgIngestionStore(db),
  progressStore: new PgProgressStore(db),
  offerMetricsStore: new PgOfferMetricsStore(db),
  erasureStore: new PgErasureStore(db),
  statsStore: new PgStatsStore(db),
  webhooks,
  readiness: {
    checkDb: async () => { await db.$client.query('select 1') },
    // Cheap probe: getAllTimedEvents() hits a single, cached Strapi endpoint.
    checkConfigPlane: async () => { await plane.getAllTimedEvents() },
  },
})
const port = Number(process.env.API_PORT ?? 3001)
serve({ fetch: app.fetch, port })
logger.info({ port }, 'promocean api listening')
