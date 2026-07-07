import { createHmac } from 'node:crypto'
import { WEBHOOK_SIGNATURE_HEADER, type WebhookMessage } from '@promocean/contracts'
import { timedEventState, type ConfigStore, type TimedEventTransition, type WebhookDeliveryStore, type WebhookEndpointDefinition } from '@promocean/core'

const BASE_BACKOFF_MS = 250

export class WebhookDispatcher {
  private configStore: ConfigStore
  private deliveryStore: WebhookDeliveryStore
  private fetchImpl: typeof fetch
  private maxRetries: number

  constructor(opts: {
    configStore: ConfigStore
    deliveryStore: WebhookDeliveryStore
    fetchImpl?: typeof fetch
    maxRetries?: number
  }) {
    this.configStore = opts.configStore
    this.deliveryStore = opts.deliveryStore
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a))
    this.maxRetries = opts.maxRetries ?? 3
  }

  /** Delivers a signed webhook message to every enabled endpoint for the project. Never throws. */
  async deliver(projectId: string, message: WebhookMessage): Promise<void> {
    let endpoints: WebhookEndpointDefinition[]
    try {
      endpoints = await this.configStore.getWebhookEndpoints(projectId)
    } catch (err) {
      console.error('webhook: failed to load endpoints', err)
      return
    }
    const rawBody = JSON.stringify(message)
    await Promise.allSettled(
      endpoints.filter((e) => e.enabled).map((endpoint) => this.deliverToEndpoint(projectId, endpoint, rawBody)),
    )
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
      console.error('webhook: failed to record dead letter', err)
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

export function startLifecycleScheduler(opts: {
  configStore: ConfigStore
  deliveryStore: WebhookDeliveryStore
  dispatcher: WebhookDispatcher
  intervalMs?: number
}): () => void {
  const { configStore, deliveryStore, dispatcher, intervalMs = 30_000 } = opts

  const tick = async () => {
    try {
      const events = await configStore.getAllTimedEvents()
      const now = new Date()
      for (const event of events) {
        const state = timedEventState(event, now)
        const transitions = reachedTransitions(state)
        for (const transition of transitions) {
          const claimed = await deliveryStore.claimTransition(event.projectId, event.id, transition)
          if (!claimed) continue
          await dispatcher.deliver(event.projectId, {
            type: `timed_event.${transition}`,
            data: {
              eventId: event.id,
              name: event.name,
              startsAt: event.startsAt.toISOString(),
              endsAt: event.endsAt.toISOString(),
              multiplier: event.multiplier,
            },
            createdAt: now.toISOString(),
          })
        }
      }
    } catch (err) {
      console.error('lifecycle scheduler: tick failed', err)
    }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  return () => clearInterval(timer)
}
