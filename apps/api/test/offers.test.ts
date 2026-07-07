import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

const offer = {
  id: 'o1', placementSlug: 'homepage-banner', headline: 'Welcome to Promocean',
  body: null, imageUrl: null, ctaText: 'Learn more', ctaUrl: 'https://example.com',
  startsAt: null, endsAt: null, priority: 0, audience: { kind: 'everyone' as const }, timedEventId: null,
}
const auth = { projectId: 'p1', environment: 'test' as const, keyType: 'publishable' as const }
const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }

function setup() {
  const fakes = makeFakes([], auth, [offer])
  return { app: createApp(fakes), fakes }
}

describe('GET /v1/placements/:slug/offer', () => {
  it('resolves the active offer and records an attributed impression', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/placements/homepage-banner/offer?userId=u1', { headers })
    expect(res.status).toBe(200)
    expect((await res.json()).offer).toMatchObject({ offerId: 'o1', headline: 'Welcome to Promocean' })
    expect(fakes.metrics.impressions).toEqual([{ offerId: 'o1', userId: 'u1' }])
  })
  it('returns null offer for an empty placement and records nothing', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/placements/sidebar/offer', { headers })
    expect((await res.json()).offer).toBeNull()
    expect(fakes.metrics.impressions).toEqual([])
  })
  it('still returns the offer if impression recording throws', async () => {
    const { app, fakes } = setup()
    fakes.offerMetricsStore.recordImpression = async () => { throw new Error('db down') }
    const res = await app.request('/v1/placements/homepage-banner/offer', { headers })
    expect(res.status).toBe(200)
    expect((await res.json()).offer?.offerId).toBe('o1')
  })
  it('rejects an invalid placement slug', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/placements/Bad_Slug!/offer', { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
    expect(fakes.metrics.impressions).toEqual([])
  })
  it('rejects an oversized userId query param', async () => {
    const { app } = setup()
    const res = await app.request(`/v1/placements/homepage-banner/offer?userId=${'x'.repeat(129)}`, { headers })
    expect(res.status).toBe(400)
  })
})

describe('POST /v1/offers/:id/click', () => {
  it('records a click with optional user attribution', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/offers/o1/click', { method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }) })
    expect((await res.json())).toEqual({ recorded: true })
    expect(fakes.metrics.clicks).toEqual([{ offerId: 'o1', userId: 'u1' }])
  })
  it('rejects an invalid body', async () => {
    const { app } = setup()
    const res = await app.request('/v1/offers/o1/click', { method: 'POST', headers, body: JSON.stringify({ userId: '' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })
  it('rejects an oversized offer id', async () => {
    const { app, fakes } = setup()
    const res = await app.request(`/v1/offers/${'x'.repeat(129)}/click`, { method: 'POST', headers, body: JSON.stringify({}) })
    expect(res.status).toBe(400)
    expect(fakes.metrics.clicks).toEqual([])
  })
})
