import { describe, expect, it, vi } from 'vitest'
import type { WebhookDispatcher } from '../src/webhooks.js'
import { createApp } from '../src/app.js'
import { logger } from '../src/logger.js'
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
  it('rejects an unregistered event type with a close-match suggestion', async () => {
    const app = createApp(makeFakes(defs, auth, [], [], ['lesson_completed']))
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: 'u1', type: 'lesson_complete', idempotencyKey: 'k1234567' }),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toEqual({
      code: 'unregistered_event_type',
      message: 'Unknown event type "lesson_complete".',
      details: { suggestion: 'lesson_completed' },
    })
  })
  it('rejects an unregistered event type with a null suggestion when nothing is close', async () => {
    const app = createApp(makeFakes(defs, auth, [], [], ['lesson_completed']))
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: 'u1', type: 'totally_different_x', idempotencyKey: 'k1234567' }),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('unregistered_event_type')
    expect(json.error.details).toEqual({ suggestion: null })
  })
  it('does not enforce registered event types when the list is empty', async () => {
    const app = createApp(makeFakes(defs, auth, [], [], []))
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: 'u1', type: 'totally_unregistered_type', idempotencyKey: 'k1234567' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).deduped).toBe(false)
  })
  it('still ingests when the registered-event-types fetch fails (fails open)', async () => {
    const fakes = makeFakes(defs, auth, [], [], ['lesson_completed'])
    fakes.configStore.getRegisteredEventTypes = async () => { throw new Error('config plane down') }
    const res = await createApp(fakes).request('/v1/events', { method: 'POST', headers, body: body('k1234567') })
    expect(res.status).toBe(200)
    expect((await res.json()).deduped).toBe(false)
  })
  it('logs the registered-event-types fetch failure via a child logger carrying the request id', async () => {
    const fakes = makeFakes(defs, auth, [], [], ['lesson_completed'])
    fakes.configStore.getRegisteredEventTypes = async () => { throw new Error('config plane down') }
    const childSpy = vi.spyOn(logger, 'child')
    const res = await createApp(fakes).request('/v1/events', { method: 'POST', headers, body: body('k1234567') })
    expect(res.status).toBe(200)
    expect(childSpy).toHaveBeenCalledWith({ requestId: expect.any(String) })
    childSpy.mockRestore()
  })
  it('falls back to the achievement id as the name when a reported unlock is absent from the increments plan', async () => {
    // Regression guard for a store/evaluation mismatch: the ingestion store is the source of
    // truth for *which* achievements unlocked, but names come from the increments plan built
    // from this request's evaluateEvent() call. If the store reports an unlock for an id that
    // plan doesn't know about (e.g. config changed between evaluation and commit), nameById.get
    // would previously return undefined and `!`-assert past it — a type-level lie with no
    // runtime effect, except that c.json's JSON.stringify() drops undefined-valued keys, so the
    // response's unlock silently loses its "name" key instead of crashing.
    const fakes = makeFakes(defs, auth)
    fakes.ingestionStore.ingestEvent = async () => ({
      deduped: false,
      progress: [],
      newUnlocks: [{ achievementId: 'ghost-achievement', unlockedAt: new Date('2026-07-08T00:00:00.000Z') }],
    })
    const res = await createApp(fakes).request('/v1/events', { method: 'POST', headers, body: body('ghost0001') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.unlocks).toEqual([
      { achievementId: 'ghost-achievement', name: 'ghost-achievement', unlockedAt: '2026-07-08T00:00:00.000Z' },
    ])
  })
})

describe('POST /v1/events webhook dispatch', () => {
  function fakeWebhooks() {
    return { deliver: vi.fn(async () => {}) } as unknown as { deliver: ReturnType<typeof vi.fn> } & WebhookDispatcher
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('dispatches an achievement.unlocked webhook when the event produces a new unlock', async () => {
    const webhooks = fakeWebhooks()
    const app = createApp({ ...makeFakes(defs, auth), webhooks })
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('wk1_00001') })
    expect(res.status).toBe(200)
    await flush()
    expect(webhooks.deliver).toHaveBeenCalledTimes(1)
    expect(webhooks.deliver.mock.calls[0][0]).toBe('p1')
    expect(webhooks.deliver.mock.calls[0][1]).toMatchObject({
      type: 'achievement.unlocked',
      data: { userId: 'u1', environment: 'test' },
    })
  })
  it('does not dispatch a webhook when the event produces no new unlock', async () => {
    const webhooks = fakeWebhooks()
    const noUnlockDefs = [{ id: 'a2', name: 'Getting Started', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 10 }]
    const app = createApp({ ...makeFakes(noUnlockDefs, auth), webhooks })
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('wk2_00001') })
    expect(res.status).toBe(200)
    await flush()
    expect(webhooks.deliver).not.toHaveBeenCalled()
  })
  it('does not dispatch a webhook on a deduped replay', async () => {
    const webhooks = fakeWebhooks()
    const app = createApp({ ...makeFakes(defs, auth), webhooks })
    await app.request('/v1/events', { method: 'POST', headers, body: body('wk3_00001') })
    await flush()
    webhooks.deliver.mockClear()
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('wk3_00001') })
    expect((await res.json()).deduped).toBe(true)
    await flush()
    expect(webhooks.deliver).not.toHaveBeenCalled()
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

describe('GET /readyz', () => {
  it('returns ok with checks: skipped when no readiness deps are configured', async () => {
    const res = await app().request('/readyz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, checks: 'skipped' })
  })

  it('returns 200 when both checks pass', async () => {
    const deps = { ...makeFakes(defs, auth), readiness: { checkDb: async () => {}, checkConfigPlane: async () => {} } }
    const res = await createApp(deps).request('/readyz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns 503 naming the failing check when one rejects', async () => {
    const deps = {
      ...makeFakes(defs, auth),
      readiness: { checkDb: async () => { throw new Error('db down') }, checkConfigPlane: async () => {} },
    }
    const res = await createApp(deps).request('/readyz')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, failing: ['db'] })
  })

  it('returns 503 naming both failing checks when both reject', async () => {
    const deps = {
      ...makeFakes(defs, auth),
      readiness: {
        checkDb: async () => { throw new Error('db down') },
        checkConfigPlane: async () => { throw new Error('config plane down') },
      },
    }
    const res = await createApp(deps).request('/readyz')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, failing: ['db', 'configPlane'] })
  })

  it('does not require auth', async () => {
    const res = await app().request('/readyz')
    expect(res.status).toBe(200)
  })
})

describe('request id middleware', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  it('sets an x-request-id header shaped like a uuid on every response', async () => {
    const res = await app().request('/healthz')
    expect(res.headers.get('x-request-id')).toMatch(UUID_RE)
  })

  it('sets a distinct x-request-id per request', async () => {
    const a = app()
    const res1 = await a.request('/healthz')
    const res2 = await a.request('/healthz')
    expect(res1.headers.get('x-request-id')).not.toBe(res2.headers.get('x-request-id'))
  })
})
