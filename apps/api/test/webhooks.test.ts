import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEBHOOK_SIGNATURE_HEADER, type WebhookMessage } from '@promocean/contracts'
import type { ConfigStore, TimedEventDefinition, WebhookDeliveryStore, WebhookEndpointDefinition } from '@promocean/core'
import { WebhookDispatcher, startLifecycleScheduler } from '../src/webhooks.js'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

function makeDeliveryStore() {
  const claimed = new Set<string>()
  const deadLetters: Array<{ projectId: string; url: string; payload: string; error: string; at: Date }> = []
  const deliveryStore: WebhookDeliveryStore = {
    claimTransition: async (projectId, eventId, transition) => {
      const key = `${projectId}:${eventId}:${transition}`
      if (claimed.has(key)) return false
      claimed.add(key)
      return true
    },
    recordDeadLetter: async (projectId, url, payload, error, at) => {
      deadLetters.push({ projectId, url, payload, error, at })
    },
  }
  return { deliveryStore, deadLetters }
}

function makeConfigStore(opts: {
  endpoints?: WebhookEndpointDefinition[]
  allTimedEvents?: Array<TimedEventDefinition & { projectId: string }>
} = {}): ConfigStore {
  return {
    getAchievements: async () => [],
    getOffers: async () => [],
    getTimedEvents: async () => [],
    getAllTimedEvents: async () => opts.allTimedEvents ?? [],
    getWebhookEndpoints: async () => opts.endpoints ?? [],
  }
}

const message: WebhookMessage = {
  type: 'achievement.unlocked',
  data: { userId: 'u1', environment: 'test', unlocks: [] },
  createdAt: '2026-07-06T00:00:00.000Z',
}

const endpointA: WebhookEndpointDefinition = { id: 'ep1', url: 'https://hooks.test/a', secret: 'secret-a', enabled: true }
const endpointB: WebhookEndpointDefinition = { id: 'ep2', url: 'https://hooks.test/b', secret: 'secret-b', enabled: true }
const disabledEndpoint: WebhookEndpointDefinition = { id: 'ep3', url: 'https://hooks.test/c', secret: 'secret-c', enabled: false }

describe('WebhookDispatcher.deliver — group A (happy path + signing)', () => {
  it('posts to both enabled endpoints with a correct per-secret HMAC signature, skipping disabled endpoints', async () => {
    const { deliveryStore } = makeDeliveryStore()
    const configStore = makeConfigStore({ endpoints: [endpointA, endpointB, disabledEndpoint] })
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })))
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl })

    await dispatcher.deliver('p1', message)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
    const byUrl = new Map(calls.map(([url, init]) => [url, init]))
    expect([...byUrl.keys()].sort()).toEqual([endpointA.url, endpointB.url].sort())

    for (const [endpoint, url] of [[endpointA, endpointA.url], [endpointB, endpointB.url]] as const) {
      const init = byUrl.get(url)!
      expect(init.method).toBe('POST')
      const rawBody = init.body as string
      const expectedSig = createHmac('sha256', endpoint.secret).update(rawBody).digest('hex')
      const headers = init.headers as Record<string, string>
      expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(expectedSig)
      expect(JSON.parse(rawBody)).toEqual(message)
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('never throws even when getWebhookEndpoints rejects', async () => {
    const { deliveryStore } = makeDeliveryStore()
    const configStore = makeConfigStore()
    configStore.getWebhookEndpoints = async () => { throw new Error('config plane down') }
    const fetchImpl = vi.fn()
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl })
    await expect(dispatcher.deliver('p1', message)).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('WebhookDispatcher.deliver — group B (failure handling)', () => {
  it('retries a 5xx then succeeds, without recording a dead letter', async () => {
    const { deliveryStore, deadLetters } = makeDeliveryStore()
    const configStore = makeConfigStore({ endpoints: [endpointA] })
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })))
      .mockImplementation(() => Promise.resolve(new Response('', { status: 200 })))
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl, maxRetries: 1 })

    await dispatcher.deliver('p1', message)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(deadLetters).toEqual([])
  })

  it('persistent 5xx dead-letters that endpoint while the other endpoint still delivers', async () => {
    const { deliveryStore, deadLetters } = makeDeliveryStore()
    const configStore = makeConfigStore({ endpoints: [endpointA, endpointB] })
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === endpointA.url) return Promise.resolve(new Response('', { status: 500 }))
      return Promise.resolve(new Response('', { status: 200 }))
    })
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl, maxRetries: 1 })

    await dispatcher.deliver('p1', message)

    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0].url).toBe(endpointA.url)
    expect(JSON.parse(deadLetters[0].payload)).toEqual(message)
    expect(typeof deadLetters[0].error).toBe('string')
    expect(deadLetters[0].at).toBeInstanceOf(Date)

    const bCalls = fetchImpl.mock.calls.filter(([url]) => url === endpointB.url)
    expect(bCalls).toHaveLength(1)
    const aCalls = fetchImpl.mock.calls.filter(([url]) => url === endpointA.url)
    expect(aCalls).toHaveLength(2) // initial attempt + 1 retry
  })

  it('a 4xx response dead-letters immediately with exactly one fetch call, no retry', async () => {
    const { deliveryStore, deadLetters } = makeDeliveryStore()
    const configStore = makeConfigStore({ endpoints: [endpointA] })
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 400 })))
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl, maxRetries: 3 })

    await dispatcher.deliver('p1', message)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0].url).toBe(endpointA.url)
  })
})

const mkEvent = (over: Partial<TimedEventDefinition> = {}): TimedEventDefinition & { projectId: string } => ({
  id: 'e1', projectId: 'p1', name: 'Summer Sale', description: null,
  startsAt: new Date('2026-07-01T00:00:00Z'), endsAt: new Date('2026-07-31T00:00:00Z'),
  endingSoonMinutes: 60, multiplier: 2, enabled: true, ...over,
})

describe('startLifecycleScheduler — group C', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function fakeDispatcher() {
    return { deliver: vi.fn(async () => {}) } as unknown as { deliver: ReturnType<typeof vi.fn> } & WebhookDispatcher
  }

  it('claims and fires the live transition exactly once across two ticks', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z')) // well inside live window, not ending soon
    const event = mkEvent()
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatcher.deliver).toHaveBeenCalledTimes(1)
    expect(dispatcher.deliver.mock.calls[0][0]).toBe('p1')
    expect(dispatcher.deliver.mock.calls[0][1]).toMatchObject({ type: 'timed_event.live' })

    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatcher.deliver).toHaveBeenCalledTimes(1) // already claimed, no re-fire

    stop()
  })

  it('fires live then ending_soon in order on one tick for an event first observed ending_soon', async () => {
    // endsAt is 30 minutes away, endingSoonMinutes is 60 -> ending_soon on first observation
    vi.setSystemTime(new Date('2026-07-30T23:30:00Z'))
    const event = mkEvent({ endingSoonMinutes: 60 })
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)

    expect(dispatcher.deliver).toHaveBeenCalledTimes(2)
    expect(dispatcher.deliver.mock.calls[0][1]).toMatchObject({ type: 'timed_event.live' })
    expect(dispatcher.deliver.mock.calls[1][1]).toMatchObject({ type: 'timed_event.ending_soon' })

    stop()
  })

  it('fires nothing for a disabled (draft) event', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const event = mkEvent({ enabled: false })
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)

    expect(dispatcher.deliver).not.toHaveBeenCalled()
    stop()
  })

  it('stop() halts ticking', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const event = mkEvent()
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatcher.deliver).toHaveBeenCalledTimes(1)

    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(dispatcher.deliver).toHaveBeenCalledTimes(1) // no further ticks after stop
  })

  it('tick failures never throw out of the interval (catch-all)', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const configStore = makeConfigStore()
    configStore.getAllTimedEvents = async () => { throw new Error('config plane down') }
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000) // must not throw / reject
    expect(dispatcher.deliver).not.toHaveBeenCalled()
    stop()
  })
})

describe('POST /v1/events — group D (unlock webhook wiring)', () => {
  const defs = [
    { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 },
  ]
  const auth = { projectId: 'p1', environment: 'test' as const, keyType: 'publishable' as const }
  const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }
  const body = (idem: string) => JSON.stringify({ userId: 'u1', type: 'lesson_completed', idempotencyKey: idem })

  function fakeDispatcher(deliverImpl?: () => Promise<void>) {
    return { deliver: vi.fn(deliverImpl ?? (async () => {})) } as unknown as { deliver: ReturnType<typeof vi.fn> } & WebhookDispatcher
  }

  it('fires an achievement.unlocked webhook after an unlocking track', async () => {
    const fakes = makeFakes(defs, auth)
    const webhooks = fakeDispatcher()
    const app = createApp({ ...fakes, webhooks })
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('key_aaaaa') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.unlocks).toEqual([{ achievementId: 'a1', name: 'First Lesson', unlockedAt: expect.any(String) }])

    // allow the fire-and-forget microtask to run
    await Promise.resolve()
    await Promise.resolve()
    expect(webhooks.deliver).toHaveBeenCalledTimes(1)
    expect(webhooks.deliver.mock.calls[0][0]).toBe('p1')
    expect(webhooks.deliver.mock.calls[0][1]).toMatchObject({
      type: 'achievement.unlocked',
      data: { userId: 'u1', environment: 'test', unlocks: json.unlocks },
    })
  })

  it('response is unaffected when the webhook dispatch rejects', async () => {
    const fakes = makeFakes(defs, auth)
    const webhooks = fakeDispatcher(async () => { throw new Error('dispatcher exploded') })
    const app = createApp({ ...fakes, webhooks })
    const res = await app.request('/v1/events', { method: 'POST', headers, body: body('key_bbbbb') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.unlocks).toEqual([{ achievementId: 'a1', name: 'First Lesson', unlockedAt: expect.any(String) }])
    await Promise.resolve()
    await Promise.resolve()
  })

  it('does not fire a webhook when there are no unlocks', async () => {
    const fakes = makeFakes(defs, auth)
    const webhooks = fakeDispatcher()
    const app = createApp({ ...fakes, webhooks })
    // second identical event: nothing new unlocked since target is 1 and already unlocked would need a prior track;
    // instead use an achievement that isn't reached (unrelated event type) so unlocks stays empty
    const res = await app.request('/v1/events', { method: 'POST', headers, body: JSON.stringify({ userId: 'u1', type: 'other_event', idempotencyKey: 'key_ccccc' }) })
    expect(res.status).toBe(200)
    await Promise.resolve()
    await Promise.resolve()
    expect(webhooks.deliver).not.toHaveBeenCalled()
  })
})
