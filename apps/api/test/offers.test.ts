import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { logger } from '../src/logger.js'
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
  it('resolves the active offer and records no impression server-side', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/placements/homepage-banner/offer?userId=u1', { headers })
    expect(res.status).toBe(200)
    expect((await res.json()).offer).toMatchObject({ offerId: 'o1', headline: 'Welcome to Promocean' })
    expect(fakes.metrics.impressions).toEqual([])
  })
  it('returns null offer for an empty placement and records nothing', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/placements/sidebar/offer', { headers })
    expect((await res.json()).offer).toBeNull()
    expect(fakes.metrics.impressions).toEqual([])
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
  it('fails open (empty active-events set) and logs via a child logger carrying the request id when getTimedEvents throws', async () => {
    const { app, fakes } = setup()
    fakes.configStore.getTimedEvents = async () => { throw new Error('config plane down') }
    const childSpy = vi.spyOn(logger, 'child')
    const res = await app.request('/v1/placements/homepage-banner/offer?userId=u1', { headers })
    expect(res.status).toBe(200)
    expect(childSpy).toHaveBeenCalledWith({ requestId: expect.any(String) })
    childSpy.mockRestore()
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
  it('rejects an unknown offer id with 404 and records nothing', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/offers/unknown-offer/click', { method: 'POST', headers, body: JSON.stringify({}) })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toEqual({ code: 'not_found', message: 'Unknown offer id.' })
    expect(fakes.metrics.clicks).toEqual([])
  })
  it('fails open and records when the config store errors', async () => {
    const { app, fakes } = setup()
    fakes.configStore.getOffers = async () => { throw new Error('config plane down') }
    const res = await app.request('/v1/offers/o1/click', { method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recorded: true })
    expect(fakes.metrics.clicks).toEqual([{ offerId: 'o1', userId: 'u1' }])
  })
  it('logs the config fetch failure via a child logger carrying the request id', async () => {
    const { app, fakes } = setup()
    fakes.configStore.getOffers = async () => { throw new Error('config plane down') }
    const childSpy = vi.spyOn(logger, 'child')
    const res = await app.request('/v1/offers/o1/click', { method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }) })
    expect(res.status).toBe(200)
    expect(childSpy).toHaveBeenCalledWith({ requestId: expect.any(String) })
    childSpy.mockRestore()
  })
})

describe('POST /v1/offers/:id/impression', () => {
  const impressionId = '11111111-1111-4111-8111-111111111111'

  it('records an impression with optional user attribution', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/offers/o1/impression', {
      method: 'POST', headers, body: JSON.stringify({ impressionId, userId: 'u1' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recorded: true })
    expect(fakes.metrics.impressions).toEqual([{ offerId: 'o1', userId: 'u1' }])
  })

  it('is idempotent on a duplicate impressionId', async () => {
    const { app, fakes } = setup()
    const body = JSON.stringify({ impressionId, userId: 'u1' })
    const first = await app.request('/v1/offers/o1/impression', { method: 'POST', headers, body })
    const second = await app.request('/v1/offers/o1/impression', { method: 'POST', headers, body })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ recorded: true })
    expect(fakes.metrics.impressions).toEqual([{ offerId: 'o1', userId: 'u1' }])
  })

  it('rejects a non-uuid impressionId', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/offers/o1/impression', {
      method: 'POST', headers, body: JSON.stringify({ impressionId: 'not-a-uuid' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
    expect(fakes.metrics.impressions).toEqual([])
  })

  it('rejects an oversized offer id', async () => {
    const { app, fakes } = setup()
    const res = await app.request(`/v1/offers/${'x'.repeat(129)}/impression`, {
      method: 'POST', headers, body: JSON.stringify({ impressionId }),
    })
    expect(res.status).toBe(400)
    expect(fakes.metrics.impressions).toEqual([])
  })

  it('rejects an unknown offer id with 404 and records nothing', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/offers/unknown-offer/impression', {
      method: 'POST', headers, body: JSON.stringify({ impressionId }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toEqual({ code: 'not_found', message: 'Unknown offer id.' })
    expect(fakes.metrics.impressions).toEqual([])
  })

  it('fails open and records when the config store errors', async () => {
    const { app, fakes } = setup()
    fakes.configStore.getOffers = async () => { throw new Error('config plane down') }
    const res = await app.request('/v1/offers/o1/impression', {
      method: 'POST', headers, body: JSON.stringify({ impressionId, userId: 'u1' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recorded: true })
    expect(fakes.metrics.impressions).toEqual([{ offerId: 'o1', userId: 'u1' }])
  })
})
