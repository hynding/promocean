import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { StrapiConfigPlane } from '../src/index.js'

const achievementsBody = { achievements: [{ id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1, pointsValue: 10 }] }
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
  it('throws on a malformed body (schema mismatch) with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => ok({ achievements: [{ id: 'a1' }] })))
    await expect(plane.getAchievements('p1')).rejects.toThrow()
  })
  it('serves stale cache when a later response fails validation', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(achievementsBody))
      .mockImplementation(() => ok({ achievements: 'not-an-array' }))
    const plane = makePlane(fetchImpl, 0) // TTL 0: always expired
    await plane.getAchievements('p1')
    const defs = await plane.getAchievements('p1')
    expect(defs).toEqual(achievementsBody.achievements)
  })
  it('parses pointsValue through when present', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(achievementsBody))
    const defs = await makePlane(fetchImpl).getAchievements('p1')
    expect(defs[0].pointsValue).toBe(10)
  })
  it('defaults pointsValue to 0 when absent from the response', async () => {
    const body = { achievements: [{ id: 'a2', name: 'No Points Yet', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 }] }
    const fetchImpl = vi.fn().mockImplementation(() => ok(body))
    const defs = await makePlane(fetchImpl).getAchievements('p1')
    expect(defs[0].pointsValue).toBe(0)
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
  it('returns null (not a corrupt AuthContext) on a bad keyType enum', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok({ ...authBody, keyType: 'bogus' }))
    const auth = await makePlane(fetchImpl).verifyKey('pk_test_demo_1234567890abcdef')
    expect(auth).toBeNull()
  })
  it('returns null (not a corrupt AuthContext) on a bad environment enum', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok({ ...authBody, environment: 'staging' }))
    const auth = await makePlane(fetchImpl).verifyKey('pk_test_demo_1234567890abcdef')
    expect(auth).toBeNull()
  })
  it('warns on a malformed verify-key response body', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fetchImpl = vi.fn().mockImplementation(() => ok({ ...authBody, keyType: 'bogus' }))
      const auth = await makePlane(fetchImpl).verifyKey('pk_test_demo_1234567890abcdef')
      expect(auth).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toContain('verify-key response failed validation')
    } finally {
      warnSpy.mockRestore()
    }
  })
  it('caches a resolved key within TTL', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(authBody))
    const plane = makePlane(fetchImpl)
    await plane.verifyKey('pk_test_demo_1234567890abcdef')
    await plane.verifyKey('pk_test_demo_1234567890abcdef')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('serves the stale cached auth context when strapi errors after expiry', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(authBody))
      .mockImplementation(() => Promise.reject(new Error('down')))
    const plane = makePlane(fetchImpl, 0) // TTL 0: always expired
    await plane.verifyKey('pk_test_demo_1234567890abcdef')
    const auth = await plane.verifyKey('pk_test_demo_1234567890abcdef')
    expect(auth).toEqual(authBody)
  })
  it('does not cache a non-404 error response', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 500 })))
    const plane = makePlane(fetchImpl)
    await expect(plane.verifyKey('pk_test_demo_1234567890abcdef')).rejects.toThrow()
    await expect(plane.verifyKey('pk_test_demo_1234567890abcdef')).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('StrapiConfigPlane.verifyKey negative auth-cache bound', () => {
  it('evicts the oldest cached null result once at maxNegativeAuthEntries; the evicted key re-fetches', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 404 })))
    const plane = new StrapiConfigPlane({
      baseUrl: 'http://cms.test', configSecret: 's3cret', fetchImpl, maxNegativeAuthEntries: 3,
    })

    await plane.verifyKey('key-0')
    await plane.verifyKey('key-1')
    await plane.verifyKey('key-2')
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    // key-1 and key-2 are still cached (no extra fetches).
    await plane.verifyKey('key-1')
    await plane.verifyKey('key-2')
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    // 4th distinct null key: at cap, evicts key-0 (the oldest).
    await plane.verifyKey('key-3')
    expect(fetchImpl).toHaveBeenCalledTimes(4)

    // key-0 was evicted -> re-fetches. Re-caching it null now evicts key-1 (the new
    // oldest at cap 3: key-1, key-2, key-3), not key-2 or key-3.
    await plane.verifyKey('key-0')
    expect(fetchImpl).toHaveBeenCalledTimes(5)

    // key-2 and key-3 remain cached (unaffected by key-0's re-insertion).
    await plane.verifyKey('key-2')
    await plane.verifyKey('key-3')
    expect(fetchImpl).toHaveBeenCalledTimes(5)
  })

  it('does not evict positive entries under negative-cache eviction pressure', async () => {
    const goodKeyHash = createHash('sha256').update('good-key').digest('hex')
    const fetchImpl = vi.fn().mockImplementation((_url: unknown, init: { body: string }) => {
      const { keyHash } = JSON.parse(init.body) as { keyHash: string }
      if (keyHash === goodKeyHash) return ok(authBody)
      return Promise.resolve(new Response('', { status: 404 }))
    })
    const plane = new StrapiConfigPlane({
      baseUrl: 'http://cms.test', configSecret: 's3cret', fetchImpl, maxNegativeAuthEntries: 2,
    })

    await plane.verifyKey('good-key') // positive, cached
    await plane.verifyKey('bad-1') // null (1/2)
    await plane.verifyKey('bad-2') // null (2/2, at cap)
    await plane.verifyKey('bad-3') // null: evicts bad-1, positive entry untouched
    const callsSoFar = fetchImpl.mock.calls.length
    expect(callsSoFar).toBe(4)

    const goodAgain = await plane.verifyKey('good-key')
    expect(goodAgain).toEqual(authBody)
    expect(fetchImpl).toHaveBeenCalledTimes(callsSoFar) // still cached, no extra fetch
  })

  it('drops a key from null-eviction tracking once it resolves positive, so it is not evicted like a stale null', async () => {
    vi.useFakeTimers()
    try {
      const n0Hash = createHash('sha256').update('n0').digest('hex')
      let n0Positive = false
      const fetchImpl = vi.fn().mockImplementation((_url: unknown, init: { body: string }) => {
        const { keyHash } = JSON.parse(init.body) as { keyHash: string }
        if (keyHash === n0Hash && n0Positive) return ok(authBody)
        return Promise.resolve(new Response('', { status: 404 }))
      })
      const plane = new StrapiConfigPlane({
        baseUrl: 'http://cms.test', configSecret: 's3cret', fetchImpl, maxNegativeAuthEntries: 2, cacheTtlMs: 1000,
      })

      await plane.verifyKey('n0') // null, null-set: [n0]
      await plane.verifyKey('n1') // null, null-set: [n0, n1] (at cap)

      // Expire n0's entry and have it resolve positive on refetch: it should drop
      // out of null tracking.
      vi.advanceTimersByTime(1001)
      n0Positive = true
      expect(await plane.verifyKey('n0')).toEqual(authBody) // null-set: [n1]

      await plane.verifyKey('n2') // null, null-set: [n1, n2]
      await plane.verifyKey('n3') // null: evicts n1 (oldest remaining null), null-set: [n2, n3]
      expect(fetchImpl).toHaveBeenCalledTimes(5)

      // n0's positive entry must still be cached (not evicted) within its TTL.
      const callsBeforeRecheck = fetchImpl.mock.calls.length
      expect(await plane.verifyKey('n0')).toEqual(authBody)
      expect(fetchImpl).toHaveBeenCalledTimes(callsBeforeRecheck)
    } finally {
      vi.useRealTimers()
    }
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
  it('throws on a malformed body with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => ok({ offers: [{ id: 'o1' }] })))
    await expect(plane.getOffers('p1')).rejects.toThrow()
  })
})

const timedEventsBody = {
  events: [{
    id: '1', name: 'Summer Sale', description: null,
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
  it('throws on a malformed body with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => ok({ events: [{ id: '1' }] })))
    await expect(plane.getTimedEvents('p1')).rejects.toThrow()
  })
})

const allTimedEventsBody = {
  events: [{
    id: '2', projectId: 'p1', name: 'Autumn Sale', description: 'desc',
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
  it('throws on a malformed body with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => ok({ events: [{ id: '2' }] })))
    await expect(plane.getAllTimedEvents()).rejects.toThrow()
  })
  it('omits endedWithinMinutes when allTimedEventsEndedWithinMinutes is not configured', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(allTimedEventsBody))
    const plane = new StrapiConfigPlane({ baseUrl: 'http://cms.test', configSecret: 's3cret', fetchImpl })
    await plane.getAllTimedEvents()
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/timed-events/all')
  })
  it('appends endedWithinMinutes when allTimedEventsEndedWithinMinutes is configured', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(allTimedEventsBody))
    const plane = new StrapiConfigPlane({
      baseUrl: 'http://cms.test', configSecret: 's3cret', fetchImpl, allTimedEventsEndedWithinMinutes: 60,
    })
    await plane.getAllTimedEvents()
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/timed-events/all?endedWithinMinutes=60')
  })
})

const webhookEndpointsBody = {
  endpoints: [{ id: '5', url: 'https://hooks.example.com/x', secret: 'whsec_abc', enabled: true }],
}

describe('StrapiConfigPlane.getWebhookEndpoints', () => {
  it('fetches the correct URL and maps fields', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(webhookEndpointsBody))
    const endpoints = await makePlane(fetchImpl).getWebhookEndpoints('p1')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/webhook-endpoints?projectId=p1')
    expect(endpoints[0]).toEqual({ id: '5', url: 'https://hooks.example.com/x', secret: 'whsec_abc', enabled: true })
  })
  it('throws on a malformed body with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => ok({ endpoints: [{ id: '5' }] })))
    await expect(plane.getWebhookEndpoints('p1')).rejects.toThrow()
  })
})

const eventTypesBody = { eventTypes: ['lesson_completed', 'quiz_passed'] }

describe('StrapiConfigPlane.getRegisteredEventTypes', () => {
  it('fetches the correct URL with the secret header and returns the event types', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(eventTypesBody))
    const eventTypes = await makePlane(fetchImpl).getRegisteredEventTypes('p1')
    expect(eventTypes).toEqual(['lesson_completed', 'quiz_passed'])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://cms.test/api/config-plane/projects/p1/event-types')
    expect(init.headers['x-config-secret']).toBe('s3cret')
  })
  it('caches within TTL (one fetch for two calls)', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(eventTypesBody))
    const plane = makePlane(fetchImpl)
    await plane.getRegisteredEventTypes('p1')
    await plane.getRegisteredEventTypes('p1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('serves stale cache when strapi errors after expiry', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(eventTypesBody))
      .mockImplementation(() => Promise.reject(new Error('down')))
    const plane = makePlane(fetchImpl, 0)
    await plane.getRegisteredEventTypes('p1')
    const eventTypes = await plane.getRegisteredEventTypes('p1')
    expect(eventTypes).toEqual(['lesson_completed', 'quiz_passed'])
  })
  it('throws on a malformed body with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => ok({ eventTypes: 'not-an-array' })))
    await expect(plane.getRegisteredEventTypes('p1')).rejects.toThrow()
  })
})

const pointRulesBody = { pointRules: { lesson_completed: 10, quiz_passed: 5 } }

describe('StrapiConfigPlane.getPointRules', () => {
  it('fetches the correct URL with the secret header and returns the point rules', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(pointRulesBody))
    const pointRules = await makePlane(fetchImpl).getPointRules('p1')
    expect(pointRules).toEqual({ lesson_completed: 10, quiz_passed: 5 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://cms.test/api/config-plane/projects/p1/point-rules')
    expect(init.headers['x-config-secret']).toBe('s3cret')
  })
  it('caches within TTL (one fetch for two calls)', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(pointRulesBody))
    const plane = makePlane(fetchImpl)
    await plane.getPointRules('p1')
    await plane.getPointRules('p1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('serves stale cache when a malformed body fails validation after expiry', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(pointRulesBody))
      .mockImplementation(() => ok({ pointRules: 'not-an-object' }))
    const plane = makePlane(fetchImpl, 0) // TTL 0: always expired
    await plane.getPointRules('p1')
    const pointRules = await plane.getPointRules('p1')
    expect(pointRules).toEqual({ lesson_completed: 10, quiz_passed: 5 })
  })
  it('throws when strapi errors with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => Promise.reject(new Error('down'))))
    await expect(plane.getPointRules('p1')).rejects.toThrow()
  })
  it('drops non-integer and negative entries as defense in depth', async () => {
    const body = { pointRules: { lesson_completed: 10, fractional: 1.5, negative: -3, zero: 0 } }
    const fetchImpl = vi.fn().mockImplementation(() => ok(body))
    const pointRules = await makePlane(fetchImpl).getPointRules('p1')
    expect(pointRules).toEqual({ lesson_completed: 10, zero: 0 })
  })
})

const rewardsBody = {
  rewards: [
    {
      id: 'r1', slug: 'free-coffee', name: 'Free Coffee', description: 'On the house',
      codeType: 'generated', staticCode: null, codePrefix: 'COFFEE',
      pointsPrice: 100, startsAt: '2026-07-01T00:00:00.000Z', endsAt: null,
      perUserLimit: 1, inventory: 50, enabled: true,
    },
    {
      id: 'r2', slug: 'welcome-discount', name: 'Welcome Discount', description: null,
      codeType: 'static', staticCode: 'WELCOME10', codePrefix: null,
      pointsPrice: 0, startsAt: null, endsAt: null,
      perUserLimit: 1, inventory: null, enabled: true,
    },
  ],
}

describe('StrapiConfigPlane.getRewards', () => {
  it('fetches the correct URL and maps both codeTypes with dates', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(rewardsBody))
    const rewards = await makePlane(fetchImpl).getRewards('p1')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/rewards?projectId=p1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://cms.test/api/config-plane/rewards?projectId=p1')
    expect(init.headers['x-config-secret']).toBe('s3cret')

    expect(rewards[0]).toMatchObject({
      id: 'r1', slug: 'free-coffee', name: 'Free Coffee', description: 'On the house',
      codeType: 'generated', staticCode: null, codePrefix: 'COFFEE',
      pointsPrice: 100, endsAt: null, perUserLimit: 1, inventory: 50, enabled: true,
    })
    expect(rewards[0].startsAt).toEqual(new Date('2026-07-01T00:00:00.000Z'))

    expect(rewards[1]).toMatchObject({
      id: 'r2', slug: 'welcome-discount', codeType: 'static', staticCode: 'WELCOME10',
      codePrefix: null, pointsPrice: 0, perUserLimit: 1, inventory: null, enabled: true,
    })
    expect(rewards[1].startsAt).toBeNull()
    expect(rewards[1].endsAt).toBeNull()
  })
  it('carries the staticCode through for a static reward', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(rewardsBody))
    const rewards = await makePlane(fetchImpl).getRewards('p1')
    const staticReward = rewards.find((r) => r.codeType === 'static')
    expect(staticReward?.staticCode).toBe('WELCOME10')
  })
  it('caches within TTL (one fetch for two calls)', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(rewardsBody))
    const plane = makePlane(fetchImpl)
    await plane.getRewards('p1')
    await plane.getRewards('p1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('serves stale cache when a malformed body fails validation after expiry', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(rewardsBody))
      .mockImplementation(() => ok({ rewards: [{ id: 'r1' }] }))
    const plane = makePlane(fetchImpl, 0) // TTL 0: always expired
    await plane.getRewards('p1')
    const rewards = await plane.getRewards('p1')
    expect(rewards.map((r) => r.id)).toEqual(['r1', 'r2'])
  })
  it('throws on a malformed body with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => ok({ rewards: [{ id: 'r1' }] })))
    await expect(plane.getRewards('p1')).rejects.toThrow()
  })
})
