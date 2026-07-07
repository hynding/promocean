import {
  trackEventResponseSchema, userAchievementsResponseSchema, placementOfferResponseSchema,
  liveEventsResponseSchema,
  type AchievementStatus, type TrackEventResponse, type UnlockPayload, type OfferCreative, type LiveTimedEvent,
} from '@promocean/contracts'

export interface PromoceanOptions {
  publishableKey: string
  baseUrl: string
  userId?: string
  fetchImpl?: typeof fetch
  maxRetries?: number
}

export class PromoceanApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(`${code}: ${message}`)
    this.name = 'PromoceanApiError'
  }
}

export class Promocean {
  private userId?: string
  private fetchImpl: typeof fetch
  private maxRetries: number
  private chain: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(u: UnlockPayload) => void>()
  private dismissedFallback = new Set<string>()

  constructor(private opts: PromoceanOptions) {
    this.userId = opts.userId
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a))
    this.maxRetries = opts.maxRetries ?? 3
  }

  identify(userId: string): void { this.userId = userId }

  onUnlock(cb: (u: UnlockPayload) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let lastErr: unknown
    let lastStatus: number | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)))
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${this.opts.publishableKey}`, 'content-type': 'application/json', ...init?.headers },
        })
        if (res.status >= 500) { lastErr = new Error(`server ${res.status}`); lastStatus = res.status; continue }
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: { code: string; message: string } } | null
          throw new PromoceanApiError(body?.error?.code ?? 'internal_error', body?.error?.message ?? 'request failed', res.status)
        }
        return res
      } catch (err) {
        if (err instanceof PromoceanApiError) throw err
        lastErr = err
      }
    }
    if (lastStatus !== undefined) throw new PromoceanApiError('internal_error', `server responded ${lastStatus} after ${this.maxRetries + 1} attempts`, lastStatus)
    throw lastErr instanceof Error ? lastErr : new Error('request failed')
  }

  track(type: string, meta?: Record<string, unknown>): Promise<TrackEventResponse> {
    const run = async (): Promise<TrackEventResponse> => {
      if (!this.userId) throw new Error('No user identified — call identify(userId) first.')
      const idempotencyKey = crypto.randomUUID()
      const res = await this.request('/v1/events', {
        method: 'POST',
        body: JSON.stringify({ userId: this.userId, type, idempotencyKey, ...(meta ? { meta } : {}) }),
      })
      const parsed = trackEventResponseSchema.parse(await res.json())
      for (const unlock of parsed.unlocks) for (const cb of this.listeners) cb(unlock)
      return parsed
    }
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => undefined) // keep the chain alive after failures
    return result
  }

  async getAchievements(): Promise<AchievementStatus[]> {
    if (!this.userId) throw new Error('No user identified — call identify(userId) first.')
    const res = await this.request(`/v1/users/${encodeURIComponent(this.userId)}/achievements`)
    return userAchievementsResponseSchema.parse(await res.json()).achievements
  }

  async getPlacementOffer(slug: string): Promise<OfferCreative | null> {
    const qs = this.userId ? `?userId=${encodeURIComponent(this.userId)}` : ''
    const res = await this.request(`/v1/placements/${encodeURIComponent(slug)}/offer${qs}`)
    return placementOfferResponseSchema.parse(await res.json()).offer
  }

  async getLiveEvents(): Promise<LiveTimedEvent[]> {
    const res = await this.request('/v1/events/live')
    return liveEventsResponseSchema.parse(await res.json()).events
  }

  async clickOffer(offerId: string): Promise<void> {
    try {
      await this.request(`/v1/offers/${encodeURIComponent(offerId)}/click`, {
        method: 'POST',
        body: JSON.stringify(this.userId ? { userId: this.userId } : {}),
      })
    } catch {
      // fire-and-forget: a failed click must never break the host page
    }
  }

  private dismissalKey(offerId: string) { return `promocean:dismissed:${offerId}` }

  dismissOffer(offerId: string): void {
    try { globalThis.localStorage.setItem(this.dismissalKey(offerId), '1') }
    catch { this.dismissedFallback.add(offerId) }
  }

  isOfferDismissed(offerId: string): boolean {
    try { return globalThis.localStorage.getItem(this.dismissalKey(offerId)) === '1' }
    catch { return this.dismissedFallback.has(offerId) }
  }
}
