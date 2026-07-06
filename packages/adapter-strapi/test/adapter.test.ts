import { describe, expect, it, vi } from 'vitest'
import { StrapiConfigPlane } from '../src/index.js'

const achievementsBody = { achievements: [{ id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 }] }
const authBody = { projectId: 'p1', environment: 'test', keyType: 'publishable' }
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
})
