import { describe, expect, it } from 'vitest'
import {
  offerCreativeSchema,
  placementOfferResponseSchema,
  offerClickRequestSchema,
  PLACEMENT_SLUG_PATTERN,
} from '../src/index.js'

const creative = {
  offerId: 'o1', headline: 'Go Pro', body: null, imageUrl: null, ctaText: 'Upgrade', ctaUrl: 'https://example.com/pro',
}

describe('offer schemas', () => {
  it('round-trips a creative', () => {
    expect(offerCreativeSchema.parse(creative)).toEqual(creative)
  })
  it('placement response allows null offer', () => {
    expect(placementOfferResponseSchema.parse({ offer: null })).toEqual({ offer: null })
    expect(placementOfferResponseSchema.parse({ offer: creative }).offer?.offerId).toBe('o1')
  })
  it('click request userId is optional but non-empty when present', () => {
    expect(offerClickRequestSchema.safeParse({}).success).toBe(true)
    expect(offerClickRequestSchema.safeParse({ userId: 'u1' }).success).toBe(true)
    expect(offerClickRequestSchema.safeParse({ userId: '' }).success).toBe(false)
  })
  it('placement slug pattern is kebab-case', () => {
    expect(PLACEMENT_SLUG_PATTERN.test('homepage-banner')).toBe(true)
    for (const bad of ['Homepage', 'home_page', '9lives', '']) expect(PLACEMENT_SLUG_PATTERN.test(bad)).toBe(false)
  })
})
