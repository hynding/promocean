import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ApiKeyStore, ConfigStore, ErasureStore, EventStore, OfferMetricsStore, ProgressStore, UsageStore } from '@promocean/core'
import { authMiddleware } from './auth.js'
import { logger } from './logger.js'
import { buildOpenApiDocument } from './openapi.js'
import { createRateLimiter } from './rate-limit.js'
import { eventsRoute } from './routes/events.js'
import { liveEventsRoute } from './routes/live-events.js'
import { offersRoute } from './routes/offers.js'
import { placementsRoute } from './routes/placements.js'
import { usersRoute } from './routes/users.js'
import type { WebhookDispatcher } from './webhooks.js'

// Read via readFileSync (not a `with { type: 'json' }` import) so tsc's
// rootDir inference doesn't pull package.json (outside src/) into the
// compiled output and nest dist/ under dist/src/.
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const { version: apiVersion } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }

// Built once at module load; served as a cached static object.
const openApiDocument = buildOpenApiDocument(apiVersion)

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
  // Registered before the rate-limit/auth middleware below so it is exempt
  // from both (Hono runs matched handlers in registration order).
  app.get('/v1/openapi.json', (c) => c.json(openApiDocument))
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
