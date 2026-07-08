import { Hono } from 'hono'
import type { PlacementOfferResponse } from '@promocean/contracts'
import { PLACEMENT_SLUG_PATTERN } from '@promocean/contracts'
import { activeEventIds, resolveOffer, type Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'
import { logger } from '../logger.js'

export function placementsRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/:slug/offer', async (c) => {
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const slug = c.req.param('slug')
    const userId = c.req.query('userId') ?? null
    if (!PLACEMENT_SLUG_PATTERN.test(slug) || slug.length > 64) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid placement slug.' } }, 400)
    }
    if (userId !== null && (userId.length < 1 || userId.length > 128)) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid userId.' } }, 400)
    }
    const offers = await deps.configStore.getOffers(scope.projectId)
    const now = new Date()
    let active: ReadonlySet<string> = new Set<string>()
    try {
      active = activeEventIds(await deps.configStore.getTimedEvents(scope.projectId), now)
    } catch (err) {
      logger.warn({ err }, 'timed events fetch failed; event-attached offers hidden')
    }
    const offer = resolveOffer(slug, offers, now, active)
    return c.json({
      offer: offer
        ? { offerId: offer.id, headline: offer.headline, body: offer.body, imageUrl: offer.imageUrl, ctaText: offer.ctaText, ctaUrl: offer.ctaUrl }
        : null,
    } satisfies PlacementOfferResponse)
  })
  return app
}
