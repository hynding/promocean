import { describe, expect, it } from 'vitest'
import type { AuthContext } from '@promocean/core'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }
const defs = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1, pointsValue: 0 },
]
const trackBody = (userId: string) => JSON.stringify({ userId, type: 'lesson_completed', idempotencyKey: `idem-key-${userId}` })

function skAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return { projectId: 'p1', environment: 'test', keyType: 'secret', allowedOrigins: null, plan: null, ...overrides }
}
function pkLiveAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return { projectId: 'p1', environment: 'live', keyType: 'publishable', allowedOrigins: null, plan: null, ...overrides }
}

describe('GET /v1/usage', () => {
  it('rejects publishable keys with 403 forbidden', async () => {
    const fakes = makeFakes(defs, pkLiveAuth())
    const res = await createApp(fakes).request('/v1/usage', { headers })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  it('reports the current month, unmetered, when no plan is set', async () => {
    const fakes = makeFakes(defs, skAuth())
    fakes.setUsageResult({ mau: 42, events: 99 })
    const res = await createApp(fakes).request('/v1/usage', { headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.month).toBe(new Date().toISOString().slice(0, 7))
    expect(json).toMatchObject({
      environment: 'test', mau: 42, events: 99,
      plan: null, mauIncluded: null, percentUsed: null, overLimit: false,
    })
  })

  it('evaluates plan standing against the LIVE environment for a test-env key', async () => {
    const fakes = makeFakes(defs, skAuth({ plan: 'free' }))
    fakes.setUsageResult({ mau: 1_500, events: 10 })
    const res = await createApp(fakes).request('/v1/usage', { headers })
    const json = await res.json()
    expect(json.plan).toBe('free')
    expect(json.mauIncluded).toBe(1_000)
    expect(json.overLimit).toBe(true)
    // Both the auth scope and the live scope were consulted.
    expect(fakes.usageCalls.map((call) => call.scope.environment)).toEqual(['test', 'live'])
  })

  it('accepts an explicit ?month= and rejects a malformed one', async () => {
    const fakes = makeFakes(defs, skAuth())
    const app = createApp(fakes)
    const ok = await app.request('/v1/usage?month=2026-01', { headers })
    expect(ok.status).toBe(200)
    expect((await ok.json()).month).toBe('2026-01')
    expect(fakes.usageCalls[0]).toMatchObject({ month: '2026-01' })

    const bad = await app.request('/v1/usage?month=2026-13', { headers })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('invalid_payload')
  })
})

describe('plan-limit gate on POST /v1/events', () => {
  it('runs no usage queries when the project has no plan', async () => {
    const fakes = makeFakes(defs, pkLiveAuth())
    const res = await createApp(fakes).request('/v1/events', { method: 'POST', headers, body: trackBody('u1') })
    expect(res.status).toBe(200)
    expect(fakes.usageCalls).toEqual([])
  })

  it('runs no usage queries for a test-environment key even with a plan', async () => {
    const fakes = makeFakes(defs, skAuth({ plan: 'free', environment: 'test' }))
    fakes.setUsageResult({ mau: 5_000, events: 0 })
    const res = await createApp(fakes).request('/v1/events', { method: 'POST', headers, body: trackBody('u1') })
    expect(res.status).toBe(200)
    expect(fakes.usageCalls).toEqual([])
  })

  it('warn mode (default): over-limit ingests pass with an x-promocean-usage header', async () => {
    const fakes = makeFakes(defs, pkLiveAuth({ plan: 'free' }))
    fakes.setUsageResult({ mau: 1_200, events: 0 })
    const res = await createApp(fakes).request('/v1/events', { method: 'POST', headers, body: trackBody('u1') })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-promocean-usage')).toBe('over-limit; mau=1200; included=1000')
  })

  it('warn mode: under-limit ingests carry no usage header', async () => {
    const fakes = makeFakes(defs, pkLiveAuth({ plan: 'free' }))
    fakes.setUsageResult({ mau: 900, events: 0 })
    const res = await createApp(fakes).request('/v1/events', { method: 'POST', headers, body: trackBody('u1') })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-promocean-usage')).toBeNull()
  })

  it('block mode: rejects an over-limit ingest from a NEW user with 402 mau_limit_exceeded', async () => {
    const fakes = makeFakes(defs, pkLiveAuth({ plan: 'free' }))
    fakes.setUsageResult({ mau: 1_200, events: 0 })
    const app = createApp(fakes, { usageEnforcement: 'block' })
    const res = await app.request('/v1/events', { method: 'POST', headers, body: trackBody('new-user') })
    expect(res.status).toBe(402)
    const json = await res.json()
    expect(json.error.code).toBe('mau_limit_exceeded')
    expect(json.error.details).toMatchObject({ mau: 1_200, mauIncluded: 1_000, plan: 'free' })
  })

  it('block mode: never locks out a user already active this month', async () => {
    const fakes = makeFakes(defs, pkLiveAuth({ plan: 'free' }))
    fakes.setUsageResult({ mau: 1_200, events: 0 })
    fakes.setActiveUserIds(['returning-user'])
    const app = createApp(fakes, { usageEnforcement: 'block' })
    const res = await app.request('/v1/events', { method: 'POST', headers, body: trackBody('returning-user') })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-promocean-usage')).toBe('over-limit; mau=1200; included=1000')
  })

  it('off mode: no queries, no headers, no blocks', async () => {
    const fakes = makeFakes(defs, pkLiveAuth({ plan: 'free' }))
    fakes.setUsageResult({ mau: 9_999, events: 0 })
    const app = createApp(fakes, { usageEnforcement: 'off' })
    const res = await app.request('/v1/events', { method: 'POST', headers, body: trackBody('u1') })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-promocean-usage')).toBeNull()
    expect(fakes.usageCalls).toEqual([])
  })

  it('fails open when the usage store errors', async () => {
    const fakes = makeFakes(defs, pkLiveAuth({ plan: 'free' }))
    fakes.usageStore.getUsage = async () => { throw new Error('db down') }
    const app = createApp(fakes, { usageEnforcement: 'block' })
    const res = await app.request('/v1/events', { method: 'POST', headers, body: trackBody('u1') })
    expect(res.status).toBe(200)
  })
})
