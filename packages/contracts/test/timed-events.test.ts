import { describe, expect, it } from 'vitest'
import { liveEventsResponseSchema, webhookMessageSchema, WEBHOOK_SIGNATURE_HEADER } from '../src/index.js'

const event = {
  eventId: 'e1', name: 'Double Progress Weekend', description: null, state: 'live',
  startsAt: '2026-07-07T00:00:00.000Z', endsAt: '2026-07-14T00:00:00.000Z',
  multiplier: 2, secondsUntilStart: null, secondsUntilEnd: 604800,
}

describe('timed event schemas', () => {
  it('round-trips a live events response', () => {
    expect(liveEventsResponseSchema.parse({ events: [event] })).toEqual({ events: [event] })
  })
  it('rejects draft/ended states on the wire', () => {
    for (const state of ['draft', 'ended', 'nope'])
      expect(liveEventsResponseSchema.safeParse({ events: [{ ...event, state }] }).success).toBe(false)
  })
  it('validates webhook messages and exports the signature header', () => {
    expect(webhookMessageSchema.parse({ messageId: '550e8400-e29b-41d4-a716-446655440000', type: 'achievement.unlocked', data: { userId: 'u1' }, createdAt: event.startsAt }).type).toBe('achievement.unlocked')
    expect(webhookMessageSchema.safeParse({ type: 'other', data: {}, createdAt: event.startsAt }).success).toBe(false)
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-promocean-signature')
  })
})
