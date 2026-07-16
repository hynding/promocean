import { describe, expect, it } from 'vitest'
import {
  trackEventRequestSchema,
  trackEventResponseSchema,
  errorEnvelopeSchema,
  EVENT_TYPE_PATTERN,
  eraseUserResponseSchema,
  offerImpressionRequestSchema,
  offerImpressionResponseSchema,
  statsQuerySchema,
  statsResponseSchema,
  webhookMessageSchema,
  walletResponseSchema,
  streakResponseSchema,
  leaderboardResponseSchema,
  leaderboardWindowSchema,
  rewardSchema,
  rewardsResponseSchema,
  claimRewardRequestSchema,
  claimRewardResponseSchema,
  couponCodeSchema,
  validateCouponRequestSchema,
  validateCouponResponseSchema,
  redeemCouponRequestSchema,
  redeemCouponResponseSchema,
  recurrenceSchema,
  liveTimedEventSchema,
  backfillResponseSchema,
  configSlugSchema,
  configFileSchema,
  importRequestSchema,
  importResponseSchema,
} from '../src/index.js'

describe('trackEventRequestSchema', () => {
  it('accepts a valid request', () => {
    const r = trackEventRequestSchema.safeParse({
      userId: 'u1',
      type: 'lesson_completed',
      idempotencyKey: 'a'.repeat(12),
      meta: { lessonId: 42 },
    })
    expect(r.success).toBe(true)
  })
  it('rejects bad event types', () => {
    for (const type of ['Lesson', '9lives', 'has space', ''])
      expect(trackEventRequestSchema.safeParse({ userId: 'u', type, idempotencyKey: 'a'.repeat(12) }).success).toBe(false)
  })
  it('rejects short idempotency keys', () => {
    expect(trackEventRequestSchema.safeParse({ userId: 'u', type: 'ok_type', idempotencyKey: 'short' }).success).toBe(false)
  })
})

describe('response and error schemas', () => {
  it('round-trips a track response', () => {
    const payload = {
      deduped: false,
      unlocks: [{ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }],
      progress: [{ achievementId: 'a1', current: 1, target: 1 }],
    }
    expect(trackEventResponseSchema.parse(payload)).toEqual(payload)
  })
  it('rejects unknown error codes', () => {
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false)
  })
  it('exports the event type pattern', () => {
    expect(EVENT_TYPE_PATTERN.test('lesson_completed')).toBe(true)
  })
  it('accepts forbidden error code', () => {
    const result = errorEnvelopeSchema.safeParse({ error: { code: 'forbidden', message: 'Access denied' } })
    expect(result.success).toBe(true)
  })
})

describe('eraseUserResponseSchema', () => {
  it('round-trips a valid payload', () => {
    const payload = {
      erased: true,
      counts: {
        events: 42,
        progress: 10,
        unlocks: 5,
        offerEvents: 3,
        pointsLedger: 7,
        streaks: 1,
        coupons: 2,
      },
    }
    expect(eraseUserResponseSchema.parse(payload)).toEqual(payload)
  })
  it('rejects erased: false', () => {
    const result = eraseUserResponseSchema.safeParse({
      erased: false,
      counts: {
        events: 42,
        progress: 10,
        unlocks: 5,
        offerEvents: 3,
        pointsLedger: 7,
        streaks: 1,
        coupons: 2,
      },
    })
    expect(result.success).toBe(false)
  })
  it('rejects counts without coupons', () => {
    const result = eraseUserResponseSchema.safeParse({
      erased: true,
      counts: {
        events: 42,
        progress: 10,
        unlocks: 5,
        offerEvents: 3,
        pointsLedger: 7,
        streaks: 1,
      },
    })
    expect(result.success).toBe(false)
  })
})

describe('offerImpressionRequestSchema', () => {
  it('round-trips a valid impression request', () => {
    const payload = {
      impressionId: '550e8400-e29b-41d4-a716-446655440000',
      userId: 'user123',
    }
    expect(offerImpressionRequestSchema.parse(payload)).toEqual(payload)
  })
  it('rejects non-uuid impressionId', () => {
    const result = offerImpressionRequestSchema.safeParse({
      impressionId: 'not-a-uuid',
      userId: 'user123',
    })
    expect(result.success).toBe(false)
  })
  it('accepts a request with userId omitted (anonymous impression)', () => {
    const result = offerImpressionRequestSchema.safeParse({
      impressionId: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toEqual({ impressionId: '550e8400-e29b-41d4-a716-446655440000' })
  })
})

describe('statsQuerySchema', () => {
  it('accepts a valid Z-suffixed ISO datetime for from/to', () => {
    const result = statsQuerySchema.safeParse({ from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.999Z' })
    expect(result.success).toBe(true)
  })
  it('rejects a junk datetime string', () => {
    const result = statsQuerySchema.safeParse({ from: 'not-a-date' })
    expect(result.success).toBe(false)
  })
  it('accepts an empty object (both bounds optional)', () => {
    const result = statsQuerySchema.safeParse({})
    expect(result.success).toBe(true)
  })
  it('accepts an offset-form ISO datetime for from/to', () => {
    const result = statsQuerySchema.safeParse({ from: '2026-07-01T00:00:00+02:00', to: '2026-07-31T00:00:00+02:00' })
    expect(result.success).toBe(true)
  })
})

describe('offerImpressionResponseSchema', () => {
  it('round-trips a valid impression response', () => {
    const payload = { recorded: true }
    expect(offerImpressionResponseSchema.parse(payload)).toEqual(payload)
  })
})

describe('statsResponseSchema', () => {
  it('round-trips a valid stats response', () => {
    const payload = {
      range: { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.999Z' },
      totals: {
        events: 100,
        unlocks: 20,
        impressions: 50,
        clicks: 10,
        timedEventParticipants: 5,
      },
      achievements: [{ achievementId: 'a1', unlocks: 5 }],
      offers: [{ offerId: 'o1', impressions: 10, clicks: 2, ctr: 0.2 }],
      timedEvents: [{ eventId: 'e1', name: 'Event 1', participants: 3 }],
    }
    expect(statsResponseSchema.parse(payload)).toEqual(payload)
  })
  it('accepts null ctr when impressions are zero', () => {
    const payload = {
      range: { from: null, to: null },
      totals: {
        events: 0,
        unlocks: 0,
        impressions: 0,
        clicks: 0,
        timedEventParticipants: 0,
      },
      achievements: [],
      offers: [{ offerId: 'o1', impressions: 0, clicks: 0, ctr: null }],
      timedEvents: [],
    }
    expect(statsResponseSchema.parse(payload)).toEqual(payload)
  })
})

describe('error codes', () => {
  it('accepts unregistered_event_type error code', () => {
    const result = errorEnvelopeSchema.safeParse({
      error: { code: 'unregistered_event_type', message: 'Event type not registered' },
    })
    expect(result.success).toBe(true)
  })
  it('accepts not_found error code', () => {
    const result = errorEnvelopeSchema.safeParse({
      error: { code: 'not_found', message: 'Resource not found' },
    })
    expect(result.success).toBe(true)
  })
  it('accepts the four new rewards/coupons error codes', () => {
    for (const code of ['reward_unavailable', 'claim_limit_reached', 'insufficient_points', 'already_redeemed']) {
      const result = errorEnvelopeSchema.safeParse({ error: { code, message: 'x' } })
      expect(result.success).toBe(true)
    }
  })
  it('accepts the backfill_in_progress error code', () => {
    const result = errorEnvelopeSchema.safeParse({ error: { code: 'backfill_in_progress', message: 'x' } })
    expect(result.success).toBe(true)
  })
})

describe('webhookMessageSchema', () => {
  it('accepts a message with messageId', () => {
    const payload = {
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      type: 'timed_event.live',
      data: { eventId: 'e1' },
      createdAt: '2026-07-08T10:00:00.000Z',
    }
    const result = webhookMessageSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(payload)
    }
  })
  it('rejects a message without messageId', () => {
    const payload = {
      type: 'timed_event.live',
      data: { eventId: 'e1' },
      createdAt: '2026-07-08T10:00:00.000Z',
    }
    const result = webhookMessageSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })
})

describe('trackEventRequestSchema with tzOffsetMinutes', () => {
  it('accepts a track request without tzOffsetMinutes', () => {
    const payload = {
      userId: 'u1',
      type: 'lesson_completed',
      idempotencyKey: 'a'.repeat(12),
    }
    const result = trackEventRequestSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })
  it('accepts a track request with tzOffsetMinutes as integer', () => {
    const payload = {
      userId: 'u1',
      type: 'lesson_completed',
      idempotencyKey: 'a'.repeat(12),
      tzOffsetMinutes: -300,
    }
    const result = trackEventRequestSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })
  it('parses successfully with tzOffsetMinutes stripped to undefined when it is a non-numeric string', () => {
    const payload = {
      userId: 'u1',
      type: 'lesson_completed',
      idempotencyKey: 'a'.repeat(12),
      tzOffsetMinutes: '60',
    }
    const result = trackEventRequestSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.tzOffsetMinutes).toBeUndefined()
  })
  it('parses successfully with tzOffsetMinutes stripped to undefined when it is a fractional number', () => {
    const payload = {
      userId: 'u1',
      type: 'lesson_completed',
      idempotencyKey: 'a'.repeat(12),
      tzOffsetMinutes: 300.5,
    }
    const result = trackEventRequestSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.tzOffsetMinutes).toBeUndefined()
  })
})

describe('walletResponseSchema', () => {
  it('round-trips a valid wallet response', () => {
    const payload = {
      balance: 100,
      recent: [
        { delta: 10, source: 'event', sourceRef: 'ref1', at: '2026-07-08T10:00:00.000Z' },
        { delta: 5, source: 'unlock', sourceRef: 'ref2', at: '2026-07-08T11:00:00.000Z' },
      ],
    }
    expect(walletResponseSchema.parse(payload)).toEqual(payload)
  })
  it('rejects unknown source enum', () => {
    const payload = {
      balance: 100,
      recent: [
        { delta: 10, source: 'unknown', sourceRef: 'ref1', at: '2026-07-08T10:00:00.000Z' },
      ],
    }
    const result = walletResponseSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })
  it('accepts a redemption entry', () => {
    const payload = {
      balance: 90,
      recent: [
        { delta: -10, source: 'redemption', sourceRef: 'ref3', at: '2026-07-08T12:00:00.000Z' },
      ],
    }
    const result = walletResponseSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })
})

describe('streakResponseSchema', () => {
  it('round-trips a valid streak response', () => {
    const payload = {
      current: 5,
      longest: 10,
      lastActiveDay: '2026-07-08',
    }
    expect(streakResponseSchema.parse(payload)).toEqual(payload)
  })
  it('accepts lastActiveDay as null', () => {
    const payload = {
      current: 0,
      longest: 0,
      lastActiveDay: null,
    }
    const result = streakResponseSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })
  it('enforces lastActiveDay format (YYYY-MM-DD)', () => {
    const payloads = [
      { current: 5, longest: 10, lastActiveDay: '2026/07/08' },
      { current: 5, longest: 10, lastActiveDay: '2026-7-8' },
      { current: 5, longest: 10, lastActiveDay: 'invalid' },
    ]
    for (const payload of payloads) {
      const result = streakResponseSchema.safeParse(payload)
      expect(result.success).toBe(false)
    }
  })
})

describe('leaderboardWindowSchema', () => {
  it('accepts valid window values', () => {
    for (const window of ['all', '7d', '30d']) {
      const result = leaderboardWindowSchema.safeParse(window)
      expect(result.success).toBe(true)
    }
  })
  it('rejects invalid window values', () => {
    for (const window of ['1d', '14d', 'invalid', '']) {
      const result = leaderboardWindowSchema.safeParse(window)
      expect(result.success).toBe(false)
    }
  })
})

describe('leaderboardResponseSchema', () => {
  it('round-trips a valid leaderboard response', () => {
    const payload = {
      window: 'all',
      entries: [
        { rank: 1, userId: 'user1', points: 1000 },
        { rank: 2, userId: 'user2', points: 950 },
      ],
    }
    expect(leaderboardResponseSchema.parse(payload)).toEqual(payload)
  })
  it('rejects rank less than 1', () => {
    const payload = {
      window: '7d',
      entries: [
        { rank: 0, userId: 'user1', points: 1000 },
      ],
    }
    const result = leaderboardResponseSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })
})

describe('rewardSchema', () => {
  const validReward = {
    slug: 'free-coffee',
    name: 'Free Coffee',
    description: 'A free coffee on us',
    codeType: 'generated' as const,
    pointsPrice: 100,
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-08-01T00:00:00.000Z',
    perUserLimit: 1,
    inventory: 50,
    remaining: 50,
  }
  it('round-trips a valid reward', () => {
    expect(rewardSchema.parse(validReward)).toEqual(validReward)
  })
  it('accepts null description, startsAt, endsAt, inventory, remaining', () => {
    const payload = {
      ...validReward,
      description: null,
      startsAt: null,
      endsAt: null,
      inventory: null,
      remaining: null,
    }
    expect(rewardSchema.safeParse(payload).success).toBe(true)
  })
  it('rejects pointsPrice of -1', () => {
    expect(rewardSchema.safeParse({ ...validReward, pointsPrice: -1 }).success).toBe(false)
  })
  it('accepts pointsPrice of 0', () => {
    expect(rewardSchema.safeParse({ ...validReward, pointsPrice: 0 }).success).toBe(true)
  })
  it('rejects perUserLimit of 0', () => {
    expect(rewardSchema.safeParse({ ...validReward, perUserLimit: 0 }).success).toBe(false)
  })
  it('rejects inventory of 0', () => {
    expect(rewardSchema.safeParse({ ...validReward, inventory: 0 }).success).toBe(false)
  })
  it('accepts inventory of null', () => {
    expect(rewardSchema.safeParse({ ...validReward, inventory: null }).success).toBe(true)
  })
  it('does not allow a staticCode field to be part of the schema', () => {
    expect('staticCode' in rewardSchema.shape).toBe(false)
  })
})

describe('rewardsResponseSchema', () => {
  it('round-trips a valid rewards response', () => {
    const payload = {
      rewards: [
        {
          slug: 'free-coffee',
          name: 'Free Coffee',
          description: null,
          codeType: 'static' as const,
          pointsPrice: 50,
          startsAt: null,
          endsAt: null,
          perUserLimit: 1,
          inventory: null,
          remaining: null,
        },
      ],
    }
    expect(rewardsResponseSchema.parse(payload)).toEqual(payload)
  })
})

describe('claimRewardRequestSchema', () => {
  it('round-trips a valid claim request', () => {
    const payload = { userId: 'user1' }
    expect(claimRewardRequestSchema.parse(payload)).toEqual(payload)
  })
  it('rejects an empty userId', () => {
    expect(claimRewardRequestSchema.safeParse({ userId: '' }).success).toBe(false)
  })
  it('rejects a userId over 128 chars', () => {
    expect(claimRewardRequestSchema.safeParse({ userId: 'a'.repeat(129) }).success).toBe(false)
  })
})

describe('claimRewardResponseSchema', () => {
  it('round-trips a valid claim response', () => {
    const payload = {
      code: 'ABC123',
      rewardSlug: 'free-coffee',
      claimedAt: '2026-07-08T10:00:00.000Z',
      pointsSpent: 100,
    }
    expect(claimRewardResponseSchema.parse(payload)).toEqual(payload)
  })
})

describe('couponCodeSchema', () => {
  it('rejects a code of length 0', () => {
    expect(couponCodeSchema.safeParse('').success).toBe(false)
  })
  it('accepts a code of length 64', () => {
    expect(couponCodeSchema.safeParse('a'.repeat(64)).success).toBe(true)
  })
  it('rejects a code of length 65', () => {
    expect(couponCodeSchema.safeParse('a'.repeat(65)).success).toBe(false)
  })
})

describe('validateCouponRequestSchema', () => {
  it('round-trips a valid request', () => {
    const payload = { code: 'ABC123' }
    expect(validateCouponRequestSchema.parse(payload)).toEqual(payload)
  })
})

describe('validateCouponResponseSchema', () => {
  it('round-trips a valid coupon response', () => {
    const payload = { valid: true, rewardSlug: 'free-coffee', status: 'claimed' as const }
    expect(validateCouponResponseSchema.parse(payload)).toEqual(payload)
  })
  it('round-trips an invalid coupon response with a reason', () => {
    const payload = { valid: false, reason: 'not_found' as const }
    expect(validateCouponResponseSchema.parse(payload)).toEqual(payload)
  })
})

describe('redeemCouponRequestSchema', () => {
  it('round-trips a valid request', () => {
    const payload = { code: 'ABC123' }
    expect(redeemCouponRequestSchema.parse(payload)).toEqual(payload)
  })
})

describe('redeemCouponResponseSchema', () => {
  it('round-trips a valid redemption response', () => {
    const payload = { redeemed: true as const, rewardSlug: 'free-coffee', redeemedAt: '2026-07-08T10:00:00.000Z' }
    expect(redeemCouponResponseSchema.parse(payload)).toEqual(payload)
  })
  it('rejects redeemed: false', () => {
    expect(redeemCouponResponseSchema.safeParse({ redeemed: false, rewardSlug: 'x', redeemedAt: '2026-07-08T10:00:00.000Z' }).success).toBe(false)
  })
})

describe('recurrenceSchema', () => {
  it('accepts the four recurrence values', () => {
    for (const value of ['none', 'daily', 'weekly', 'monthly']) {
      expect(recurrenceSchema.safeParse(value).success).toBe(true)
    }
  })
  it('rejects other values', () => {
    for (const value of ['yearly', 'Daily', '', 'NONE']) {
      expect(recurrenceSchema.safeParse(value).success).toBe(false)
    }
  })
})

describe('liveTimedEventSchema recurrence fields', () => {
  const baseEvent = {
    eventId: 'e1',
    name: 'Double Points Weekend',
    description: null,
    state: 'live' as const,
    startsAt: '2026-07-08T00:00:00.000Z',
    endsAt: '2026-07-09T00:00:00.000Z',
    multiplier: 2,
    secondsUntilStart: null,
    secondsUntilEnd: 3600,
  }

  it('parses an event WITHOUT the two new fields and applies back-compat defaults', () => {
    const result = liveTimedEventSchema.safeParse(baseEvent)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.recurrence).toBe('none')
      expect(result.data.nextOccurrenceStartsAt).toBeNull()
    }
  })

  it('round-trips an event with recurrence and nextOccurrenceStartsAt set', () => {
    const payload = {
      ...baseEvent,
      recurrence: 'weekly' as const,
      nextOccurrenceStartsAt: '2026-07-15T00:00:00.000Z',
    }
    expect(liveTimedEventSchema.parse(payload)).toEqual(payload)
  })
})

describe('backfillResponseSchema', () => {
  it('round-trips a valid backfill response', () => {
    const payload = {
      usersEvaluated: 100,
      progressRaised: 40,
      unlocksGranted: 10,
      pointsAwarded: 500,
    }
    expect(backfillResponseSchema.parse(payload)).toEqual(payload)
  })
  it('rejects negative counts', () => {
    const valid = {
      usersEvaluated: 100,
      progressRaised: 40,
      unlocksGranted: 10,
      pointsAwarded: 500,
    }
    for (const key of Object.keys(valid)) {
      const payload = { ...valid, [key]: -1 }
      expect(backfillResponseSchema.safeParse(payload).success).toBe(false)
    }
  })
})

describe('configSlugSchema', () => {
  it('accepts lowercase, digits, hyphen and underscore (not leading)', () => {
    for (const slug of ['homepage', 'home2', 'home-page', 'home_page', 'a']) {
      expect(configSlugSchema.safeParse(slug).success).toBe(true)
    }
  })
  it('rejects a leading digit', () => {
    expect(configSlugSchema.safeParse('1homepage').success).toBe(false)
  })
  it('rejects uppercase letters', () => {
    expect(configSlugSchema.safeParse('Homepage').success).toBe(false)
  })
  it('rejects a leading hyphen or underscore', () => {
    expect(configSlugSchema.safeParse('-homepage').success).toBe(false)
    expect(configSlugSchema.safeParse('_homepage').success).toBe(false)
  })
  it('rejects an empty string', () => {
    expect(configSlugSchema.safeParse('').success).toBe(false)
  })
})

describe('configFileSchema', () => {
  const baseFile = {
    formatVersion: 1 as const,
    project: {
      pointRules: { click: 1, purchase: 10 },
      registeredEventTypes: ['click', 'purchase'],
      allowedOrigins: ['https://example.com'],
    },
    placements: [{ slug: 'homepage', name: 'Homepage' }],
    achievements: [{
      slug: 'first-purchase', name: 'First Purchase', description: 'Make your first purchase',
      artworkUrl: 'https://cdn.example.com/a.png', eventType: 'purchase',
      targetCount: 1, pointsValue: 100,
    }],
    timedEvents: [{
      slug: 'double_points', name: 'Double Points', description: 'Double points weekend',
      startsAt: '2026-07-08T00:00:00.000Z', endsAt: '2026-07-09T00:00:00.000Z',
      endingSoonMinutes: 30, multiplier: 2,
      recurrence: 'weekly' as const,
      recurrenceEndsAt: '2026-12-31T00:00:00.000Z', enabled: true,
    }],
    offers: [{
      slug: 'summer-sale', name: 'Summer Sale', headline: 'Save big',
      body: 'Limited time offer', imageUrl: 'https://cdn.example.com/o.png',
      ctaText: 'Shop now', ctaUrl: 'https://example.com/shop',
      startsAt: '2026-07-01T00:00:00.000Z', endsAt: '2026-07-31T00:00:00.000Z',
      priority: 1, placement: 'homepage',
      timedEvent: 'double_points',
    }],
    rewards: [{
      slug: 'free-shipping', name: 'Free Shipping', description: 'Free shipping on next order',
      codeType: 'static' as const, staticCode: 'SHIP2026',
      codePrefix: 'SHIP', pointsPrice: 500,
      startsAt: '2026-07-01T00:00:00.000Z', endsAt: '2026-07-31T00:00:00.000Z',
      perUserLimit: 1, inventory: 100,
      enabled: true,
    }],
  }

  it('round-trips a full valid config file with every nullable field set (non-null)', () => {
    expect(configFileSchema.parse(baseFile)).toEqual(baseFile)
  })

  it('round-trips a full valid config file with every nullable field set to null', () => {
    const nulledFile = {
      ...baseFile,
      project: { ...baseFile.project, allowedOrigins: null },
      achievements: [{ ...baseFile.achievements[0], description: null, artworkUrl: null }],
      timedEvents: [{ ...baseFile.timedEvents[0], description: null, recurrenceEndsAt: null }],
      offers: [{
        ...baseFile.offers[0],
        body: null, imageUrl: null, ctaText: null, ctaUrl: null,
        startsAt: null, endsAt: null, timedEvent: null,
      }],
      rewards: [{
        ...baseFile.rewards[0],
        description: null, staticCode: null, codePrefix: null, startsAt: null, endsAt: null, inventory: null,
      }],
    }
    expect(configFileSchema.parse(nulledFile)).toEqual(nulledFile)
  })

  it('accepts an offer with timedEvent: null', () => {
    const file = {
      ...baseFile,
      offers: [{ ...baseFile.offers[0], timedEvent: null }],
    }
    expect(configFileSchema.safeParse(file).success).toBe(true)
  })

  it('rejects formatVersion: 2', () => {
    const file = { ...baseFile, formatVersion: 2 }
    expect(configFileSchema.safeParse(file).success).toBe(false)
  })

  it('rejects a pointRules key that is not a valid event type', () => {
    const file = { ...baseFile, project: { ...baseFile.project, pointRules: { 'Bad-Key': 1 } } }
    const result = configFileSchema.safeParse(file)
    expect(result.success).toBe(false)
  })

  it('rejects a registeredEventTypes entry that is not a valid event type', () => {
    const file = { ...baseFile, project: { ...baseFile.project, registeredEventTypes: ['ok_type', 'Bad Type'] } }
    const result = configFileSchema.safeParse(file)
    expect(result.success).toBe(false)
  })

  it('rejects a duplicate slug within placements, naming the type and slug', () => {
    const file = {
      ...baseFile,
      placements: [{ slug: 'homepage', name: 'Homepage' }, { slug: 'homepage', name: 'Homepage Again' }],
    }
    const result = configFileSchema.safeParse(file)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ')
      expect(messages).toContain('duplicate slug')
      expect(messages).toContain('homepage')
      expect(messages).toContain('placements')
    }
  })

  it('rejects a duplicate slug within rewards', () => {
    const file = {
      ...baseFile,
      rewards: [baseFile.rewards[0], { ...baseFile.rewards[0], name: 'Dup' }],
    }
    const result = configFileSchema.safeParse(file)
    expect(result.success).toBe(false)
  })
})

describe('importRequestSchema', () => {
  const file = {
    formatVersion: 1 as const,
    project: { pointRules: {}, registeredEventTypes: [], allowedOrigins: null },
    placements: [],
    achievements: [],
    timedEvents: [],
    offers: [],
    rewards: [],
  }

  it('defaults prune and dryRun to false when omitted', () => {
    const result = importRequestSchema.parse({ file })
    expect(result.prune).toBe(false)
    expect(result.dryRun).toBe(false)
  })

  it('round-trips explicit prune and dryRun values', () => {
    const result = importRequestSchema.parse({ file, prune: true, dryRun: true })
    expect(result.prune).toBe(true)
    expect(result.dryRun).toBe(true)
  })
})

describe('importResponseSchema', () => {
  const typePlan = { creates: [], updates: [], deletes: [], unchanged: 0 }
  const plan = {
    project: typePlan, placements: typePlan, achievements: typePlan,
    timedEvents: typePlan, offers: typePlan, rewards: typePlan,
  }

  it('parses a response without an error field', () => {
    const payload = { applied: true, plan }
    expect(importResponseSchema.parse(payload)).toEqual(payload)
  })

  it('parses a response with an error field', () => {
    const payload = {
      applied: false,
      plan,
      error: { stage: 'validation', message: 'formatVersion must be 1' },
    }
    expect(importResponseSchema.parse(payload)).toEqual(payload)
  })

  it('rejects a negative unchanged count in any plan bucket', () => {
    for (const key of Object.keys(plan)) {
      const payload = {
        applied: true,
        plan: { ...plan, [key]: { ...typePlan, unchanged: -1 } },
      }
      expect(importResponseSchema.safeParse(payload).success).toBe(false)
    }
  })
})
