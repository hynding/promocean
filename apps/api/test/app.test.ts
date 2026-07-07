import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

const defs = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 },
  { id: 'a2', name: 'Getting Started', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 10 },
]
const auth = { projectId: 'p1', environment: 'test' as const, keyType: 'publishable' as const }
const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }
const body = (idem: string) => JSON.stringify({ userId: 'u1', type: 'lesson_completed', idempotencyKey: idem })

function app() { return createApp(makeFakes(defs, auth)) }

describe('POST /v1/events', () => {
  it('rejects missing/invalid keys with invalid_api_key', async () => {
    const res = await app().request('/v1/events', { method: 'POST', body: body('k1234567'), headers: { ...headers, authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('invalid_api_key')
  })
  it('rejects bad payloads with invalid_payload', async () => {
    const res = await app().request('/v1/events', { method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })
  it('tracks, unlocks at target, and reports progress', async () => {
    const res = await app().request('/v1/events', { method: 'POST', headers, body: body('k1234567') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.deduped).toBe(false)
    expect(json.unlocks).toEqual([{ achievementId: 'a1', name: 'First Lesson', unlockedAt: expect.any(String) }])
    expect(json.progress).toContainEqual({ achievementId: 'a2', current: 1, target: 10 })
  })
  it('dedupes idempotency-key replays', async () => {
    const a = app()
    await a.request('/v1/events', { method: 'POST', headers, body: body('same_key_1') })
    const res = await a.request('/v1/events', { method: 'POST', headers, body: body('same_key_1') })
    const json = await res.json()
    expect(json.deduped).toBe(true)
    expect(json.unlocks).toEqual([])
  })
})

describe('GET /v1/users/:userId/achievements', () => {
  it('joins definitions with progress and unlock state', async () => {
    const a = app()
    await a.request('/v1/events', { method: 'POST', headers, body: body('k7654321') })
    const res = await a.request('/v1/users/u1/achievements', { headers })
    const json = await res.json()
    expect(json.achievements).toContainEqual({
      achievementId: 'a1', name: 'First Lesson', description: null, artworkUrl: null,
      current: 1, target: 1, unlockedAt: expect.any(String),
    })
    expect(json.achievements).toContainEqual({
      achievementId: 'a2', name: 'Getting Started', description: null, artworkUrl: null,
      current: 1, target: 10, unlockedAt: null,
    })
  })
})

describe('GET /healthz', () => {
  it('returns ok without auth', async () => {
    const res = await app().request('/healthz')
    expect(res.status).toBe(200)
  })
})
