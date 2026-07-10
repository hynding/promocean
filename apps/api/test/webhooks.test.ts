import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'
import { WEBHOOK_SIGNATURE_HEADER, type WebhookMessage } from '@promocean/contracts'
import type { ConfigStore, TimedEventDefinition, WebhookDeliveryStore, WebhookEndpointDefinition } from '@promocean/core'
import { WebhookDispatcher, resolveScanGraceMinutes, startLifecycleScheduler } from '../src/webhooks.js'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

type ClaimRow = { projectId: string; eventId: string; occurrenceKey: string; transition: string }

function makeDeliveryStore() {
  const claimed = new Set<string>()
  const claims: ClaimRow[] = []
  const marked: ClaimRow[] = []
  const deadLetters: Array<{ projectId: string; url: string; payload: string; error: string; at: Date }> = []
  const deliveryStore: WebhookDeliveryStore = {
    claimTransition: async (projectId, eventId, occurrenceKey, transition) => {
      const key = `${projectId}:${eventId}:${occurrenceKey}:${transition}`
      if (claimed.has(key)) return false
      claimed.add(key)
      claims.push({ projectId, eventId, occurrenceKey, transition })
      return true
    },
    recordDeadLetter: async (projectId, url, payload, error, at) => {
      deadLetters.push({ projectId, url, payload, error, at })
    },
    // Records delivered claims so occurrence-key back-compat can be asserted; individual tests
    // below override whichever of these they need to assert on directly.
    markDelivered: async (projectId, eventId, occurrenceKey, transition) => {
      marked.push({ projectId, eventId, occurrenceKey, transition })
    },
    findStaleClaims: async () => [],
    incrementAttempts: async () => {},
    findExhaustedClaims: async () => [],
    deleteDeadLettersBefore: async () => 0,
  }
  return { deliveryStore, deadLetters, claims, marked }
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
    const marked: Array<[string, string, string, string]> = []
    deliveryStore.markDelivered = async (projectId, eventId, occurrenceKey, transition) => { marked.push([projectId, eventId, occurrenceKey, transition]) }
    const configStore = makeConfigStore({ endpoints: [endpointA, endpointB] })
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === endpointA.url) return Promise.resolve(new Response('', { status: 400 })) // dead-lettered
      return Promise.resolve(new Response('', { status: 200 })) // succeeded
    })
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl })

    await dispatcher.deliverTransition('p1', 'e1', '', 'live', { ...message, type: 'timed_event.live' })

    expect(marked).toEqual([['p1', 'e1', '', 'live']])
  })

  it('leaves the claim unmarked when deliver itself throws (simulated crash before markDelivered)', async () => {
    const { deliveryStore } = makeDeliveryStore()
    const marked: unknown[] = []
    deliveryStore.markDelivered = async () => { marked.push(true) }
    const configStore = makeConfigStore({ endpoints: [endpointA] })
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl: vi.fn() })
    vi.spyOn(dispatcher, 'deliver').mockRejectedValue(new Error('simulated crash'))

    await expect(dispatcher.deliverTransition('p1', 'e1', '', 'live', { ...message, type: 'timed_event.live' })).rejects.toThrow('simulated crash')

    expect(marked).toEqual([])
  })
})

const mkEvent = (over: Partial<TimedEventDefinition> = {}): TimedEventDefinition & { projectId: string } => ({
  id: 'e1', projectId: 'p1', name: 'Summer Sale', description: null,
  startsAt: new Date('2026-07-01T00:00:00Z'), endsAt: new Date('2026-07-31T00:00:00Z'),
  endingSoonMinutes: 60, multiplier: 2, enabled: true, recurrence: 'none', recurrenceEndsAt: null, ...over,
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
    expect(dispatcher.deliverTransition.mock.calls[0][2]).toBe('') // non-recurring occurrence key
    expect(dispatcher.deliverTransition.mock.calls[0][3]).toBe('live')
    expect(dispatcher.deliverTransition.mock.calls[0][4]).toMatchObject({ type: 'timed_event.live' })
    expect(dispatcher.deliverTransition.mock.calls[0][4].messageId).toMatch(UUID_RE)

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
    expect(dispatcher.deliverTransition.mock.calls[0][4]).toMatchObject({ type: 'timed_event.live' })
    expect(dispatcher.deliverTransition.mock.calls[1][4]).toMatchObject({ type: 'timed_event.ending_soon' })
    // fresh messageId per message, even within the same tick
    expect(dispatcher.deliverTransition.mock.calls[0][4].messageId).not.toBe(dispatcher.deliverTransition.mock.calls[1][4].messageId)

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

describe('startLifecycleScheduler — group C1b (occurrence-aware claims)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('claims a non-recurring event under the empty occurrence key (back-compat)', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const event = mkEvent() // recurrence 'none'
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore, claims } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(claims).toEqual([{ projectId: 'p1', eventId: 'e1', occurrenceKey: '', transition: 'live' }])
    // occurrence key is threaded all the way through delivery -> markDelivered
    expect(dispatcher.deliverTransition.mock.calls[0][2]).toBe('')
  })

  it('rolls occurrence claims: occurrence 1 fires its full lifecycle under K1, then occurrence 2 claims a fresh live under K2', async () => {
    // daily, 1-hour occurrences; occ1 = Jul 1 00:00-01:00 (key K1), occ2 = Jul 2 00:00-01:00 (K2)
    const event = mkEvent({
      recurrence: 'daily',
      startsAt: new Date('2026-07-01T00:00:00Z'),
      endsAt: new Date('2026-07-01T01:00:00Z'),
      endingSoonMinutes: 10,
    })
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore, claims, marked } = makeDeliveryStore()
    // real dispatcher so deliverTransition -> markDelivered records the delivered occurrence keys
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl })

    const k1 = '2026-07-01T00:00:00.000Z'
    const k2 = '2026-07-02T00:00:00.000Z'

    // Tick 1: between occurrences (occ1 fully ended, occ2 not started) -> transitionOccurrence
    // returns the just-elapsed occ1 so its full lifecycle fires.
    vi.setSystemTime(new Date('2026-07-01T02:00:00Z'))
    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)

    expect(claims.filter((c) => c.occurrenceKey === k1).map((c) => c.transition)).toEqual(['live', 'ending_soon', 'ended'])
    expect(marked.filter((m) => m.occurrenceKey === k1).map((m) => m.transition)).toEqual(['live', 'ending_soon', 'ended'])

    // Tick 2: inside occurrence 2's live window -> a fresh live claim under K2 only.
    vi.setSystemTime(new Date('2026-07-02T00:30:00Z'))
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(claims.filter((c) => c.occurrenceKey === k2).map((c) => c.transition)).toEqual(['live'])
    // K1 rows are untouched by tick 2 — still exactly the three from occurrence 1, all delivered.
    expect(claims.filter((c) => c.occurrenceKey === k1)).toHaveLength(3)
    expect(marked.filter((m) => m.occurrenceKey === k1)).toHaveLength(3)
  })

  it('fires nothing for a disabled recurring event', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const event = mkEvent({ recurrence: 'daily', enabled: false })
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore, claims } = makeDeliveryStore()
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(claims).toEqual([])
    expect(dispatcher.deliverTransition).not.toHaveBeenCalled()
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
    deliveryStore.incrementAttempts = async (projectId, eventId, occurrenceKey, transition) => { incremented.push([projectId, eventId, occurrenceKey, transition]) }
    const marked: unknown[] = []
    deliveryStore.markDelivered = async (projectId, eventId, occurrenceKey, transition) => { marked.push([projectId, eventId, occurrenceKey, transition]) }
    deliveryStore.findStaleClaims = vi.fn()
      .mockResolvedValueOnce([{ projectId: 'p1', eventId: 'e1', occurrenceKey: '', transition: 'live', attempts: 2 }])
      .mockResolvedValue([])
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl })

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(incremented).toEqual([['p1', 'e1', '', 'live']])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const rawBody = (fetchImpl.mock.calls[0][1] as RequestInit).body as string
    const body = JSON.parse(rawBody)
    expect(body.type).toBe('timed_event.live')
    expect(body.messageId).toMatch(UUID_RE)
    expect(marked).toEqual([['p1', 'e1', '', 'live']])
  })

  it('rebuilds the message with a fresh messageId on every redelivery attempt', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:10:00Z'))
    const event = mkEvent()
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore } = makeDeliveryStore()
    deliveryStore.claimTransition = async () => false
    deliveryStore.findStaleClaims = async () => [{ projectId: 'p1', eventId: 'e1', occurrenceKey: '', transition: 'live', attempts: 1 }]
    const messageIds: string[] = []
    const dispatcher = fakeDispatcher(async (..._args: unknown[]) => {
      const msg = _args[4] as WebhookMessage
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
    deliveryStore.markDelivered = async (projectId, eventId, occurrenceKey, transition) => { marked.push([projectId, eventId, occurrenceKey, transition]) }
    deliveryStore.findStaleClaims = async () => [{ projectId: 'p1', eventId: 'gone-1', occurrenceKey: '', transition: 'ended', attempts: 3 }]
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(dispatcher.deliverTransition).not.toHaveBeenCalled()
    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0]).toMatchObject({ projectId: 'p1', url: '<unresolvable>', error: 'event definition no longer in scan window' })
    expect(JSON.parse(deadLetters[0].payload)).toEqual({ projectId: 'p1', eventId: 'gone-1', occurrenceKey: '', transition: 'ended', attempts: 3 })
    expect(marked).toEqual([['p1', 'gone-1', '', 'ended']])
  })

  it('rebuilds a recurring redelivery with the occurrence payload derived from its ISO key', async () => {
    vi.setSystemTime(new Date('2026-07-05T00:10:00Z'))
    // daily, 1-hour occurrences; occ2 (index 2) = Jul 3 00:00-01:00
    const event = mkEvent({
      recurrence: 'daily',
      startsAt: new Date('2026-07-01T00:00:00Z'),
      endsAt: new Date('2026-07-01T01:00:00Z'),
    })
    const configStore = makeConfigStore({ allTimedEvents: [event], endpoints: [endpointA] })
    const { deliveryStore } = makeDeliveryStore()
    deliveryStore.claimTransition = async () => false
    deliveryStore.findStaleClaims = vi.fn()
      .mockResolvedValueOnce([{ projectId: 'p1', eventId: 'e1', occurrenceKey: '2026-07-03T00:00:00.000Z', transition: 'ended', attempts: 1 }])
      .mockResolvedValue([])
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    const dispatcher = new WebhookDispatcher({ configStore, deliveryStore, fetchImpl })

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)
    expect(body.type).toBe('timed_event.ended')
    // definition bounds stay the definition's own values...
    expect(body.data.startsAt).toBe('2026-07-01T00:00:00.000Z')
    expect(body.data.endsAt).toBe('2026-07-01T01:00:00.000Z')
    // ...while the specific occurrence's window is carried additively.
    expect(body.data.occurrence).toEqual({ startsAt: '2026-07-03T00:00:00.000Z', endsAt: '2026-07-03T01:00:00.000Z' })
  })

  it('dead-letters a recurring stale claim whose occurrence key no longer resolves to an occurrence', async () => {
    vi.setSystemTime(new Date('2026-07-05T00:10:00Z'))
    const event = mkEvent({
      recurrence: 'daily',
      startsAt: new Date('2026-07-01T00:00:00Z'),
      endsAt: new Date('2026-07-01T01:00:00Z'),
    })
    const configStore = makeConfigStore({ allTimedEvents: [event] })
    const { deliveryStore, deadLetters } = makeDeliveryStore()
    deliveryStore.claimTransition = async () => false // isolate the redelivery sweep from phase-1 scan
    const marked: unknown[] = []
    deliveryStore.markDelivered = async (projectId, eventId, occurrenceKey, transition) => { marked.push([projectId, eventId, occurrenceKey, transition]) }
    // 00:30 is misaligned — daily occurrences start at 00:00, so this key resolves to null.
    deliveryStore.findStaleClaims = async () => [{ projectId: 'p1', eventId: 'e1', occurrenceKey: '2026-07-03T00:30:00.000Z', transition: 'ended', attempts: 1 }]
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(dispatcher.deliverTransition).not.toHaveBeenCalled()
    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0]).toMatchObject({ projectId: 'p1', url: '<unresolvable>', error: 'occurrence key no longer resolves to an occurrence' })
    expect(marked).toEqual([['p1', 'e1', '2026-07-03T00:30:00.000Z', 'ended']])
  })
})

describe('startLifecycleScheduler — group C2b (exhaustion sweep)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('dead-letters and marks delivered an exhausted claim, without re-driving it', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:10:00Z'))
    // No events in the feed: the transition scan (phase 1) and redelivery sweep (phase 2)
    // have nothing to claim/re-drive, isolating this assertion to the exhaustion sweep.
    const configStore = makeConfigStore({ allTimedEvents: [] })
    const { deliveryStore, deadLetters } = makeDeliveryStore()
    const marked: unknown[] = []
    deliveryStore.markDelivered = async (projectId, eventId, occurrenceKey, transition) => { marked.push([projectId, eventId, occurrenceKey, transition]) }
    deliveryStore.findExhaustedClaims = vi.fn()
      .mockResolvedValueOnce([{ projectId: 'p1', eventId: 'e1', occurrenceKey: '', transition: 'live', attempts: 5 }])
      .mockResolvedValue([])
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(dispatcher.deliverTransition).not.toHaveBeenCalled()
    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0]).toMatchObject({ projectId: 'p1', url: '<exhausted>', error: 'redelivery attempts exhausted' })
    expect(JSON.parse(deadLetters[0].payload)).toEqual({ projectId: 'p1', eventId: 'e1', occurrenceKey: '', transition: 'live', attempts: 5 })
    expect(marked).toEqual([['p1', 'e1', '', 'live']])
  })

  it('calls findExhaustedClaims with MAX_REDELIVERY_ATTEMPTS (5)', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:10:00Z'))
    const configStore = makeConfigStore()
    const { deliveryStore } = makeDeliveryStore()
    const findExhaustedClaims = vi.fn().mockResolvedValue([])
    deliveryStore.findExhaustedClaims = findExhaustedClaims
    const dispatcher = fakeDispatcher()

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    expect(findExhaustedClaims).toHaveBeenCalledWith(5)
  })

  it('a per-claim failure while dead-lettering an exhausted claim does not stop the sweep from continuing', async () => {
    vi.setSystemTime(new Date('2026-07-15T00:10:00Z'))
    const configStore = makeConfigStore()
    const { deliveryStore } = makeDeliveryStore()
    const marked: unknown[] = []
    deliveryStore.markDelivered = async (projectId, eventId, occurrenceKey, transition) => { marked.push([projectId, eventId, occurrenceKey, transition]) }
    let call = 0
    deliveryStore.recordDeadLetter = async () => { call++; if (call === 1) throw new Error('db down') }
    deliveryStore.findExhaustedClaims = vi.fn().mockResolvedValueOnce([
      { projectId: 'p1', eventId: 'e-fail', occurrenceKey: '', transition: 'live', attempts: 5 },
      { projectId: 'p1', eventId: 'e-ok', occurrenceKey: '', transition: 'live', attempts: 5 },
    ]).mockResolvedValue([])
    const dispatcher = fakeDispatcher()
    const testLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger

    const stop = startLifecycleScheduler({ configStore, deliveryStore, dispatcher, intervalMs: 1000, logger: testLogger })
    await vi.advanceTimersByTimeAsync(1000)
    stop()

    // the failing claim is not marked delivered, but the second claim still is
    expect(marked).toEqual([['p1', 'e-ok', '', 'live']])
    expect(testLogger.error).toHaveBeenCalled()
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
