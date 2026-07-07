import { describe, expect, it, vi } from 'vitest'
import { Promocean } from '../src/index.js'

const trackOk = { deduped: false, unlocks: [{ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }], progress: [] }
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new Promocean({ publishableKey: 'pk_test_x', baseUrl: 'http://api.test', userId: 'u1', fetchImpl, ...extra })
}

describe('track', () => {
  it('POSTs a valid payload with bearer auth and an idempotency key', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(trackOk))
    await client(fetchImpl).track('lesson_completed', { lessonId: 1 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/v1/events')
    expect(init.headers.authorization).toBe('Bearer pk_test_x')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ userId: 'u1', type: 'lesson_completed', meta: { lessonId: 1 } })
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8)
  })
  it('emits unlocks to listeners', async () => {
    const c = client(vi.fn().mockImplementation(() => ok(trackOk)))
    const seen: string[] = []
    c.onUnlock((u) => seen.push(u.name))
    await c.track('lesson_completed')
    expect(seen).toEqual(['First Lesson'])
  })
  it('retries 5xx then succeeds, reusing the same idempotency key', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 500 })))
      .mockImplementation(() => ok(trackOk))
    const res = await client(fetchImpl, { maxRetries: 2 }).track('lesson_completed')
    expect(res.deduped).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const k1 = JSON.parse(fetchImpl.mock.calls[0][1].body).idempotencyKey
    const k2 = JSON.parse(fetchImpl.mock.calls[1][1].body).idempotencyKey
    expect(k1).toBe(k2)
  })
  it('does not retry 4xx', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { code: 'invalid_payload', message: 'bad' } }), { status: 400 })))
    await expect(client(fetchImpl).track('lesson_completed')).rejects.toThrow('invalid_payload')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('throws if no user identified', async () => {
    const c = new Promocean({ publishableKey: 'pk', baseUrl: 'http://api.test', fetchImpl: vi.fn() })
    await expect(c.track('lesson_completed')).rejects.toThrow(/identify/)
  })
  it('throws PromoceanApiError after exhausting 5xx retries', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 503 })))
    await expect(client(fetchImpl, { maxRetries: 1 }).track('lesson_completed')).rejects.toThrow('internal_error')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('getAchievements', () => {
  it('fetches and returns the achievement list', async () => {
    const body = { achievements: [{ achievementId: 'a1', name: 'First Lesson', description: null, artworkUrl: null, current: 1, target: 1, unlockedAt: '2026-07-06T00:00:00.000Z' }] }
    const c = client(vi.fn().mockImplementation(() => ok(body)))
    expect(await c.getAchievements()).toEqual(body.achievements)
  })
})

const offerBody = { offer: { offerId: 'o1', headline: 'Welcome', body: null, imageUrl: null, ctaText: null, ctaUrl: null } }

describe('offers', () => {
  it('getPlacementOffer resolves with user attribution', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(offerBody))
    const offer = await client(fetchImpl).getPlacementOffer('homepage-banner')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/placements/homepage-banner/offer?userId=u1')
    expect(offer?.offerId).toBe('o1')
  })
  it('getPlacementOffer returns null offers as null', async () => {
    const c = client(vi.fn().mockImplementation(() => ok({ offer: null })))
    expect(await c.getPlacementOffer('homepage-banner')).toBeNull()
  })
  it('clickOffer swallows errors', async () => {
    const c = client(vi.fn().mockImplementation(() => Promise.reject(new Error('down'))), { maxRetries: 0 })
    await expect(c.clickOffer('o1')).resolves.toBeUndefined()
  })
  it('dismissal persists in memory when localStorage is unavailable', () => {
    const c = client(vi.fn())
    expect(c.isOfferDismissed('o1')).toBe(false)
    c.dismissOffer('o1')
    expect(c.isOfferDismissed('o1')).toBe(true)
  })
})
