import { createHmac, randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { WEBHOOK_SIGNATURE_HEADER, type WebhookMessage } from '@promocean/contracts'
import { timedEventState, type ConfigStore, type TimedEventDefinition, type TimedEventTransition, type WebhookDeliveryStore, type WebhookEndpointDefinition } from '@promocean/core'
import { logger as rootLogger } from './logger.js'

const BASE_BACKOFF_MS = 250
/** A stale claim is redriven up to this many times before findStaleClaims excludes it for good. */
const MAX_REDELIVERY_ATTEMPTS = 5

export class WebhookDispatcher {
  private configStore: ConfigStore
  private deliveryStore: WebhookDeliveryStore
  private fetchImpl: typeof fetch
  private maxRetries: number
  private logger: Logger

  constructor(opts: {
    configStore: ConfigStore
    deliveryStore: WebhookDeliveryStore
    fetchImpl?: typeof fetch
    maxRetries?: number
    logger?: Logger
  }) {
    this.configStore = opts.configStore
    this.deliveryStore = opts.deliveryStore
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a))
    this.maxRetries = opts.maxRetries ?? 3
    this.logger = opts.logger ?? rootLogger.child({ component: 'webhooks' })
  }

  /** Delivers a signed webhook message to every enabled endpoint for the project. Never throws. */
  async deliver(projectId: string, message: WebhookMessage): Promise<void> {
    let endpoints: WebhookEndpointDefinition[]
    try {
      endpoints = await this.configStore.getWebhookEndpoints(projectId)
    } catch (err) {
      this.logger.error({ err }, 'webhook: failed to load endpoints')
      return
    }
    const rawBody = JSON.stringify(message)
    await Promise.allSettled(
      endpoints.filter((e) => e.enabled).map((endpoint) => this.deliverToEndpoint(projectId, endpoint, rawBody)),
    )
  }

  /**
   * Delivers a timed-event transition message, then marks the claim delivered. `deliver`
   * never throws — by the time it settles, every endpoint has either succeeded or been
   * dead-lettered, so the claim is "resolved" and safe to mark. If this process crashes
   * between `deliver` settling and `markDelivered` completing — or `deliver` itself throws,
   * e.g. under test — `markDelivered` never runs and the claim is left stale for the
   * redelivery sweep to pick up on a later tick.
   */
  async deliverTransition(
    projectId: string,
    eventId: string,
    transition: TimedEventTransition,
    message: WebhookMessage,
  ): Promise<void> {
    await this.deliver(projectId, message)
    await this.deliveryStore.markDelivered(projectId, eventId, transition)
  }

  private async deliverToEndpoint(projectId: string, endpoint: WebhookEndpointDefinition, rawBody: string): Promise<void> {
    const signature = createHmac('sha256', endpoint.secret).update(rawBody).digest('hex')
    let lastError: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, BASE_BACKOFF_MS * 2 ** (attempt - 1)))
      try {
        const res = await this.fetchImpl(endpoint.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: signature },
          body: rawBody,
          signal: AbortSignal.timeout(10_000),
        })
        if (res.status >= 500) {
          lastError = new Error(`webhook endpoint responded ${res.status}`)
          continue
        }
        if (!res.ok) {
          // 4xx: permanent client-side failure, do not retry.
          await this.deadLetter(projectId, endpoint.url, rawBody, `webhook endpoint responded ${res.status}`)
          return
        }
        return
      } catch (err) {
        lastError = err
      }
    }
    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError)
    await this.deadLetter(projectId, endpoint.url, rawBody, errorMessage)
  }

  private async deadLetter(projectId: string, url: string, payload: string, error: string): Promise<void> {
    try {
      await this.deliveryStore.recordDeadLetter(projectId, url, payload, error, new Date())
    } catch (err) {
      this.logger.error({ err }, 'webhook: failed to record dead letter')
    }
  }
}

function reachedTransitions(state: ReturnType<typeof timedEventState>): TimedEventTransition[] {
  switch (state) {
    case 'live':
      return ['live']
    case 'ending_soon':
      return ['live', 'ending_soon']
    case 'ended':
      return ['live', 'ending_soon', 'ended']
    default:
      return []
  }
}

/** Builds a fresh transition message. Called with a new messageId on every delivery attempt —
 * including redeliveries, which consumers must treat as a distinct message to dedup against. */
function buildTransitionMessage(
  event: TimedEventDefinition & { projectId: string },
  transition: TimedEventTransition,
  now: Date,
): WebhookMessage {
  return {
    messageId: randomUUID(),
    type: `timed_event.${transition}`,
    data: {
      eventId: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      multiplier: event.multiplier,
    },
    createdAt: now.toISOString(),
  }
}

/**
 * Resolves the effective scan-grace window: it must exceed redeliveryGraceMinutes, or a
 * scan window shorter than the redelivery grace would let events drop out of the feed
 * before a stale claim could ever be redriven. Warns and clamps to redeliveryGraceMinutes + 5
 * when violated.
 *
 * Single-sourced so the config-plane feed (index.ts) and the lifecycle scheduler always
 * agree on the same effective value — callers should compute this once and pass the result
 * to both. `startLifecycleScheduler` also calls this internally as a backstop for callers
 * that pass a raw value directly; when fed an already-resolved value it is a no-op.
 */
export function resolveScanGraceMinutes(scanGraceMinutes: number, redeliveryGraceMinutes: number, logger?: Logger): number {
  if (scanGraceMinutes <= redeliveryGraceMinutes) {
    const clampedScanGraceMinutes = redeliveryGraceMinutes + 5
    const log = logger ?? rootLogger.child({ component: 'webhooks' })
    log.warn(
      { scanGraceMinutes, redeliveryGraceMinutes, clampedScanGraceMinutes },
      'lifecycle scheduler: scanGraceMinutes must exceed redeliveryGraceMinutes; clamping',
    )
    return clampedScanGraceMinutes
  }
  return scanGraceMinutes
}

export function startLifecycleScheduler(opts: {
  configStore: ConfigStore
  deliveryStore: WebhookDeliveryStore
  dispatcher: WebhookDispatcher
  intervalMs?: number
  /** How long a claimed-but-undelivered transition sits before the redelivery sweep re-drives it. Default 5. */
  redeliveryGraceMinutes?: number
  /** Consumed by the config-plane scan window (Task 4); asserted here so it always exceeds
   * redeliveryGraceMinutes — a scan window shorter than the redelivery grace would let events
   * drop out of the feed before a stale claim could ever be redriven. Default 60. */
  scanGraceMinutes?: number
  /** Dead letters older than this are purged by the retention sweep. Default 30. */
  deadLetterTtlDays?: number
  logger?: Logger
}): () => void {
  const { configStore, deliveryStore, dispatcher, intervalMs = 30_000 } = opts
  const logger = opts.logger ?? rootLogger.child({ component: 'webhooks' })

  const redeliveryGraceMinutes = opts.redeliveryGraceMinutes ?? 5
  const deadLetterTtlDays = opts.deadLetterTtlDays ?? 30
  // Backstop clamp: index.ts computes the effective value once via resolveScanGraceMinutes
  // and passes it to both the config plane and here, so this is normally a no-op. Direct
  // callers (e.g. tests) that pass a raw value still get the same validation.
  const scanGraceMinutes = resolveScanGraceMinutes(opts.scanGraceMinutes ?? 60, redeliveryGraceMinutes, logger)
  // scanGraceMinutes is plumbed + validated here; Task 4 passes it to the config-plane scan window.

  const redeliveryGraceMs = redeliveryGraceMinutes * 60_000

  const tick = async () => {
    const now = new Date()

    // Phase 1: normal transition scan — claim newly-reached transitions and deliver them.
    try {
      const events = await configStore.getAllTimedEvents()
      for (const event of events) {
        const state = timedEventState(event, now)
        const transitions = reachedTransitions(state)
        for (const transition of transitions) {
          const claimed = await deliveryStore.claimTransition(event.projectId, event.id, transition)
          if (!claimed) continue
          await dispatcher.deliverTransition(event.projectId, event.id, transition, buildTransitionMessage(event, transition, now))
        }
      }
    } catch (err) {
      logger.error({ err }, 'lifecycle scheduler: transition scan failed')
    }

    // Phase 2: redelivery sweep — re-drive claims left stale by a crash before markDelivered.
    try {
      const events = await configStore.getAllTimedEvents()
      const eventByKey = new Map(events.map((event) => [`${event.projectId}:${event.id}`, event]))
      const staleClaims = await deliveryStore.findStaleClaims(new Date(now.getTime() - redeliveryGraceMs), MAX_REDELIVERY_ATTEMPTS)
      for (const claim of staleClaims) {
        await deliveryStore.incrementAttempts(claim.projectId, claim.eventId, claim.transition)
        const event = eventByKey.get(`${claim.projectId}:${claim.eventId}`)
        if (!event) {
          // The event definition scrolled out of the scan window (or was deleted) before we
          // could redrive it — nothing left to rebuild the message from. Dead-letter it and
          // stop retrying rather than leaving it stale forever.
          await deliveryStore.recordDeadLetter(
            claim.projectId,
            '<unresolvable>',
            JSON.stringify(claim),
            'event definition no longer in scan window',
            now,
          )
          await deliveryStore.markDelivered(claim.projectId, claim.eventId, claim.transition)
          continue
        }
        await dispatcher.deliverTransition(claim.projectId, claim.eventId, claim.transition, buildTransitionMessage(event, claim.transition, now))
      }
    } catch (err) {
      logger.error({ err }, 'lifecycle scheduler: redelivery sweep failed')
    }

    // Phase 3: retention sweep — purge old dead letters.
    try {
      const cutoff = new Date(now.getTime() - deadLetterTtlDays * 24 * 60 * 60 * 1000)
      const deleted = await deliveryStore.deleteDeadLettersBefore(cutoff)
      if (deleted > 0) logger.info({ deleted }, 'lifecycle scheduler: retention sweep purged dead letters')
    } catch (err) {
      logger.error({ err }, 'lifecycle scheduler: retention sweep failed')
    }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  return () => clearInterval(timer)
}
