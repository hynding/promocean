import { describe, expect, it, vi } from 'vitest'
import { Promocean, PromoceanApiError } from '../src/index.js'

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

describe('recordImpression', () => {
  it('POSTs a uuid impressionId body to the impression endpoint', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok({ recorded: true }))
    await client(fetchImpl).recordImpression('o1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/v1/offers/o1/impression')
    const body = JSON.parse(init.body)
    expect(body.userId).toBe('u1')
    expect(body.impressionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
  it('swallows errors', async () => {
    const c = client(vi.fn().mockImplementation(() => Promise.reject(new Error('down'))), { maxRetries: 0 })
    await expect(c.recordImpression('o1')).resolves.toBeUndefined()
  })
  it('retries 5xx then succeeds, reusing the same impressionId across attempts', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 500 })))
      .mockImplementation(() => ok({ recorded: true }))
    await client(fetchImpl, { maxRetries: 2 }).recordImpression('o1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const k1 = JSON.parse(fetchImpl.mock.calls[0][1].body).impressionId
    const k2 = JSON.parse(fetchImpl.mock.calls[1][1].body).impressionId
    expect(k1).toBe(k2)
  })
  it('swallows errors from crypto.randomUUID (insecure context)', async () => {
    const fetchImpl = vi.fn()
    const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('insecure context') })
    try {
      const c = client(fetchImpl)
      await expect(c.recordImpression('o1')).resolves.toBeUndefined()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('getStats', () => {
  const statsOk = {
    range: { from: null, to: null },
    totals: { events: 1, unlocks: 2, impressions: 3, clicks: 4, timedEventParticipants: 5 },
    achievements: [],
    offers: [],
    timedEvents: [],
  }
  it('throws when no secretKey is configured', async () => {
    const c = client(vi.fn())
    await expect(c.getStats()).rejects.toThrow('getStats requires the secretKey option (server-side only).')
  })
  it('sends the secretKey as bearer auth and parses the response', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(statsOk))
    const c = client(fetchImpl, { secretKey: 'sk_test_x' })
    const stats = await c.getStats()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/v1/stats')
    expect(init.headers.authorization).toBe('Bearer sk_test_x')
    expect(stats).toEqual(statsOk)
  })
  it('encodes from/to into the querystring', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(statsOk))
    const c = client(fetchImpl, { secretKey: 'sk_test_x' })
    await c.getStats({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' })
    const [url] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(
      'http://api.test/v1/stats?from=2026-01-01T00%3A00%3A00.000Z&to=2026-02-01T00%3A00%3A00.000Z',
    )
  })
  it('works with an empty publishableKey when secretKey is set', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(statsOk))
    const c = new Promocean({ publishableKey: '', secretKey: 'sk_test_x', baseUrl: 'http://api.test', fetchImpl })
    await expect(c.getStats()).resolves.toEqual(statsOk)
  })
})

describe('track tzOffsetMinutes', () => {
  it('sends the sign-corrected timezone offset (east-positive)', async () => {
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-120)
    try {
      const fetchImpl = vi.fn().mockImplementation(() => ok(trackOk))
      await client(fetchImpl).track('lesson_completed')
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
      expect(body.tzOffsetMinutes).toBe(120)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('getWallet', () => {
  it('fetches and parses the wallet', async () => {
    const body = { balance: 42, recent: [{ delta: 10, source: 'event', sourceRef: 'e1', at: '2026-07-06T00:00:00.000Z' }] }
    const fetchImpl = vi.fn().mockImplementation(() => ok(body))
    const c = client(fetchImpl)
    expect(await c.getWallet()).toEqual(body)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/users/u1/wallet')
  })
  it('throws if no user identified', async () => {
    const c = new Promocean({ publishableKey: 'pk', baseUrl: 'http://api.test', fetchImpl: vi.fn() })
    await expect(c.getWallet()).rejects.toThrow('No user identified — call identify(userId) first.')
  })
})

describe('getStreak', () => {
  it('fetches and parses the streak', async () => {
    const body = { current: 3, longest: 7, lastActiveDay: '2026-07-06' }
    const fetchImpl = vi.fn().mockImplementation(() => ok(body))
    const c = client(fetchImpl)
    expect(await c.getStreak()).toEqual(body)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/users/u1/streak')
  })
  it('throws if no user identified', async () => {
    const c = new Promocean({ publishableKey: 'pk', baseUrl: 'http://api.test', fetchImpl: vi.fn() })
    await expect(c.getStreak()).rejects.toThrow('No user identified — call identify(userId) first.')
  })
})

describe('getLeaderboard', () => {
  const leaderboardBody = { window: 'all', entries: [{ rank: 1, userId: 'u1', points: 100 }] }
  it('sends no querystring when no opts are provided', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(leaderboardBody))
    const c = client(fetchImpl)
    expect(await c.getLeaderboard()).toEqual(leaderboardBody)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/leaderboard')
  })
  it('encodes only the provided opts', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(leaderboardBody))
    const c = client(fetchImpl)
    await c.getLeaderboard({ window: '7d' })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/leaderboard?window=7d')
  })
  it('encodes both opts when provided', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(leaderboardBody))
    const c = client(fetchImpl)
    await c.getLeaderboard({ window: '30d', limit: 5 })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/leaderboard?window=30d&limit=5')
  })
  it('encodes only limit when only limit is provided', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(leaderboardBody))
    const c = client(fetchImpl)
    await c.getLeaderboard({ limit: 20 })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/leaderboard?limit=20')
  })
})

describe('currentUserId', () => {
  it('reflects the constructor userId', () => {
    const c = client(vi.fn())
    expect(c.currentUserId).toBe('u1')
  })
  it('is undefined when no user is identified', () => {
    const c = new Promocean({ publishableKey: 'pk', baseUrl: 'http://api.test', fetchImpl: vi.fn() })
    expect(c.currentUserId).toBeUndefined()
  })
  it('reflects identify() calls', () => {
    const c = new Promocean({ publishableKey: 'pk', baseUrl: 'http://api.test', fetchImpl: vi.fn() })
    c.identify('u2')
    expect(c.currentUserId).toBe('u2')
  })
})

describe('listRewards', () => {
  const rewardsBody = {
    rewards: [{
      slug: 'free-month', name: 'Free Month', description: null, codeType: 'generated',
      pointsPrice: 500, startsAt: null, endsAt: null, perUserLimit: 1, inventory: null, remaining: null,
    }],
  }
  it('fetches and parses the reward catalog without requiring an identified user', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(rewardsBody))
    const c = new Promocean({ publishableKey: 'pk_test_x', baseUrl: 'http://api.test', fetchImpl })
    const rewards = await c.listRewards()
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/rewards')
    expect(rewards).toEqual(rewardsBody.rewards)
  })
})

describe('claimReward', () => {
  const claimOk = { code: 'ABC123', rewardSlug: 'free-month', claimedAt: '2026-07-06T00:00:00.000Z', pointsSpent: 500 }
  it('throws if no user identified', async () => {
    const c = new Promocean({ publishableKey: 'pk', baseUrl: 'http://api.test', fetchImpl: vi.fn() })
    await expect(c.claimReward('free-month')).rejects.toThrow('No user identified — call identify(userId) first.')
  })
  it('POSTs { userId } to the claim endpoint and parses the response', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(claimOk))
    const c = client(fetchImpl)
    const claimed = await c.claimReward('free-month')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/v1/rewards/free-month/claim')
    expect(JSON.parse(init.body)).toEqual({ userId: 'u1' })
    expect(claimed).toEqual(claimOk)
  })
  it('url-encodes the slug', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(claimOk))
    const c = client(fetchImpl)
    await c.claimReward('free month/deal')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/rewards/free%20month%2Fdeal/claim')
  })
  it('propagates a 409 insufficient_points envelope as a typed PromoceanApiError', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'insufficient_points', message: 'Insufficient points balance to claim this reward.' } }), { status: 409 }),
    ))
    const c = client(fetchImpl)
    const err = await c.claimReward('free-month').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PromoceanApiError)
    expect((err as PromoceanApiError).code).toBe('insufficient_points')
    expect((err as PromoceanApiError).status).toBe(409)
  })
})

describe('validateCoupon', () => {
  const validateOk = { valid: true, rewardSlug: 'free-month', status: 'claimed' }
  it('throws when no secretKey is configured', async () => {
    const c = client(vi.fn())
    await expect(c.validateCoupon('ABC123')).rejects.toThrow('validateCoupon requires the secretKey option (server-side only).')
  })
  it('sends the secretKey as bearer auth with a { code } body and parses the response', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(validateOk))
    const c = client(fetchImpl, { secretKey: 'sk_test_x' })
    const result = await c.validateCoupon('ABC123')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/v1/coupons/validate')
    expect(init.headers.authorization).toBe('Bearer sk_test_x')
    expect(JSON.parse(init.body)).toEqual({ code: 'ABC123' })
    expect(result).toEqual(validateOk)
  })
})

describe('redeemCoupon', () => {
  const redeemOk = { redeemed: true, rewardSlug: 'free-month', redeemedAt: '2026-07-06T00:00:00.000Z' }
  it('throws when no secretKey is configured', async () => {
    const c = client(vi.fn())
    await expect(c.redeemCoupon('ABC123')).rejects.toThrow('redeemCoupon requires the secretKey option (server-side only).')
  })
  it('sends the secretKey as bearer auth with a { code } body and parses the response', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(redeemOk))
    const c = client(fetchImpl, { secretKey: 'sk_test_x' })
    const result = await c.redeemCoupon('ABC123')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/v1/coupons/redeem')
    expect(init.headers.authorization).toBe('Bearer sk_test_x')
    expect(JSON.parse(init.body)).toEqual({ code: 'ABC123' })
    expect(result).toEqual(redeemOk)
  })
})

describe('getLiveEvents', () => {
  it('fetches and returns the live events array', async () => {
    const liveEventBody = {
      events: [{
        eventId: 'evt_live_1',
        name: 'Flash Sale',
        description: null,
        state: 'live',
        startsAt: '2026-07-06T00:00:00.000Z',
        endsAt: '2026-07-13T00:00:00.000Z',
        multiplier: 2,
        secondsUntilStart: null,
        secondsUntilEnd: 604800,
        recurrence: 'weekly',
        nextOccurrenceStartsAt: '2026-07-13T00:00:00.000Z',
      }],
    }
    const fetchImpl = vi.fn().mockImplementation(() => ok(liveEventBody))
    const c = client(fetchImpl)
    const events = await c.getLiveEvents()
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/events/live')
    expect(events).toEqual(liveEventBody.events)
  })

  it('defaults recurrence and nextOccurrenceStartsAt when an old-shape event omits them', async () => {
    const liveEventBody = {
      events: [{
        eventId: 'evt_live_2',
        name: 'Legacy Sale',
        description: null,
        state: 'live',
        startsAt: '2026-07-06T00:00:00.000Z',
        endsAt: '2026-07-13T00:00:00.000Z',
        multiplier: 2,
        secondsUntilStart: null,
        secondsUntilEnd: 604800,
      }],
    }
    const fetchImpl = vi.fn().mockImplementation(() => ok(liveEventBody))
    const c = client(fetchImpl)
    const events = await c.getLiveEvents()
    expect(events).toEqual([{ ...liveEventBody.events[0], recurrence: 'none', nextOccurrenceStartsAt: null }])
  })
})

describe('backfillAchievement', () => {
  const backfillOk = { usersEvaluated: 12, progressRaised: 5, unlocksGranted: 2, pointsAwarded: 40 }
  it('throws when no secretKey is configured', async () => {
    const c = client(vi.fn())
    await expect(c.backfillAchievement('ach_1')).rejects.toThrow('backfillAchievement requires the secretKey option (server-side only).')
  })
  it('sends the secretKey as bearer auth to the encoded path with no body and parses the response', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(backfillOk))
    const c = client(fetchImpl, { secretKey: 'sk_test_x' })
    const result = await c.backfillAchievement('ach 1/2')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/v1/achievements/ach%201%2F2/backfill')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer sk_test_x')
    expect(init.body).toBeUndefined()
    expect(result).toEqual(backfillOk)
  })
  it('propagates a 409 backfill_in_progress envelope as a typed PromoceanApiError', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'backfill_in_progress', message: 'A backfill for this achievement is already running.' } }), { status: 409 }),
    ))
    const c = client(fetchImpl, { secretKey: 'sk_test_x' })
    const err = await c.backfillAchievement('ach_1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PromoceanApiError)
    expect((err as PromoceanApiError).code).toBe('backfill_in_progress')
    expect((err as PromoceanApiError).status).toBe(409)
  })
})
