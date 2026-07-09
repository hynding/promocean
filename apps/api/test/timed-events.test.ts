import { describe, expect, it, vi } from 'vitest'
import type { OfferDefinition, TimedEventDefinition } from '@promocean/core'
import { createApp } from '../src/app.js'
import { logger } from '../src/logger.js'
import { makeFakes } from './fakes.js'

const mk = (over: Partial<TimedEventDefinition> = {}): TimedEventDefinition => ({
  id: 'e1', name: 'Summer Sale', description: null,
  startsAt: new Date('2026-07-01T00:00:00Z'), endsAt: new Date('2026-07-31T00:00:00Z'),
  endingSoonMinutes: 1440, multiplier: 2, enabled: true, ...over,
})

const defs = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 2 },
]
const auth = { projectId: 'p1', environment: 'test' as const, keyType: 'publishable' as const }
const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }
const body = (idem: string) => JSON.stringify({ userId: 'u1', type: 'lesson_completed', idempotencyKey: idem, occurredAt: '2026-07-15T00:00:00Z' })

describe('POST /v1/events — timed-event multiplier wiring', () => {
  it('applies the active multiplier: one event yields progress current 2 and unlocks a target-2 achievement', async () => {
    const fakes = makeFakes(defs, auth, [], [mk({ multiplier: 2 })])
    const app = createApp(fakes)
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('key_0001') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.progress).toContainEqual({ achievementId: 'a1', current: 2, target: 2 })
    expect(json.unlocks).toEqual([{ achievementId: 'a1', name: 'First Lesson', unlockedAt: expect.any(String) }])
  })

  it('with no timed events, multiplier stays 1', async () => {
    const fakes = makeFakes(defs, auth, [], [])
    const app = createApp(fakes)
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('key_0002') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.progress).toContainEqual({ achievementId: 'a1', current: 1, target: 2 })
    expect(json.unlocks).toEqual([])
  })

  it('ingests at multiplier 1 when getTimedEvents throws', async () => {
    const fakes = makeFakes(defs, auth, [], [])
    fakes.configStore.getTimedEvents = async () => { throw new Error('config plane down') }
    const app = createApp(fakes)
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('key_0003') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.progress).toContainEqual({ achievementId: 'a1', current: 1, target: 2 })
    expect(json.unlocks).toEqual([])
  })
  it('logs the timed-events fetch failure via a child logger carrying the request id', async () => {
    const fakes = makeFakes(defs, auth, [], [])
    fakes.configStore.getTimedEvents = async () => { throw new Error('config plane down') }
    const childSpy = vi.spyOn(logger, 'child')
    const app = createApp(fakes)
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('key_0003b') })
    expect(res.status).toBe(200)
    expect(childSpy).toHaveBeenCalledWith({ requestId: expect.any(String) })
    childSpy.mockRestore()
  })
})

describe('GET /v1/events/live', () => {
  it('maps live and scheduled events, excluding disabled and ended ones', async () => {
    const live = mk({ id: 'live1', name: 'Live Now', startsAt: new Date('2026-07-01T00:00:00Z'), endsAt: new Date('2026-07-20T00:00:00Z'), endingSoonMinutes: 60 })
    const scheduled = mk({ id: 'sched1', name: 'Coming Soon', startsAt: new Date('2026-08-01T00:00:00Z'), endsAt: new Date('2026-08-10T00:00:00Z') })
    const disabled = mk({ id: 'disabled1', enabled: false })
    const ended = mk({ id: 'ended1', startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-01-10T00:00:00Z') })
    const fakes = makeFakes([], auth, [], [live, scheduled, disabled, ended])
    const app = createApp(fakes)
    const res = await app.request('/v1/events/live', { headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    const ids = json.events.map((e: { eventId: string }) => e.eventId)
    expect(ids).toEqual(expect.arrayContaining(['live1', 'sched1']))
    expect(ids).not.toContain('disabled1')
    expect(ids).not.toContain('ended1')

    const liveEvent = json.events.find((e: { eventId: string }) => e.eventId === 'live1')
    expect(liveEvent.state).toBe('live')
    expect(liveEvent.secondsUntilStart).toBeNull()
    expect(typeof liveEvent.secondsUntilEnd).toBe('number')
    expect(liveEvent.secondsUntilEnd).toBeGreaterThan(0)

    const scheduledEvent = json.events.find((e: { eventId: string }) => e.eventId === 'sched1')
    expect(scheduledEvent.state).toBe('scheduled')
    expect(typeof scheduledEvent.secondsUntilStart).toBe('number')
    expect(scheduledEvent.secondsUntilStart).toBeGreaterThan(0)
    expect(typeof scheduledEvent.secondsUntilEnd).toBe('number')
    expect(scheduledEvent.secondsUntilEnd).toBeGreaterThan(0)
  })
})

describe('GET /v1/placements/:slug/offer — event-gated offers', () => {
  const baseOffer: OfferDefinition = {
    id: 'o1', placementSlug: 'homepage-banner', headline: 'Sale!', body: null, imageUrl: null,
    ctaText: null, ctaUrl: null, startsAt: null, endsAt: null, priority: 0,
    audience: { kind: 'everyone' }, timedEventId: 'e1',
  }

  it('resolves an offer attached to a currently-live event', async () => {
    const fakes = makeFakes([], auth, [baseOffer], [mk({ id: 'e1' })])
    const app = createApp(fakes)
    const res = await app.request('/v1/placements/homepage-banner/offer', { headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.offer).toMatchObject({ offerId: 'o1', headline: 'Sale!' })
  })

  it('does not resolve an offer attached to an event that is no longer active', async () => {
    const inactive = mk({ id: 'e1', startsAt: new Date('2020-01-01T00:00:00Z'), endsAt: new Date('2020-01-10T00:00:00Z') })
    const fakes = makeFakes([], auth, [baseOffer], [inactive])
    const app = createApp(fakes)
    const res = await app.request('/v1/placements/homepage-banner/offer', { headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.offer).toBeNull()
  })
})
