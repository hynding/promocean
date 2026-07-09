import { describe, expect, it } from 'vitest'
import { localDayFromOffset } from '@promocean/core'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

const auth = { projectId: 'p1', environment: 'test' as const, keyType: 'publishable' as const }
const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }
const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ userId: 'u1', type: 'lesson_completed', idempotencyKey: 'k1234567', ...over })

const defs = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1, pointsValue: 5 },
  { id: 'a2', name: 'Zero Points', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1, pointsValue: 0 },
]

describe('POST /v1/events engagement wiring', () => {
  it('forwards the tz-resolved local day to the ingestion store', async () => {
    const fakes = makeFakes(defs, auth)
    const occurredAt = '2026-07-08T23:30:00.000Z'
    const tzOffsetMinutes = 120 // UTC+2 -> local time is 2026-07-09T01:30, a different calendar day
    const app = createApp(fakes)
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers,
      body: body({ occurredAt, tzOffsetMinutes }),
    })
    expect(res.status).toBe(200)
    expect(fakes.engagementCalls).toHaveLength(1)
    expect(fakes.engagementCalls[0]!.engagement.localDay).toBe(localDayFromOffset(new Date(occurredAt), tzOffsetMinutes))
    expect(fakes.engagementCalls[0]!.engagement.localDay).toBe('2026-07-09')
  })

  it('awards eventPoints when a point rule matches the event type', async () => {
    const fakes = makeFakes(defs, auth, [], [], [], { lesson_completed: 3 })
    const app = createApp(fakes)
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body() })
    expect(res.status).toBe(200)
    expect(fakes.engagementCalls[0]!.engagement.eventPoints).toEqual({ points: 3, sourceRef: 'lesson_completed' })
  })

  it('sets eventPoints to null when no point rule matches (miss)', async () => {
    const fakes = makeFakes(defs, auth, [], [], [], { some_other_type: 3 })
    const app = createApp(fakes)
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body() })
    expect(res.status).toBe(200)
    expect(fakes.engagementCalls[0]!.engagement.eventPoints).toBeNull()
  })

  it('includes unlockPoints only for achievements with pointsValue > 0', async () => {
    const fakes = makeFakes(defs, auth)
    const app = createApp(fakes)
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body() })
    expect(res.status).toBe(200)
    // Both a1 (pointsValue 5) and a2 (pointsValue 0) hit target 1 on the first event.
    expect(fakes.engagementCalls[0]!.engagement.unlockPoints).toEqual({ a1: 5 })
  })

  it('fails open on a point-rules fetch failure: empty rules, event still ingests', async () => {
    const fakes = makeFakes(defs, auth)
    fakes.configStore.getPointRules = async () => { throw new Error('config plane down') }
    const app = createApp(fakes)
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body() })
    expect(res.status).toBe(200)
    expect((await res.json()).deduped).toBe(false)
    expect(fakes.engagementCalls[0]!.engagement.eventPoints).toBeNull()
  })
})

describe('GET /v1/users/:userId/wallet', () => {
  it('maps store balance/recent to the contract shape, converting `at` to ISO', async () => {
    const fakes = makeFakes([], auth)
    const at = new Date('2026-07-01T00:00:00.000Z')
    fakes.setWalletResult({ balance: 42, recent: [{ delta: 5, source: 'event', sourceRef: 'lesson_completed', at }] })
    const res = await createApp(fakes).request('/v1/users/u1/wallet', { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      balance: 42,
      recent: [{ delta: 5, source: 'event', sourceRef: 'lesson_completed', at: at.toISOString() }],
    })
  })

  it('returns the empty-wallet default when the user has no ledger activity', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/users/u1/wallet', { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ balance: 0, recent: [] })
  })

  it('rejects a userId over 128 chars with invalid_payload', async () => {
    const fakes = makeFakes([], auth)
    const longId = 'u'.repeat(129)
    const res = await createApp(fakes).request(`/v1/users/${longId}/wallet`, { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('allows a userId of exactly 128 chars', async () => {
    const fakes = makeFakes([], auth)
    const okId = 'u'.repeat(128)
    const res = await createApp(fakes).request(`/v1/users/${okId}/wallet`, { headers })
    expect(res.status).toBe(200)
  })
})

describe('GET /v1/users/:userId/streak', () => {
  it('maps store fields to the contract shape', async () => {
    const fakes = makeFakes([], auth)
    fakes.setStreakResult({ current: 4, longest: 9, lastActiveDay: '2026-07-08' })
    const res = await createApp(fakes).request('/v1/users/u1/streak', { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ current: 4, longest: 9, lastActiveDay: '2026-07-08' })
  })

  it('returns the empty-streak default (lastActiveDay null) for a fresh user', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/users/u1/streak', { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ current: 0, longest: 0, lastActiveDay: null })
  })

  it('rejects a userId over 128 chars with invalid_payload', async () => {
    const fakes = makeFakes([], auth)
    const longId = 'u'.repeat(129)
    const res = await createApp(fakes).request(`/v1/users/${longId}/streak`, { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('allows a userId of exactly 128 chars', async () => {
    const fakes = makeFakes([], auth)
    const okId = 'u'.repeat(128)
    const res = await createApp(fakes).request(`/v1/users/${okId}/streak`, { headers })
    expect(res.status).toBe(200)
  })
})

describe('GET /v1/leaderboard', () => {
  it('defaults to window=all, limit=10 and responds with { window, entries }', async () => {
    const fakes = makeFakes([], auth)
    fakes.setLeaderboardResult([{ rank: 1, userId: 'u1', points: 10 }])
    const res = await createApp(fakes).request('/v1/leaderboard', { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ window: 'all', entries: [{ rank: 1, userId: 'u1', points: 10 }] })
    expect(fakes.leaderboardCalls[0]).toMatchObject({ window: 'all', limit: 10 })
  })

  it('returns an empty entries array when there is no leaderboard activity', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/leaderboard', { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ window: 'all', entries: [] })
  })

  it('forwards an explicit window and limit query', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/leaderboard?window=7d&limit=25', { headers })
    expect(res.status).toBe(200)
    expect((await res.json()).window).toBe('7d')
    expect(fakes.leaderboardCalls[0]).toMatchObject({ window: '7d', limit: 25 })
  })

  it('rejects an invalid window with invalid_payload', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/leaderboard?window=nope', { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('rejects a limit outside 1..100 with invalid_payload', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/leaderboard?limit=0', { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('rejects limit=101 with invalid_payload', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/leaderboard?limit=101', { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('accepts limit=100', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/leaderboard?limit=100', { headers })
    expect(res.status).toBe(200)
    expect(fakes.leaderboardCalls[0]).toMatchObject({ limit: 100 })
  })

  it('accepts limit=1', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/leaderboard?limit=1', { headers })
    expect(res.status).toBe(200)
    expect(fakes.leaderboardCalls[0]).toMatchObject({ limit: 1 })
  })

  it('rejects a non-integer limit with invalid_payload', async () => {
    const fakes = makeFakes([], auth)
    const res = await createApp(fakes).request('/v1/leaderboard?limit=abc', { headers })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })
})
