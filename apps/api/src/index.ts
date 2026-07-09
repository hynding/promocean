import { serve } from '@hono/node-server'
import { createDb, runMigrations, PgErasureStore, PgIngestionStore, PgOfferMetricsStore, PgProgressStore, PgStatsStore, PgWebhookDeliveryStore } from '@promocean/adapter-db'
import { StrapiConfigPlane } from '@promocean/adapter-strapi'
import { createApp } from './app.js'
import { envInt } from './env.js'
import { logger } from './logger.js'
import { installShutdownHandlers } from './shutdown.js'
import { WebhookDispatcher, resolveScanGraceMinutes, startLifecycleScheduler } from './webhooks.js'

const db = createDb(process.env.DATABASE_URL!)
await runMigrations(db)
const redeliveryGraceMinutes = envInt('WEBHOOK_REDELIVERY_GRACE_MINUTES', 5)
// Single-sourced (Sprint 6 Task 4 review fix): compute the effective scan-grace window once
// and hand it to BOTH the config-plane feed and the lifecycle scheduler, so they always agree
// on how far back "ended" events are still considered in scope. The scheduler's own clamp is
// kept as a backstop but is a no-op given an already-resolved value.
const scanGraceMinutes = resolveScanGraceMinutes(
  envInt('TIMED_EVENT_SCAN_GRACE_MINUTES', 60),
  redeliveryGraceMinutes,
  logger,
)
const plane = new StrapiConfigPlane({
  baseUrl: process.env.STRAPI_URL ?? 'http://localhost:1337',
  configSecret: process.env.CONFIG_PLANE_SECRET!,
  allTimedEventsEndedWithinMinutes: scanGraceMinutes,
})
const webhookDeliveryStore = new PgWebhookDeliveryStore(db)
const webhooks = new WebhookDispatcher({ configStore: plane, deliveryStore: webhookDeliveryStore })
const stopScheduler = startLifecycleScheduler({
  configStore: plane,
  deliveryStore: webhookDeliveryStore,
  dispatcher: webhooks,
  redeliveryGraceMinutes,
  scanGraceMinutes,
  deadLetterTtlDays: envInt('WEBHOOK_DEAD_LETTER_TTL_DAYS', 30),
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
    // Cheap probe: getAllTimedEvents() hits a single, cached Strapi endpoint. Post-Task-4 this
    // sees the ended-event-filtered feed, not the full history — fine, it only checks
    // reachability, not completeness.
    checkConfigPlane: async () => { await plane.getAllTimedEvents() },
  },
})
const port = envInt('API_PORT', 3001)
const server = serve({ fetch: app.fetch, port })
logger.info({ port }, 'promocean api listening')

installShutdownHandlers({ stopScheduler, server, pool: db.$client, logger })
