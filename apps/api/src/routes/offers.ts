import { Hono } from 'hono'
import { offerClickRequestSchema, type OfferClickResponse } from '@promocean/contracts'
import type { Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function offersRoute(deps: AppDeps) {
  const app = new Hono()
  app.post('/:id/click', async (c) => {
    const parsed = offerClickRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid click payload.', details: parsed.error.issues } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    await deps.offerMetricsStore.recordClick(scope, c.req.param('id'), parsed.data.userId ?? null, new Date())
    return c.json({ recorded: true } satisfies OfferClickResponse)
  })
  return app
}
