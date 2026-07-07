import { describe, expect, it } from 'vitest'
import {
  trackEventRequestSchema,
  trackEventResponseSchema,
  errorEnvelopeSchema,
  EVENT_TYPE_PATTERN,
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
})
