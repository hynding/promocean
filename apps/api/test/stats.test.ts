import { describe, expect, it, vi } from 'vitest'
import type { AuthContext } from '@promocean/core'
import { createApp } from '../src/app.js'
import { logger } from '../src/logger.js'
import { makeFakes } from './fakes.js'

const timedEvents = [
  {
    id: 'te1', name: 'Summer Sprint', description: null,
    startsAt: new Date('2026-01-01T00:00:00.000Z'), endsAt: new Date('2026-01-08T00:00:00.000Z'),
    endingSoonMinutes: 60, multiplier: 2, enabled: true,
  },
]
const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }

function pkAuth(): AuthContext { return { projectId: 'p1', environment: 'test', keyType: 'publishable', allowedOrigins: null } }
function skAuth(): AuthContext { return { projectId: 'p1', environment: 'test', keyType: 'secret', allowedOrigins: null } }

function setup(auth: AuthContext) {
  const fakes = makeFakes([], auth, [], timedEvents)
  return { app: createApp(fakes, { rateLimitPerMinute: 0 }), fakes }
}

describe('GET /v1/stats', () => {
  it('publishable key -> 403 forbidden', async () => {
    const { app } = setup(pkAuth())
    const res = await app.request('/v1/stats', { headers })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  it('secret key -> 200 with stats data and correct ctr math (incl. null for zero impressions)', async () => {
    const { app, fakes } = setup(skAuth())
    fakes.setStatsResult({
      totals: { events: 10, unlocks: 3, impressions: 20, clicks: 5, timedEventParticipants: 7 },
      achievements: [{ achievementId: 'a1', unlocks: 3 }],
      offers: [
        { offerId: 'o1', impressions: 20, clicks: 5 },
        { offerId: 'o2', impressions: 0, clicks: 0 },
      ],
      timedEvents: [{ eventId: 'te1', participants: 7 }],
    })
    const res = await app.request('/v1/stats', { headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.totals).toEqual({ events: 10, unlocks: 3, impressions: 20, clicks: 5, timedEventParticipants: 7 })
    expect(json.achievements).toEqual([{ achievementId: 'a1', unlocks: 3 }])
    expect(json.offers).toEqual([
      { offerId: 'o1', impressions: 20, clicks: 5, ctr: 0.25 },
      { offerId: 'o2', impressions: 0, clicks: 0, ctr: null },
    ])
    expect(json.timedEvents).toEqual([{ eventId: 'te1', name: 'Summer Sprint', participants: 7 }])
    expect(json.range).toEqual({ from: null, to: null })
  })

  it('bad date query param -> 400 invalid_payload', async () => {
    const { app } = setup(skAuth())
    const res = await app.request('/v1/stats?from=not-a-date', { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('from > to -> 400 invalid_payload', async () => {
    const { app } = setup(skAuth())
    const res = await app.request('/v1/stats?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z', { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('forwards the parsed range to the stats store and echoes it back', async () => {
    const { app, fakes } = setup(skAuth())
    const res = await app.request('/v1/stats?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z', { headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.range).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' })
    expect(fakes.statsCalls).toHaveLength(1)
    expect(fakes.statsCalls[0]!.scope).toEqual({ projectId: 'p1', environment: 'test' })
    expect(fakes.statsCalls[0]!.range).toEqual({ from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-01-31T00:00:00.000Z') })
    expect(fakes.statsCalls[0]!.timedEventWindows).toEqual([{ eventId: 'te1', startsAt: timedEvents[0]!.startsAt, endsAt: timedEvents[0]!.endsAt }])
  })

  it('config-store failure -> 200 with empty timedEvents (stats still serve)', async () => {
    const { app, fakes } = setup(skAuth())
    fakes.configStore.getTimedEvents = async () => { throw new Error('config plane down') }
    fakes.setStatsResult({
      totals: { events: 0, unlocks: 0, impressions: 0, clicks: 0, timedEventParticipants: 0 },
      achievements: [],
      offers: [],
      timedEvents: [],
    })
    const res = await app.request('/v1/stats', { headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.timedEvents).toEqual([])
    expect(fakes.statsCalls[0]!.timedEventWindows).toEqual([])
  })

  it('logs the timed-events fetch failure via a child logger carrying the request id', async () => {
    const { app, fakes } = setup(skAuth())
    fakes.configStore.getTimedEvents = async () => { throw new Error('config plane down') }
    const childSpy = vi.spyOn(logger, 'child')
    const res = await app.request('/v1/stats', { headers })
    expect(res.status).toBe(200)
    expect(childSpy).toHaveBeenCalledWith({ requestId: expect.any(String) })
    childSpy.mockRestore()
  })
})
