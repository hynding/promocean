import { describe, expect, it } from 'vitest'
import type { AuthContext } from '@promocean/core'
import { createApp } from '../src/app.js'
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
