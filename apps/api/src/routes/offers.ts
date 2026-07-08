import { Hono } from 'hono'
import {
  offerClickRequestSchema, offerImpressionRequestSchema,
  type OfferClickResponse, type OfferImpressionResponse,
} from '@promocean/contracts'
import type { Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'
import { logger } from '../logger.js'

// These routes are reachable with a browser-exposed publishable key, so a config-plane
// outage must not block writes: on getOffers() failure we fail open (treat the offer as
// known and record it) rather than 404, trading strict id validation for availability.
async function isKnownOffer(deps: AppDeps, projectId: string, offerId: string, requestId: string): Promise<boolean> {
  const offers = await deps.configStore.getOffers(projectId).catch(() => null)
  if (offers === null) {
    logger.child({ requestId }).warn({ projectId, offerId }, 'offer config fetch failed; skipping offer id validation')
    return true
  }
  return offers.some((o) => o.id === offerId)
}

export function offersRoute(deps: AppDeps) {
  const app = new Hono()
  app.post('/:id/click', async (c) => {
    const offerId = c.req.param('id')
    if (offerId.length < 1 || offerId.length > 128) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid offer id.' } }, 400)
    }
    const parsed = offerClickRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid click payload.', details: parsed.error.issues } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    if (!(await isKnownOffer(deps, scope.projectId, offerId, c.get('requestId')))) {
      return c.json({ error: { code: 'not_found', message: 'Unknown offer id.' } }, 404)
    }
    await deps.offerMetricsStore.recordClick(scope, offerId, parsed.data.userId ?? null, new Date())
    return c.json({ recorded: true } satisfies OfferClickResponse)
  })
  app.post('/:id/impression', async (c) => {
    const offerId = c.req.param('id')
    if (offerId.length < 1 || offerId.length > 128) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid offer id.' } }, 400)
    }
    const parsed = offerImpressionRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid impression payload.', details: parsed.error.issues } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    if (!(await isKnownOffer(deps, scope.projectId, offerId, c.get('requestId')))) {
      return c.json({ error: { code: 'not_found', message: 'Unknown offer id.' } }, 404)
    }
    await deps.offerMetricsStore.recordImpression(scope, offerId, parsed.data.userId ?? null, new Date(), parsed.data.impressionId)
    return c.json({ recorded: true } satisfies OfferImpressionResponse)
  })
  return app
}
