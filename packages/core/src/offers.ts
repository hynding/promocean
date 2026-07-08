import type { OfferDefinition } from './types.js'

/**
 * Resolves the single offer to show for a placement at a given instant.
 *
 * Determinism guarantee: when multiple active offers tie on priority, the one with the
 * lexicographically smallest id wins, regardless of the order offers are passed in. This
 * makes resolution a pure function of (placement, offer set, time) — the same inputs always
 * produce the same output, independent of iteration/storage order.
 */
export function resolveOffer(
  placementSlug: string,
  offers: OfferDefinition[],
  now: Date,
  activeEvents?: ReadonlySet<string>,
): OfferDefinition | null {
  let best: OfferDefinition | null = null
  for (const offer of offers) {
    if (offer.placementSlug !== placementSlug) continue
    if (offer.timedEventId !== null && !activeEvents?.has(offer.timedEventId)) continue
    if (offer.startsAt && offer.startsAt > now) continue
    if (offer.endsAt && offer.endsAt <= now) continue
    if (!best || offer.priority > best.priority || (offer.priority === best.priority && offer.id < best.id)) best = offer
  }
  return best
}
