import { describe, expect, it } from 'vitest'
import { resolveOffer, type OfferDefinition } from '../src/index.js'

const base = {
  headline: 'x', body: null, imageUrl: null, ctaText: null, ctaUrl: null,
  priority: 0, audience: { kind: 'everyone' as const },
}
const now = new Date('2026-07-15T12:00:00Z')
const offers: OfferDefinition[] = [
  { ...base, id: 'evergreen', placementSlug: 'homepage-banner', startsAt: null, endsAt: null },
  { ...base, id: 'past', placementSlug: 'homepage-banner', startsAt: new Date('2026-06-01T00:00:00Z'), endsAt: new Date('2026-06-30T00:00:00Z') },
  { ...base, id: 'future', placementSlug: 'homepage-banner', startsAt: new Date('2026-08-01T00:00:00Z'), endsAt: null },
  { ...base, id: 'live-priority', placementSlug: 'homepage-banner', startsAt: new Date('2026-07-01T00:00:00Z'), endsAt: new Date('2026-08-01T00:00:00Z'), priority: 10 },
  { ...base, id: 'other-slot', placementSlug: 'sidebar', startsAt: null, endsAt: null },
]

describe('resolveOffer', () => {
  it('returns the highest-priority active offer for the placement', () => {
    expect(resolveOffer('homepage-banner', offers, now)?.id).toBe('live-priority')
  })
  it('excludes past, future, and other-placement offers', () => {
    const active = resolveOffer('sidebar', offers, now)
    expect(active?.id).toBe('other-slot')
    expect(resolveOffer('homepage-banner', offers, new Date('2026-09-01T00:00:00Z'))?.id).toBe('evergreen')
  })
  it('treats endsAt as exclusive and startsAt as inclusive', () => {
    expect(resolveOffer('homepage-banner', [offers[3]], new Date('2026-08-01T00:00:00Z'))).toBeNull()
    expect(resolveOffer('homepage-banner', [offers[3]], new Date('2026-07-01T00:00:00Z'))?.id).toBe('live-priority')
  })
  it('returns null when nothing matches', () => {
    expect(resolveOffer('nonexistent', offers, now)).toBeNull()
  })
})
