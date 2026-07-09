import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ApiKeyStore, ConfigStore, EngagementStore, ErasureStore, IngestionStore, OfferMetricsStore, ProgressStore, RewardStore, StatsStore } from '@promocean/core'
import { authMiddleware } from './auth.js'
import { envInt } from './env.js'
import { logger } from './logger.js'
import { buildOpenApiDocument } from './openapi.js'
import { createRateLimiter } from './rate-limit.js'
import { couponsRoute } from './routes/coupons.js'
import { engagementRoute } from './routes/engagement.js'
import { eventsRoute } from './routes/events.js'
import { liveEventsRoute } from './routes/live-events.js'
import { offersRoute } from './routes/offers.js'
import { placementsRoute } from './routes/placements.js'
import { rewardsRoute } from './routes/rewards.js'
import { statsRoute } from './routes/stats.js'
import { usersRoute } from './routes/users.js'
import type { WebhookDispatcher } from './webhooks.js'

// Read via readFileSync (not a `with { type: 'json' }` import) so tsc's
// rootDir inference doesn't pull package.json (outside src/) into the
// compiled output and nest dist/ under dist/src/.
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const { version: apiVersion } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }

// Built and serialized once at module load; served as a cached static string
// so every request avoids re-walking/re-stringifying the document.
const openApiDocument = buildOpenApiDocument(apiVersion)
const openApiBody = JSON.stringify(openApiDocument)

// Static Redoc viewer for the OpenAPI document. The browser loads the Redoc
// bundle from its CDN at view time; the API itself takes on no doc-rendering
// dependency (no redoc package in this app's own dependency tree). Pinned to
// a specific version (rather than the mutable /latest/ alias) with a
// Subresource Integrity hash so the CDN can't silently swap the served
// script; bump both together when upgrading Redoc.
const docsHtml = `<!doctype html>
<html>
  <head>
    <title>Promocean API docs</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <redoc spec-url="/v1/openapi.json"></redoc>
    <script
      src="https://cdn.redoc.ly/redoc/v2.5.3/bundles/redoc.standalone.js"
      integrity="sha384-xiEssMQFSpSfLbzRZCGfxxIM5QDb2DTrU6vyoZdp2sV1L6pmOMy6MpTtUoLbpC96"
      crossorigin="anonymous"
    ></script>
  </body>
</html>`

// Races an arbitrary promise against a timeout. AbortSignal.timeout() only
// helps callers that accept a signal (e.g. fetch); our readiness checks are
// plain promises, so we race them against a rejecting timer instead.
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    p,
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    }),
  ])
}

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string
  }
}

export interface AppDeps {
  configStore: ConfigStore
  apiKeyStore: ApiKeyStore
  ingestionStore: IngestionStore
  progressStore: ProgressStore
  offerMetricsStore: OfferMetricsStore
  erasureStore: ErasureStore
  statsStore: StatsStore
  engagementStore: EngagementStore
  rewardStore: RewardStore
  webhooks?: WebhookDispatcher
  readiness?: {
    checkDb: () => Promise<void>
    checkConfigPlane: () => Promise<void>
  }
}

export interface CreateAppOptions {
  rateLimitPerMinute?: number
  rateLimitMaxBuckets?: number
}

export function createApp(deps: AppDeps, opts: CreateAppOptions = {}) {
  const rateLimitPerMinute = opts.rateLimitPerMinute ?? envInt('RATE_LIMIT_PER_MINUTE', 300)
  const rateLimitMaxBuckets = opts.rateLimitMaxBuckets ?? envInt('RATE_LIMIT_MAX_BUCKETS', 10_000)
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
  app.get('/readyz', async (c) => {
    if (!deps.readiness) return c.json({ ok: true, checks: 'skipped' })
    const { checkDb, checkConfigPlane } = deps.readiness
    const checkNames = ['db', 'configPlane'] as const
    const results = await Promise.allSettled([
      withTimeout(checkDb(), 3000),
      withTimeout(checkConfigPlane(), 3000),
    ])
    const failing = results.flatMap((result, i) => (result.status === 'rejected' ? [checkNames[i]] : []))
    if (failing.length > 0) return c.json({ ok: false, failing }, 503)
    return c.json({ ok: true })
  })
  app.use('/v1/*', cors())
  // Registered before the rate-limit/auth middleware below so it is exempt
  // from both (Hono runs matched handlers in registration order). The
  // pre-serialized body is cacheable since the document never changes at runtime.
  app.get('/v1/openapi.json', (c) =>
    c.body(openApiBody, 200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }),
  )
  // Also auth-free, alongside the openapi.json route above: a human-readable
  // Redoc viewer for the same document.
  app.get('/docs', (c) => c.html(docsHtml))
  app.use('/v1/*', createRateLimiter(rateLimitPerMinute, { maxBuckets: rateLimitMaxBuckets }))
  app.use('/v1/*', authMiddleware(deps.apiKeyStore))
  app.route('/v1/events', eventsRoute(deps))
  app.route('/v1/events', liveEventsRoute(deps))
  app.route('/v1/users', usersRoute(deps))
  app.route('/v1', engagementRoute(deps))
  app.route('/v1/placements', placementsRoute(deps))
  app.route('/v1/offers', offersRoute(deps))
  app.route('/v1/stats', statsRoute(deps))
  app.route('/v1/rewards', rewardsRoute(deps))
  app.route('/v1/coupons', couponsRoute(deps))
  app.onError((err, c) => {
    logger.error({ err, requestId: c.get('requestId') }, 'unhandled error')
    return c.json({ error: { code: 'internal_error', message: 'Internal error.' } }, 500)
  })
  return app
}
