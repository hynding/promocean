import type { OfferDefinition } from './types.js'

export function resolveOffer(
  placementSlug: string,
  offers: OfferDefinition[],
  now: Date,
): OfferDefinition | null {
  let best: OfferDefinition | null = null
  for (const offer of offers) {
    if (offer.placementSlug !== placementSlug) continue
    if (offer.startsAt && offer.startsAt > now) continue
    if (offer.endsAt && offer.endsAt <= now) continue
    if (!best || offer.priority > best.priority) best = offer
  }
  return best
}
