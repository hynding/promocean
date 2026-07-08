import { describe, expect, it, vi } from 'vitest'
import { StrapiConfigPlane } from '../src/index.js'

const achievementsBody = { achievements: [{ id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 }] }
const authBody = { projectId: 'p1', environment: 'test', keyType: 'publishable', allowedOrigins: null }
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

function makePlane(fetchImpl: typeof fetch, cacheTtlMs = 30_000) {
  return new StrapiConfigPlane({ baseUrl: 'http://cms.test', configSecret: 's3cret', cacheTtlMs, fetchImpl })
}

describe('StrapiConfigPlane.getAchievements', () => {
  it('fetches with the secret header and maps definitions', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(achievementsBody))
    const defs = await makePlane(fetchImpl).getAchievements('p1')
    expect(defs).toEqual(achievementsBody.achievements)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://cms.test/api/config-plane/achievements?projectId=p1')
    expect(init.headers['x-config-secret']).toBe('s3cret')
  })
  it('caches within TTL', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(achievementsBody))
    const plane = makePlane(fetchImpl)
    await plane.getAchievements('p1')
    await plane.getAchievements('p1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('serves stale cache when strapi errors', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(achievementsBody))
      .mockImplementation(() => Promise.reject(new Error('down')))
    const plane = makePlane(fetchImpl, 0) // TTL 0: always expired
    await plane.getAchievements('p1')
    const defs = await plane.getAchievements('p1')
    expect(defs).toEqual(achievementsBody.achievements)
  })
  it('throws when strapi errors with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => Promise.reject(new Error('down'))))
    await expect(plane.getAchievements('p1')).rejects.toThrow()
  })
})

describe('StrapiConfigPlane.verifyKey', () => {
  it('hashes the raw key and returns the auth context', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(authBody))
    const auth = await makePlane(fetchImpl).verifyKey('pk_test_demo_1234567890abcdef')
    expect(auth).toEqual(authBody)
    const [, init] = fetchImpl.mock.calls[0]
    const sent = JSON.parse(init.body)
    expect(sent.keyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sent.keyHash).not.toContain('pk_test')
  })
  it('returns null on 404', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 404 })))
    expect(await makePlane(fetchImpl).verifyKey('nope_key_123')).toBeNull()
  })
  it('maps a valid allowedOrigins array through', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok({ ...authBody, allowedOrigins: ['https://a.test', 'https://b.test'] }))
    const auth = await makePlane(fetchImpl).verifyKey('pk_test_demo_1234567890abcdef')
    expect(auth?.allowedOrigins).toEqual(['https://a.test', 'https://b.test'])
  })
  it('maps a junk allowedOrigins value to null', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok({ ...authBody, allowedOrigins: ['ok', 42, null] }))
    const auth = await makePlane(fetchImpl).verifyKey('pk_test_demo_1234567890abcdef')
    expect(auth?.allowedOrigins).toBeNull()
  })
})

const offersBody = {
  offers: [{
    id: 'o1', placementSlug: 'homepage-banner', headline: 'Welcome to Promocean',
    body: null, imageUrl: null, ctaText: 'Learn more', ctaUrl: 'https://example.com',
    startsAt: '2026-07-01T00:00:00.000Z', endsAt: null, priority: 0, timedEventId: null,
  }],
}

describe('StrapiConfigPlane.getOffers', () => {
  it('fetches, maps dates to Date|null, and injects audience', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(offersBody))
    const offers = await makePlane(fetchImpl).getOffers('p1')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/offers?projectId=p1')
    expect(offers[0]).toMatchObject({ id: 'o1', placementSlug: 'homepage-banner', endsAt: null, audience: { kind: 'everyone' }, timedEventId: null })
    expect(offers[0].startsAt).toEqual(new Date('2026-07-01T00:00:00.000Z'))
  })
  it('caches within TTL and serves stale on error', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(offersBody))
      .mockImplementation(() => Promise.reject(new Error('down')))
    const plane = makePlane(fetchImpl, 0)
    await plane.getOffers('p1')
    expect((await plane.getOffers('p1'))[0].id).toBe('o1')
  })
})

const timedEventsBody = {
  events: [{
    id: 1, name: 'Summer Sale', description: null,
    startsAt: '2026-07-01T00:00:00.000Z', endsAt: '2026-07-10T00:00:00.000Z',
    endingSoonMinutes: 60, multiplier: 2, enabled: true,
  }],
}

describe('StrapiConfigPlane.getTimedEvents', () => {
  it('fetches the correct URL and maps ISO strings to Date and enabled to boolean', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(timedEventsBody))
    const events = await makePlane(fetchImpl).getTimedEvents('p1')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/timed-events?projectId=p1')
    expect(events[0]).toMatchObject({
      id: '1', name: 'Summer Sale', description: null,
      endingSoonMinutes: 60, multiplier: 2, enabled: true,
    })
    expect(events[0].startsAt).toEqual(new Date('2026-07-01T00:00:00.000Z'))
    expect(events[0].endsAt).toEqual(new Date('2026-07-10T00:00:00.000Z'))
  })
  it('serves stale cache when strapi errors after a successful fetch', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(timedEventsBody))
      .mockImplementation(() => Promise.reject(new Error('down')))
    const plane = makePlane(fetchImpl, 0) // TTL 0: always expired
    await plane.getTimedEvents('p1')
    const events = await plane.getTimedEvents('p1')
    expect(events[0].id).toBe('1')
  })
})

const allTimedEventsBody = {
  events: [{
    id: 2, projectId: 'p1', name: 'Autumn Sale', description: 'desc',
    startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-10T00:00:00.000Z',
    endingSoonMinutes: 1440, multiplier: 1, enabled: false,
  }],
}

describe('StrapiConfigPlane.getAllTimedEvents', () => {
  it('hits the /all endpoint and passes projectId through on each event', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(allTimedEventsBody))
    const events = await makePlane(fetchImpl).getAllTimedEvents()
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/timed-events/all')
    expect(events[0]).toMatchObject({ id: '2', projectId: 'p1', name: 'Autumn Sale', enabled: false })
  })
})

const webhookEndpointsBody = {
  endpoints: [{ id: 5, url: 'https://hooks.example.com/x', secret: 'whsec_abc', enabled: true }],
}

describe('StrapiConfigPlane.getWebhookEndpoints', () => {
  it('fetches the correct URL and maps fields', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(webhookEndpointsBody))
    const endpoints = await makePlane(fetchImpl).getWebhookEndpoints('p1')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/webhook-endpoints?projectId=p1')
    expect(endpoints[0]).toEqual({ id: '5', url: 'https://hooks.example.com/x', secret: 'whsec_abc', enabled: true })
  })
})
