import { Hono } from 'hono'
import type { PlacementOfferResponse } from '@promocean/contracts'
import { resolveOffer, type Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function placementsRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/:slug/offer', async (c) => {
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const slug = c.req.param('slug')
    const userId = c.req.query('userId') ?? null
    const offers = await deps.configStore.getOffers(scope.projectId)
    const offer = resolveOffer(slug, offers, new Date())
    if (offer) {
      try {
        await deps.offerMetricsStore.recordImpression(scope, offer.id, userId, new Date())
      } catch (err) {
        console.error('impression recording failed', err)
      }
    }
    return c.json({
      offer: offer
        ? { offerId: offer.id, headline: offer.headline, body: offer.body, imageUrl: offer.imageUrl, ctaText: offer.ctaText, ctaUrl: offer.ctaUrl }
        : null,
    } satisfies PlacementOfferResponse)
  })
  return app
}
