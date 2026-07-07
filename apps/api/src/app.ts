import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ApiKeyStore, ConfigStore, EventStore, ProgressStore, UsageStore } from '@promocean/core'
import { authMiddleware } from './auth.js'
import { eventsRoute } from './routes/events.js'
import { usersRoute } from './routes/users.js'

export interface AppDeps {
  configStore: ConfigStore
  apiKeyStore: ApiKeyStore
  eventStore: EventStore
  progressStore: ProgressStore
  usageStore: UsageStore
}

export function createApp(deps: AppDeps) {
  const app = new Hono()
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.use('/v1/*', cors())
  app.use('/v1/*', authMiddleware(deps.apiKeyStore))
  app.route('/v1/events', eventsRoute(deps))
  app.route('/v1/users', usersRoute(deps))
  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: { code: 'internal_error', message: 'Internal error.' } }, 500)
  })
  return app
}
