import { serve } from '@hono/node-server'
import { createDb, runMigrations, PgEventStore, PgOfferMetricsStore, PgProgressStore, PgUsageStore, PgWebhookDeliveryStore } from '@promocean/adapter-db'
import { StrapiConfigPlane } from '@promocean/adapter-strapi'
import { createApp } from './app.js'
import { WebhookDispatcher, startLifecycleScheduler } from './webhooks.js'

const db = createDb(process.env.DATABASE_URL!)
await runMigrations(db)
const plane = new StrapiConfigPlane({
  baseUrl: process.env.STRAPI_URL ?? 'http://localhost:1337',
  configSecret: process.env.CONFIG_PLANE_SECRET!,
})
const webhookDeliveryStore = new PgWebhookDeliveryStore(db)
const webhooks = new WebhookDispatcher({ configStore: plane, deliveryStore: webhookDeliveryStore })
startLifecycleScheduler({ configStore: plane, deliveryStore: webhookDeliveryStore, dispatcher: webhooks })
const app = createApp({
  configStore: plane,
  apiKeyStore: plane,
  eventStore: new PgEventStore(db),
  progressStore: new PgProgressStore(db),
  usageStore: new PgUsageStore(db),
  offerMetricsStore: new PgOfferMetricsStore(db),
  webhooks,
})
const port = Number(process.env.API_PORT ?? 3001)
serve({ fetch: app.fetch, port })
console.log(`promocean api listening on :${port}`)
