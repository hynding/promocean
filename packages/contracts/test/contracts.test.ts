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
