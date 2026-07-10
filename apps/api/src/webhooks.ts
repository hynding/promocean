import { createHmac, randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { WEBHOOK_SIGNATURE_HEADER, type WebhookMessage } from '@promocean/contracts'
import { occurrenceFromKey, transitionOccurrence, type ConfigStore, type OccurrenceWindow, type TimedEventDefinition, type TimedEventTransition, type WebhookDeliveryStore, type WebhookEndpointDefinition } from '@promocean/core'
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
    occurrenceKey: string,
    transition: TimedEventTransition,
    message: WebhookMessage,
  ): Promise<void> {
    await this.deliver(projectId, message)
    await this.deliveryStore.markDelivered(projectId, eventId, occurrenceKey, transition)
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

/**
 * Transitions reached for a specific occurrence window as of `now` — the scheduler's view.
 * Mirrors the state cascade (ended implies ending_soon implies live) but is evaluated against
 * the occurrence's own bounds rather than the definition's, so between occurrences the
 * just-elapsed occurrence (from transitionOccurrence) can still fire its 'ended' transition.
 */
function reachedTransitionsFor(occ: OccurrenceWindow, now: Date, endingSoonMinutes: number): TimedEventTransition[] {
  const nowMs = now.getTime()
  if (nowMs >= occ.endsAt.getTime()) return ['live', 'ending_soon', 'ended']
  if (occ.endsAt.getTime() - nowMs <= endingSoonMinutes * 60_000) return ['live', 'ending_soon']
  if (nowMs >= occ.startsAt.getTime()) return ['live']
  return []
}

/** Builds a fresh transition message. Called with a new messageId on every delivery attempt —
 * including redeliveries, which consumers must treat as a distinct message to dedup against.
 * `data.startsAt`/`data.endsAt` stay the DEFINITION's values; for recurring events the specific
 * occurrence's window is carried additively in `data.occurrence`. */
function buildTransitionMessage(
  event: TimedEventDefinition & { projectId: string },
  occ: OccurrenceWindow,
  transition: TimedEventTransition,
  now: Date,
): WebhookMessage {
  const data: Record<string, unknown> = {
    eventId: event.id,
    name: event.name,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    multiplier: event.multiplier,
  }
  if (event.recurrence !== 'none') {
    data.occurrence = { startsAt: occ.startsAt.toISOString(), endsAt: occ.endsAt.toISOString() }
  }
  return {
    messageId: randomUUID(),
    type: `timed_event.${transition}`,
    data,
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
  /** Delivered claim rows older than this are purged by the retention sweep. Default 30. */
  deliveredClaimsTtlDays?: number
  logger?: Logger
}): () => void {
  const { configStore, deliveryStore, dispatcher, intervalMs = 30_000 } = opts
  const logger = opts.logger ?? rootLogger.child({ component: 'webhooks' })

  const redeliveryGraceMinutes = opts.redeliveryGraceMinutes ?? 5
  const deadLetterTtlDays = opts.deadLetterTtlDays ?? 30
  const deliveredClaimsTtlDays = opts.deliveredClaimsTtlDays ?? 30
  // Backstop clamp: index.ts computes the effective value once via resolveScanGraceMinutes
  // and passes it to both the config plane and here, so this is normally a no-op. Direct
  // callers (e.g. tests) that pass a raw value still get the same validation.
  const scanGraceMinutes = resolveScanGraceMinutes(opts.scanGraceMinutes ?? 60, redeliveryGraceMinutes, logger)
  // scanGraceMinutes is plumbed + validated here; Task 4 passes it to the config-plane scan window.

  const redeliveryGraceMs = redeliveryGraceMinutes * 60_000

  // Per-tick cost (#23): every tick runs a full pass — two getAllTimedEvents() config-plane
  // reads (phase 1 + phase 2), a findStaleClaims + findExhaustedClaims scan, and two retention
  // DELETEs (phase 3). Cost scales with the number of enabled timed events and outstanding
  // stale/exhausted claims, so intervalMs must stay comfortably above one tick's runtime to
  // avoid overlapping ticks piling up on the pool.
  const tick = async () => {
    const now = new Date()

    // Phase 1: normal transition scan — claim newly-reached transitions and deliver them.
    try {
      const events = await configStore.getAllTimedEvents()
      for (const event of events) {
        if (!event.enabled) continue // draft fires nothing
        const occ = transitionOccurrence(event, now)
        if (!occ) continue
        const transitions = reachedTransitionsFor(occ, now, event.endingSoonMinutes)
        for (const transition of transitions) {
          const claimed = await deliveryStore.claimTransition(event.projectId, event.id, occ.key, transition)
          if (!claimed) continue
          await dispatcher.deliverTransition(event.projectId, event.id, occ.key, transition, buildTransitionMessage(event, occ, transition, now))
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
        await deliveryStore.incrementAttempts(claim.projectId, claim.eventId, claim.occurrenceKey, claim.transition)
        const event = eventByKey.get(`${claim.projectId}:${claim.eventId}`)
        // Rebuild the occurrence from the claim's key: null means the event definition scrolled
        // out of the scan window / was deleted, or its recurrence changed so the key no longer
        // lands on an existing occurrence. Either way there is nothing left to rebuild the
        // message from — dead-letter it and stop retrying rather than leaving it stale forever.
        const occ = event ? occurrenceFromKey(event, claim.occurrenceKey) : null
        if (!event || !occ) {
          await deliveryStore.recordDeadLetter(
            claim.projectId,
            '<unresolvable>',
            JSON.stringify(claim),
            event ? 'occurrence key no longer resolves to an occurrence' : 'event definition no longer in scan window',
            now,
          )
          await deliveryStore.markDelivered(claim.projectId, claim.eventId, claim.occurrenceKey, claim.transition)
          continue
        }
        await dispatcher.deliverTransition(claim.projectId, claim.eventId, claim.occurrenceKey, claim.transition, buildTransitionMessage(event, occ, claim.transition, now))
      }
    } catch (err) {
      logger.error({ err }, 'lifecycle scheduler: redelivery sweep failed')
    }

    // Phase 2b: exhaustion sweep — claims that hit MAX_REDELIVERY_ATTEMPTS are excluded by
    // findStaleClaims forever; dead-letter and mark them delivered here so they stop being
    // silently orphaned (per plan: cap retries, then dead-letter + stop the loop).
    try {
      const exhaustedClaims = await deliveryStore.findExhaustedClaims(MAX_REDELIVERY_ATTEMPTS)
      for (const claim of exhaustedClaims) {
        try {
          await deliveryStore.recordDeadLetter(
            claim.projectId,
            '<exhausted>',
            JSON.stringify(claim),
            'redelivery attempts exhausted',
            now,
          )
          await deliveryStore.markDelivered(claim.projectId, claim.eventId, claim.occurrenceKey, claim.transition)
          logger.warn({ claim }, 'lifecycle scheduler: redelivery attempts exhausted, dead-lettering claim')
        } catch (err) {
          logger.error({ err, claim }, 'lifecycle scheduler: failed to dead-letter exhausted claim')
        }
      }
    } catch (err) {
      logger.error({ err }, 'lifecycle scheduler: exhaustion sweep failed')
    }

    // Phase 3: retention sweep — purge old dead letters and delivered claim rows. Delivered
    // claims are safe to drop once past their TTL: their transition already fired and the row's
    // only remaining job (redelivery dedup) is moot once delivered. Undelivered claims are never
    // touched here — the redelivery/exhaustion sweeps above own them.
    try {
      const cutoff = new Date(now.getTime() - deadLetterTtlDays * 24 * 60 * 60 * 1000)
      const deleted = await deliveryStore.deleteDeadLettersBefore(cutoff)
      if (deleted > 0) logger.info({ deleted }, 'lifecycle scheduler: retention sweep purged dead letters')
    } catch (err) {
      logger.error({ err }, 'lifecycle scheduler: retention sweep failed')
    }
    try {
      const cutoff = new Date(now.getTime() - deliveredClaimsTtlDays * 24 * 60 * 60 * 1000)
      const deleted = await deliveryStore.deleteDeliveredClaimsBefore(cutoff)
      if (deleted > 0) logger.info({ deleted }, 'lifecycle scheduler: retention sweep purged delivered claims')
    } catch (err) {
      logger.error({ err }, 'lifecycle scheduler: delivered-claims retention sweep failed')
    }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  return () => clearInterval(timer)
}
