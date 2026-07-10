import {
  trackEventResponseSchema, userAchievementsResponseSchema, placementOfferResponseSchema,
  liveEventsResponseSchema, statsResponseSchema, walletResponseSchema, streakResponseSchema,
  leaderboardResponseSchema, rewardsResponseSchema, claimRewardResponseSchema,
  validateCouponResponseSchema, redeemCouponResponseSchema, backfillResponseSchema,
  type AchievementStatus, type TrackEventResponse, type UnlockPayload, type OfferCreative, type LiveTimedEvent,
  type StatsResponse, type WalletResponse, type StreakResponse, type LeaderboardResponse,
  type Reward, type ClaimRewardResponse, type ValidateCouponResponse, type RedeemCouponResponse,
  type BackfillResponse,
} from '@promocean/contracts'

export interface PromoceanOptions {
  publishableKey: string
  baseUrl: string
  userId?: string
  fetchImpl?: typeof fetch
  maxRetries?: number
  /**
   * Server-side only. Grants access to secretKey-only endpoints (e.g. getStats).
   * NEVER ship this to a browser bundle or expose it to client-side code —
   * it must only be used from a trusted server context.
   */
  secretKey?: string
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

  get currentUserId(): string | undefined { return this.userId }

  onUnlock(cb: (u: UnlockPayload) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private async request(path: string, init?: RequestInit, { useSecretKey = false }: { useSecretKey?: boolean } = {}): Promise<Response> {
    let lastErr: unknown
    let lastStatus: number | undefined
    const bearer = useSecretKey ? this.opts.secretKey : this.opts.publishableKey
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)))
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...init?.headers },
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
      const tzOffsetMinutes = -new Date().getTimezoneOffset()
      const res = await this.request('/v1/events', {
        method: 'POST',
        body: JSON.stringify({ userId: this.userId, type, idempotencyKey, tzOffsetMinutes, ...(meta ? { meta } : {}) }),
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

  async getWallet(): Promise<WalletResponse> {
    if (!this.userId) throw new Error('No user identified — call identify(userId) first.')
    const res = await this.request(`/v1/users/${encodeURIComponent(this.userId)}/wallet`)
    return walletResponseSchema.parse(await res.json())
  }

  async getStreak(): Promise<StreakResponse> {
    if (!this.userId) throw new Error('No user identified — call identify(userId) first.')
    const res = await this.request(`/v1/users/${encodeURIComponent(this.userId)}/streak`)
    return streakResponseSchema.parse(await res.json())
  }

  async getLeaderboard(opts?: { window?: 'all' | '7d' | '30d'; limit?: number }): Promise<LeaderboardResponse> {
    const params = new URLSearchParams()
    if (opts?.window) params.set('window', opts.window)
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    const qs = params.toString()
    const res = await this.request(`/v1/leaderboard${qs ? `?${qs}` : ''}`)
    return leaderboardResponseSchema.parse(await res.json())
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

  async recordImpression(offerId: string): Promise<void> {
    try {
      // Generate the impressionId once, outside the retry loop: request() retries
      // reuse this same request body/init, so every attempt for this one logical
      // impression carries the same key and the server dedupes them as one.
      const impressionId = crypto.randomUUID()
      const body = JSON.stringify({ impressionId, ...(this.userId ? { userId: this.userId } : {}) })
      await this.request(`/v1/offers/${encodeURIComponent(offerId)}/impression`, { method: 'POST', body })
    } catch {
      // fire-and-forget: a failed impression beacon must never break the host page
    }
  }

  async getStats(query?: { from?: string; to?: string }): Promise<StatsResponse> {
    if (!this.opts.secretKey) throw new Error('getStats requires the secretKey option (server-side only).')
    const params = new URLSearchParams()
    if (query?.from) params.set('from', query.from)
    if (query?.to) params.set('to', query.to)
    const qs = params.size > 0 ? `?${params.toString()}` : ''
    const res = await this.request(`/v1/stats${qs}`, undefined, { useSecretKey: true })
    return statsResponseSchema.parse(await res.json())
  }

  async listRewards(): Promise<Reward[]> {
    const res = await this.request('/v1/rewards')
    return rewardsResponseSchema.parse(await res.json()).rewards
  }

  async claimReward(slug: string): Promise<ClaimRewardResponse> {
    if (!this.userId) throw new Error('No user identified — call identify(userId) first.')
    const res = await this.request(`/v1/rewards/${encodeURIComponent(slug)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ userId: this.userId }),
    })
    return claimRewardResponseSchema.parse(await res.json())
  }

  async validateCoupon(code: string): Promise<ValidateCouponResponse> {
    if (!this.opts.secretKey) throw new Error('validateCoupon requires the secretKey option (server-side only).')
    const res = await this.request('/v1/coupons/validate', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }, { useSecretKey: true })
    return validateCouponResponseSchema.parse(await res.json())
  }

  async redeemCoupon(code: string): Promise<RedeemCouponResponse> {
    if (!this.opts.secretKey) throw new Error('redeemCoupon requires the secretKey option (server-side only).')
    const res = await this.request('/v1/coupons/redeem', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }, { useSecretKey: true })
    return redeemCouponResponseSchema.parse(await res.json())
  }

  async backfillAchievement(achievementId: string): Promise<BackfillResponse> {
    if (!this.opts.secretKey) throw new Error('backfillAchievement requires the secretKey option (server-side only).')
    const res = await this.request(`/v1/achievements/${encodeURIComponent(achievementId)}/backfill`, {
      method: 'POST',
    }, { useSecretKey: true })
    return backfillResponseSchema.parse(await res.json())
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
