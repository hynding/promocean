import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'
import { WEBHOOK_SIGNATURE_HEADER, type WebhookMessage } from '@promocean/contracts'
import type { ConfigStore, TimedEventDefinition, WebhookDeliveryStore, WebhookEndpointDefinition } from '@promocean/core'
import { WebhookDispatcher, resolveScanGraceMinutes, startLifecycleScheduler } from '../src/webhooks.js'
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
    // Safe no-op defaults for tests that don't exercise redelivery/retention directly —
    // individual tests below override whichever of these they need to assert on.
    markDelivered: async () => {},
    findStaleClaims: async () => [],
    incrementAttempts: async () => {},
    deleteDeadLettersBefore: async () => 0,
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
  messageId: '11111111-1111-4111-8111-111111111111',
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

describe('WebhookDispatcher.deliverTransition — group B2 (delivered-marking)', () => {
  it('marks the claim delivered once every endpoint has resolved (succeeded or dead-lettered)', async () => {
    const { deliveryStore } = makeDeliveryStore()
    const marked: Array<[string, string, string]> = []
    deliveryStore.markDelivered = async (projectId, eventId, transition) => { marked.push([projectId, eventId, transition]) }
    const configStore = makeConfigStore({ endpoints: [endpointA, endpointB] })
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === endpointA.url) return Promise.resolve(new Response('', { status: 400 })) // dead-lettered
      return Promise.resolve(new Response('', { status: 200 })) // succeeded
    })
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl })

    await dispatcher.deliverTransition('p1', 'e1', 'live', { ...message, type: 'timed_event.live' })

    expect(marked).toEqual([['p1', 'e1', 'live']])
  })

  it('leaves the claim unmarked when deliver itself throws (simulated crash before markDelivered)', async () => {
    const { deliveryStore } = makeDeliveryStore()
    const marked: unknown[] = []
    deliveryStore.markDelivered = async () => { marked.push(true) }
    const configStore = makeConfigStore({ endpoints: [endpointA] })
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl: vi.fn() })
    vi.spyOn(dispatcher, 'deliver').mockRejectedValue(new Error('simulated crash'))

    await expect(dispatcher.deliverTransition('p1', 'e1', 'live', { ...message, type: 'timed_event.live' })).rejects.toThrow('simulated crash')

    expect(marked).toEqual([])
  })
})

const mkEvent = (over: Partial<TimedEventDefinition> = {}): TimedEventDefinition & { projectId: string } => ({
  id: 'e1', projectId: 'p1', name: 'Summer Sale', description: null,
  startsAt: new Date('2026-07-01T00:00:00Z'), endsAt: new Date('2026-07-31T00:00:00Z'),
  endingSoonMinutes: 60, multiplier: 2, enabled: true, ...over,
})

type FakeDispatcher = { deliver: ReturnType<typeof vi.fn>; deliverTransition: ReturnType<typeof vi.fn> } & WebhookDispatcher

function fakeDispatcher(deliverTransitionImpl?: (...args: unknown[]) => Promise<void>): FakeDispatcher {
  return {
    deliver: vi.fn(async () => {}),
    deliverTransition: vi.fn(deliverTransitionImpl ?? (async () => {})),
  } as unknown as FakeDispatcher
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('startLifecycleScheduler — group C (transition scan)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('claims and fires the live transition exactly once across two ticks, with a uuid messageId', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z')) // well inside live window, not ending soon
    const event = mkEvent()
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatcher.deliverTransition).toHaveBeenCalledTimes(1)
    expect(dispatcher.deliverTransition.mock.calls[0][0]).toBe('p1')
    expect(dispatcher.deliverTransition.mock.calls[0][1]).toBe('e1')
    expect(dispatcher.deliverTransition.mock.calls[0][2]).toBe('live')
    expect(dispatcher.deliverTransition.mock.calls[0][3]).toMatchObject({ type: 'timed_event.live' })
    expect(dispatcher.deliverTransition.mock.calls[0][3].messageId).toMatch(UUID_RE)

    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatcher.deliverTransition).toHaveBeenCalledTimes(1) // already claimed, no re-fire

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

    expect(dispatcher.deliverTransition).toHaveBeenCalledTimes(2)
    expect(dispatcher.deliverTransition.mock.calls[0][3]).toMatchObject({ type: 'timed_event.live' })
    expect(dispatcher.deliverTransition.mock.calls[1][3]).toMatchObject({ type: 'timed_event.ending_soon' })
    // fresh messageId per message, even within the same tick
    expect(dispatcher.deliverTransition.mock.calls[0][3].messageId).not.toBe(dispatcher.deliverTransition.mock.calls[1][3].messageId)

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

    expect(dispatcher.deliverTransition).not.toHaveBeenCalled()
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
    expect(dispatcher.deliverTransition).toHaveBeenCalledTimes(1)

    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(dispatcher.deliverTransition).toHaveBeenCalledTimes(1) // no further ticks after stop
  })

  it('tick failures never throw out of the interval (catch-all)', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const configStore = makeConfigStore()
    configStore.getAllTimedEvents = async () => { throw new Error('config plane down') }
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000) // must not throw / reject
    expect(dispatcher.deliverTransition).not.toHaveBeenCalled()
    stop()
  })
})

describe('startLifecycleScheduler — group C2 (redelivery sweep)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('calls findStaleClaims with the redelivery-grace cutoff and a maxAttempts of 5 (exhausted claims are excluded by the store)', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:10:00Z'))
    const configStore = makeConfigStore()
    const { deliveryStore } = makeDeliveryStore()
    const findStaleClaims = vi.fn().mockResolvedValue([])
    deliveryStore.findStaleClaims = findStaleClaims
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000, redeliveryGraceMinutes: 5 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(findStaleClaims).toHaveBeenCalledTimes(1)
    const [olderThan, maxAttempts] = findStaleClaims.mock.calls[0] as [Date, number]
    expect(maxAttempts).toBe(5)
    // tick fires 1000ms (intervalMs) after the system time set above
    expect(olderThan).toEqual(new Date('2026-07-15T00:05:01Z'))
  })

  it('re-drives a stale claim: increments attempts, delivers a rebuilt message, and marks it delivered', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:10:00Z'))
    const event = mkEvent()
    const configStore = makeConfigStore({ allTimedEvents: [event], endpoints: [endpointA] })
    const { deliveryStore } = makeDeliveryStore()
    deliveryStore.claimTransition = async () => false // already claimed by an earlier tick
    const incremented: unknown[] = []
    deliveryStore.incrementAttempts = async (projectId, eventId, transition) => { incremented.push([projectId, eventId, transition]) }
    const marked: unknown[] = []
    deliveryStore.markDelivered = async (projectId, eventId, transition) => { marked.push([projectId, eventId, transition]) }
    deliveryStore.findStaleClaims = vi.fn()
      .mockResolvedValueOnce([{ projectId: 'p1', eventId: 'e1', transition: 'live', attempts: 2 }])
      .mockResolvedValue([])
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl })

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(incremented).toEqual([['p1', 'e1', 'live']])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const rawBody = (fetchImpl.mock.calls[0][1] as RequestInit).body as string
    const body = JSON.parse(rawBody)
    expect(body.type).toBe('timed_event.live')
    expect(body.messageId).toMatch(UUID_RE)
    expect(marked).toEqual([['p1', 'e1', 'live']])
  })

  it('rebuilds the message with a fresh messageId on every redelivery attempt', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:10:00Z'))
    const event = mkEvent()
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore } = makeDeliveryStore()
    deliveryStore.claimTransition = async () => false
    deliveryStore.findStaleClaims = async () => [{ projectId: 'p1', eventId: 'e1', transition: 'live', attempts: 1 }]
    const messageIds: string[] = []
    const dispatcher = fakeDispatcher(async (..._args: unknown[]) => {
      const msg = _args[3] as WebhookMessage
      messageIds.push(msg.messageId)
    })

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(messageIds).toHaveLength(2)
    expect(messageIds[0]).toMatch(UUID_RE)
    expect(messageIds[1]).toMatch(UUID_RE)
    expect(messageIds[0]).not.toBe(messageIds[1])
  })

  it('dead-letters and marks delivered an unresolvable stale claim (event definition no longer in the feed)', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:10:00Z'))
    const configStore = makeConfigStore({ allTimedEvents: [] })
    const { deliveryStore, deadLetters } = makeDeliveryStore()
    const marked: unknown[] = []
    deliveryStore.markDelivered = async (projectId, eventId, transition) => { marked.push([projectId, eventId, transition]) }
    deliveryStore.findStaleClaims = async () => [{ projectId: 'p1', eventId: 'gone-1', transition: 'ended', attempts: 3 }]
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(dispatcher.deliverTransition).not.toHaveBeenCalled()
    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0]).toMatchObject({ projectId: 'p1', url: '<unresolvable>', error: 'event definition no longer in scan window' })
    expect(JSON.parse(deadLetters[0].payload)).toEqual({ projectId: 'p1', eventId: 'gone-1', transition: 'ended', attempts: 3 })
    expect(marked).toEqual([['p1', 'gone-1', 'ended']])
  })
})

describe('startLifecycleScheduler — group C3 (retention sweep)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('deletes dead letters older than deadLetterTtlDays using the correct cutoff, and logs when count > 0', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const configStore = makeConfigStore()
    const { deliveryStore } = makeDeliveryStore()
    const deleteDeadLettersBefore = vi.fn().mockResolvedValue(3)
    deliveryStore.deleteDeadLettersBefore = deleteDeadLettersBefore
    const dispatcher = fakeDispatcher()
    const info = vi.fn()
    const testLogger = { warn: vi.fn(), error: vi.fn(), info } as unknown as Logger

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000, deadLetterTtlDays: 30, logger: testLogger })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(deleteDeadLettersBefore).toHaveBeenCalledTimes(1)
    const [cutoff] = deleteDeadLettersBefore.mock.calls[0] as [Date]
    // tick fires 1000ms (intervalMs) after the system time set above
    expect(cutoff).toEqual(new Date('2026-06-15T00:00:01Z'))
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ deleted: 3 }), expect.any(String))
  })

  it('does not log when nothing was deleted', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const configStore = makeConfigStore()
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()
    const info = vi.fn()
    const testLogger = { warn: vi.fn(), error: vi.fn(), info } as unknown as Logger

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000, logger: testLogger })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(info).not.toHaveBeenCalled()
  })
})

describe('startLifecycleScheduler — group C4 (scan/redelivery grace ordering assert)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('warns and clamps scanGraceMinutes when it does not exceed redeliveryGraceMinutes', async () => {
    const configStore = makeConfigStore()
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()
    const warn = vi.fn()
    const testLogger = { warn, error: vi.fn(), info: vi.fn() } as unknown as Logger

    const stop = startLifecycleScheduler({
      configStore, deliveryStore, dispatcher, intervalMs: 1000, logger: testLogger,
      redeliveryGraceMinutes: 10, scanGraceMinutes: 10,
    })
    stop()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      { scanGraceMinutes: 10, redeliveryGraceMinutes: 10, clampedScanGraceMinutes: 15 },
      expect.any(String),
    )
  })

  it('does not warn when scanGraceMinutes already exceeds redeliveryGraceMinutes', async () => {
    const configStore = makeConfigStore()
    const { deliveryStore } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()
    const warn = vi.fn()
    const testLogger = { warn, error: vi.fn(), info: vi.fn() } as unknown as Logger

    const stop = startLifecycleScheduler({
      configStore, deliveryStore, dispatcher, intervalMs: 1000, logger: testLogger,
      redeliveryGraceMinutes: 5, scanGraceMinutes: 60,
    })
    stop()

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('resolveScanGraceMinutes — group C5 (single-sourced scan-grace clamp)', () => {
  it('clamps and warns when scanGraceMinutes does not exceed redeliveryGraceMinutes', () => {
    const warn = vi.fn()
    const testLogger = { warn, error: vi.fn(), info: vi.fn() } as unknown as Logger

    const result = resolveScanGraceMinutes(10, 10, testLogger)

    expect(result).toBe(15)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      { scanGraceMinutes: 10, redeliveryGraceMinutes: 10, clampedScanGraceMinutes: 15 },
      expect.any(String),
    )
  })

  it('passes the value through unchanged with no warning when it already exceeds redeliveryGraceMinutes', () => {
    const warn = vi.fn()
    const testLogger = { warn, error: vi.fn(), info: vi.fn() } as unknown as Logger

    const result = resolveScanGraceMinutes(60, 5, testLogger)

    expect(result).toBe(60)
    expect(warn).not.toHaveBeenCalled()
  })

  it('feeding an already-resolved value to startLifecycleScheduler does not warn a second time (single-source wiring)', async () => {
    vi.useFakeTimers()
    try {
      const configStore = makeConfigStore()
      const { deliveryStore } = makeDeliveryStore()
      const dispatcher = fakeDispatcher()
      const warn = vi.fn()
      const testLogger = { warn, error: vi.fn(), info: vi.fn() } as unknown as Logger

      // Simulates index.ts: resolve once up front (this is where the single warn fires)...
      const effectiveScanGrace = resolveScanGraceMinutes(10, 10, testLogger)
      expect(warn).toHaveBeenCalledTimes(1)

      // ...then hand the already-resolved value to the scheduler, whose internal backstop
      // clamp must be a no-op and must not warn again.
      const stop = startLifecycleScheduler({
        configStore, deliveryStore, dispatcher, intervalMs: 1000, logger: testLogger,
        redeliveryGraceMinutes: 10, scanGraceMinutes: effectiveScanGrace,
      })
      stop()

      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
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
