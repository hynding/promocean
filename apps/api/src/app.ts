import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ApiKeyStore, ConfigStore, ErasureStore, EventStore, OfferMetricsStore, ProgressStore, UsageStore } from '@promocean/core'
import { authMiddleware } from './auth.js'
import { logger } from './logger.js'
import { createRateLimiter } from './rate-limit.js'
import { eventsRoute } from './routes/events.js'
import { liveEventsRoute } from './routes/live-events.js'
import { offersRoute } from './routes/offers.js'
import { placementsRoute } from './routes/placements.js'
import { usersRoute } from './routes/users.js'
import type { WebhookDispatcher } from './webhooks.js'

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string
  }
}

export interface AppDeps {
  configStore: ConfigStore
  apiKeyStore: ApiKeyStore
  eventStore: EventStore
  progressStore: ProgressStore
  usageStore: UsageStore
  offerMetricsStore: OfferMetricsStore
  erasureStore: ErasureStore
  webhooks?: WebhookDispatcher
}

export interface CreateAppOptions {
  rateLimitPerMinute?: number
}

export function createApp(deps: AppDeps, opts: CreateAppOptions = {}) {
  const rateLimitPerMinute = opts.rateLimitPerMinute ?? Number(process.env.RATE_LIMIT_PER_MINUTE ?? 300)
  const app = new Hono()
  app.use('*', async (c, next) => {
    const requestId = randomUUID()
    c.set('requestId', requestId)
    const start = Date.now()
    await next()
    c.res.headers.set('x-request-id', requestId)
    const ms = Date.now() - start
    logger.info({ requestId, method: c.req.method, path: c.req.path, status: c.res.status, ms }, 'request')
  })
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.use('/v1/*', cors())
  app.use('/v1/*', createRateLimiter(rateLimitPerMinute))
  app.use('/v1/*', authMiddleware(deps.apiKeyStore))
  app.route('/v1/events', eventsRoute(deps))
  app.route('/v1/events', liveEventsRoute(deps))
  app.route('/v1/users', usersRoute(deps))
  app.route('/v1/placements', placementsRoute(deps))
  app.route('/v1/offers', offersRoute(deps))
  app.onError((err, c) => {
    logger.error({ err, requestId: c.get('requestId') }, 'unhandled error')
    return c.json({ error: { code: 'internal_error', message: 'Internal error.' } }, 500)
  })
  return app
}
