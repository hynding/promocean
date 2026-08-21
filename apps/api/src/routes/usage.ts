import { Hono } from 'hono'
import { usageQuerySchema, type UsageResponse } from '@promocean/contracts'
import { evaluateUsage, type Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

/**
 * GET /v1/usage — the metering read model for billing/limits (sk only, like /v1/stats).
 * `mau`/`events` describe the authenticated environment's usage for the month; the plan
 * fields (`mauIncluded`/`percentUsed`/`overLimit`) are always evaluated against the LIVE
 * environment's MAU, because only live usage counts toward a plan's cap (test is free).
 */
export function usageRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/', async (c) => {
    const auth = c.get('auth')
    if (auth.keyType !== 'secret') {
      return c.json({ error: { code: 'forbidden', message: 'Secret key required.' } }, 403)
    }

    const parsed = usageQuerySchema.safeParse({ month: c.req.query('month') })
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid query.', details: parsed.error.issues } }, 400)
    }
    const month = parsed.data.month ?? new Date().toISOString().slice(0, 7)

    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const usage = await deps.usageStore.getUsage(scope, month)
    const liveUsage = auth.environment === 'live'
      ? usage
      : await deps.usageStore.getUsage({ projectId: auth.projectId, environment: 'live' }, month)
    const evaluated = evaluateUsage(auth.plan ?? null, liveUsage.mau)

    return c.json({
      month,
      environment: auth.environment,
      mau: usage.mau,
      events: usage.events,
      plan: auth.plan ?? null,
      mauIncluded: evaluated.mauIncluded,
      percentUsed: evaluated.percentUsed,
      overLimit: evaluated.overLimit,
    } satisfies UsageResponse)
  })
  return app
}
