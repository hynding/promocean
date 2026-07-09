import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext } from '@promocean/core'
import { createApp } from '../src/app.js'
import { createRateLimiter } from '../src/rate-limit.js'
import { makeFakes } from './fakes.js'

const defs = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 },
]
const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }

function pkAuth(allowedOrigins: string[] | null = null): AuthContext {
  return { projectId: 'p1', environment: 'test', keyType: 'publishable', allowedOrigins }
}
function skAuth(allowedOrigins: string[] | null = null): AuthContext {
  return { projectId: 'p1', environment: 'test', keyType: 'secret', allowedOrigins }
}

describe('rate limiting', () => {
  it('allows requests under the limit', async () => {
    const app = createApp(makeFakes(defs, pkAuth()), { rateLimitPerMinute: 2 })
    const res1 = await app.request('/v1/users/u1/achievements', { headers })
    const res2 = await app.request('/v1/users/u1/achievements', { headers })
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
  })

  it('rejects the request over the limit with 429 and a retry-after header', async () => {
    const app = createApp(makeFakes(defs, pkAuth()), { rateLimitPerMinute: 2 })
    await app.request('/v1/users/u1/achievements', { headers })
    await app.request('/v1/users/u1/achievements', { headers })
    const res3 = await app.request('/v1/users/u1/achievements', { headers })
    expect(res3.status).toBe(429)
    const json = await res3.json()
    expect(json.error.code).toBe('rate_limited')
    expect(res3.headers.get('retry-after')).toBeTruthy()
    expect(Number(res3.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('is disabled when limitPerMinute is 0', async () => {
    const app = createApp(makeFakes(defs, pkAuth()), { rateLimitPerMinute: 0 })
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/v1/users/u1/achievements', { headers })
      expect(res.status).toBe(200)
    }
  })

  it('keys the limit per bearer token, not globally', async () => {
    const app = createApp(makeFakes(defs, pkAuth()), { rateLimitPerMinute: 1 })
    const res1 = await app.request('/v1/users/u1/achievements', { headers })
    expect(res1.status).toBe(200)
    // a different (invalid) token gets its own bucket; still 401 (auth runs after rate limiter) not 429
    const res2 = await app.request('/v1/users/u1/achievements', { headers: { ...headers, authorization: 'Bearer other_key' } })
    expect(res2.status).toBe(401)
  })
})

describe('rate limiter bucket bounds', () => {
  function buildApp(limiter: ReturnType<typeof createRateLimiter>) {
    const app = new Hono()
    app.use('*', limiter)
    app.get('/', (c) => c.text('ok'))
    return app
  }

  it('sweeps expired buckets on the requester bucket rollover instead of growing forever', async () => {
    let now = 0
    const limiter = createRateLimiter(10, { now: () => now, maxBuckets: 50 })
    const app = buildApp(limiter)

    // Window 1: 5 distinct keys, one request each.
    for (let i = 0; i < 5; i++) {
      await app.request('/', { headers: { authorization: `Bearer key-${i}` } })
    }
    expect(limiter._bucketCount()).toBe(5)

    // Advance past the window; a request from a pre-existing key (key-0) rolls its own
    // bucket over, which triggers the lazy sweep of the 5 now-expired buckets.
    now = 61_000
    await app.request('/', { headers: { authorization: 'Bearer key-0' } })
    expect(limiter._bucketCount()).toBe(1)
  })

  it('does not sweep buckets during new-key ramp-up; sweep only fires on pre-existing-bucket rollover', async () => {
    let now = 0
    const limiter = createRateLimiter(10, { now: () => now, maxBuckets: 50 })
    const app = buildApp(limiter)

    // Window 1: Add 5 distinct keys. Each is a new-key creation (no sweep).
    for (let i = 0; i < 5; i++) {
      await app.request('/', { headers: { authorization: `Bearer key-${i}` } })
      // Bucket count should grow monotonically; no sweep has happened.
      expect(limiter._bucketCount()).toBe(i + 1)
    }

    // Advance past the window.
    now = 61_000

    // Add a new key in the new window. This is also a new-key creation (no sweep).
    await app.request('/', { headers: { authorization: 'Bearer key-new-a' } })
    // The old 5 buckets are still present; we're at 6. No sweep has fired.
    expect(limiter._bucketCount()).toBe(6)

    // Now cause a pre-existing key (key-0) to roll over. This triggers the sweep.
    await app.request('/', { headers: { authorization: 'Bearer key-0' } })
    // After the sweep, the 5 expired buckets should be gone, leaving key-0 and key-new-a.
    expect(limiter._bucketCount()).toBe(2)
  })

  it('shares a single overflow bucket for new keys once at cap, still enforcing the limit (never unlimited, never hard-denied)', async () => {
    let now = 0
    const limiter = createRateLimiter(1, { now: () => now, maxBuckets: 2 })
    const app = buildApp(limiter)

    // Fill the cap with two distinct keys.
    await app.request('/', { headers: { authorization: 'Bearer key-a' } })
    await app.request('/', { headers: { authorization: 'Bearer key-b' } })
    expect(limiter._bucketCount()).toBe(2)

    // Two more distinct new keys arrive at cap: both land in the shared overflow
    // bucket (bucket count stays bounded at cap+1), and since limitPerMinute is 1,
    // the second of the two 429s alongside the first at the shared limit.
    const res1 = await app.request('/', { headers: { authorization: 'Bearer key-c' } })
    const res2 = await app.request('/', { headers: { authorization: 'Bearer key-d' } })
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(429)
    expect(limiter._bucketCount()).toBe(3) // key-a, key-b, __overflow__
  })
})

describe('origin enforcement', () => {
  it('publishable key + disallowed Origin -> 403 origin_not_allowed', async () => {
    const app = createApp(makeFakes(defs, pkAuth(['https://allowed.test'])), { rateLimitPerMinute: 0 })
    const res = await app.request('/v1/users/u1/achievements', { headers: { ...headers, origin: 'https://evil.test' } })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('origin_not_allowed')
  })

  it('publishable key + allowed Origin -> 200', async () => {
    const app = createApp(makeFakes(defs, pkAuth(['https://allowed.test'])), { rateLimitPerMinute: 0 })
    const res = await app.request('/v1/users/u1/achievements', { headers: { ...headers, origin: 'https://allowed.test' } })
    expect(res.status).toBe(200)
  })

  it('publishable key + no Origin header -> 200', async () => {
    const app = createApp(makeFakes(defs, pkAuth(['https://allowed.test'])), { rateLimitPerMinute: 0 })
    const res = await app.request('/v1/users/u1/achievements', { headers })
    expect(res.status).toBe(200)
  })

  it('secret key + disallowed Origin -> 200 (secret keys skip origin enforcement)', async () => {
    const app = createApp(makeFakes(defs, skAuth(['https://allowed.test'])), { rateLimitPerMinute: 0 })
    const res = await app.request('/v1/users/u1/achievements', { headers: { ...headers, origin: 'https://evil.test' } })
    expect(res.status).toBe(200)
  })

  it('null allowlist -> 200 regardless of Origin', async () => {
    const app = createApp(makeFakes(defs, pkAuth(null)), { rateLimitPerMinute: 0 })
    const res = await app.request('/v1/users/u1/achievements', { headers: { ...headers, origin: 'https://anything.test' } })
    expect(res.status).toBe(200)
  })
})

describe('DELETE /v1/users/:userId (erasure)', () => {
  it('publishable key -> 403 forbidden', async () => {
    const app = createApp(makeFakes(defs, pkAuth()), { rateLimitPerMinute: 0 })
    const res = await app.request('/v1/users/u1', { method: 'DELETE', headers })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  it('secret key -> 200 with counts from the erasure store', async () => {
    const fakes = makeFakes(defs, skAuth())
    const app = createApp(fakes, { rateLimitPerMinute: 0 })
    const res = await app.request('/v1/users/u1', { method: 'DELETE', headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ erased: true, counts: fakes.erasureCounts })
    expect(json.counts.coupons).toBe(fakes.erasureCounts.coupons)
    expect(fakes.erasedUsers).toEqual([{ scope: { projectId: 'p1', environment: 'test' }, userId: 'u1' }])
  })

  it('oversized userId (129 chars) -> 400 invalid_payload', async () => {
    const app = createApp(makeFakes(defs, skAuth()), { rateLimitPerMinute: 0 })
    const userId = 'u'.repeat(129)
    const res = await app.request(`/v1/users/${userId}`, { method: 'DELETE', headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })
})
