import type { AchievementDefinition, AuthContext, OfferDefinition, PointRules, Scope, TimedEventDefinition, TimedEventTransition, WebhookEndpointDefinition } from './types.js'

export interface ConfigStore {
  getAchievements(projectId: string): Promise<AchievementDefinition[]>
  getOffers(projectId: string): Promise<OfferDefinition[]>
  getTimedEvents(projectId: string): Promise<TimedEventDefinition[]>
  getAllTimedEvents(): Promise<Array<TimedEventDefinition & { projectId: string }>>
  getWebhookEndpoints(projectId: string): Promise<WebhookEndpointDefinition[]>
  getRegisteredEventTypes(projectId: string): Promise<string[]>
  getPointRules(projectId: string): Promise<PointRules>
}

export interface ApiKeyStore {
  verifyKey(rawKey: string): Promise<AuthContext | null>
}

export interface EventStore {
  insertEvent(
    scope: Scope,
    event: {
      userId: string
      type: string
      idempotencyKey: string
      occurredAt: Date
      meta?: Record<string, unknown>
    }
  ): Promise<{ deduped: boolean }>
}

export interface ProgressStore {
  getCounts(scope: Scope, userId: string, achievementIds: string[]): Promise<Map<string, number>>
  setProgress(scope: Scope, userId: string, achievementId: string, current: number): Promise<void>
  recordUnlock(scope: Scope, userId: string, achievementId: string, unlockedAt: Date): Promise<boolean>
  getUserAchievements(
    scope: Scope,
    userId: string
  ): Promise<Array<{ achievementId: string; current: number; unlockedAt: Date | null }>>
}

export interface UsageStore {
  recordUsage(scope: Scope, userId: string, month: string): Promise<void>
}

export interface OfferMetricsStore {
  recordImpression(scope: Scope, offerId: string, userId: string | null, at: Date, idempotencyKey: string): Promise<void>
  recordClick(scope: Scope, offerId: string, userId: string | null, at: Date): Promise<void>
}

/**
 * Engagement data attached to an ingest, computed by the route before the transaction:
 * the client-tz local day (already offset-resolved), the point award for the event's type
 * (if any rule matched), and the point value of each achievement newly unlocked by this
 * ingest (only entries with pointsValue > 0 — zero-point unlocks award nothing).
 */
export interface EngagementWrite {
  localDay: string // 'YYYY-MM-DD', already offset-resolved by the route
  eventPoints: { points: number; sourceRef: string } | null // null when no rule matched
  unlockPoints: Record<string, number> // achievementId -> pointsValue (>0 entries only)
}

/**
 * Applies an evaluation plan's increments atomically: inserts the event (deduping on
 * idempotencyKey), advances usage, clamps each achievement's progress at its target, and
 * decides unlocks — all in one transaction. The RETURNING progress/unlocks are the sole
 * source of truth for what happened; callers must not recompute outcomes themselves.
 */
export interface IngestionStore {
  ingestEvent(
    scope: Scope,
    event: { userId: string; type: string; idempotencyKey: string; occurredAt: Date; meta?: Record<string, unknown> },
    increments: { achievementId: string; delta: number; target: number }[],
    month: string, // usage-counter month key 'YYYY-MM'
    engagement: EngagementWrite,
  ): Promise<
    | { deduped: true }
    | { deduped: false; progress: { achievementId: string; current: number; target: number }[]; newUnlocks: { achievementId: string; unlockedAt: Date }[] }
  >
}

export interface EngagementStore {
  getWallet(scope: Scope, userId: string): Promise<{ balance: number; recent: Array<{ delta: number; source: 'event' | 'unlock'; sourceRef: string; at: Date }> }>
  getStreak(scope: Scope, userId: string): Promise<{ current: number; longest: number; lastActiveDay: string | null }>
  getLeaderboard(scope: Scope, window: 'all' | '7d' | '30d', limit: number): Promise<Array<{ rank: number; userId: string; points: number }>>
}

export interface StatsStore {
  getStats(
    scope: Scope,
    range: { from: Date | null; to: Date | null },
    timedEventWindows: { eventId: string; startsAt: Date; endsAt: Date }[],
  ): Promise<{
    totals: { events: number; unlocks: number; impressions: number; clicks: number; timedEventParticipants: number }
    achievements: { achievementId: string; unlocks: number }[]
    offers: { offerId: string; impressions: number; clicks: number }[]
    timedEvents: { eventId: string; participants: number }[]
  }>
}

export interface WebhookDeliveryStore {
  claimTransition(projectId: string, eventId: string, transition: TimedEventTransition): Promise<boolean>
  recordDeadLetter(projectId: string, url: string, payload: string, error: string, at: Date): Promise<void>
  /** Sets delivered_at = now() on the claim row. Idempotent: already-delivered is a no-op update. */
  markDelivered(projectId: string, eventId: string, transition: TimedEventTransition): Promise<void>
  /** Rows where delivered_at IS NULL AND fired_at < olderThan AND attempts < maxAttempts. */
  findStaleClaims(olderThan: Date, maxAttempts: number): Promise<Array<{ projectId: string; eventId: string; transition: TimedEventTransition; attempts: number }>>
  incrementAttempts(projectId: string, eventId: string, transition: TimedEventTransition): Promise<void>
  /** Rows where delivered_at IS NULL AND attempts >= minAttempts — claims findStaleClaims
   * excludes forever once they've exhausted their redelivery attempts. Callers dead-letter
   * and mark these delivered so the loop stops rather than leaving them orphaned. */
  findExhaustedClaims(minAttempts: number): Promise<Array<{ projectId: string; eventId: string; transition: TimedEventTransition; attempts: number }>>
  /** Deletes dead letters created before cutoff. Returns the number deleted. */
  deleteDeadLettersBefore(cutoff: Date): Promise<number>
}

export interface ErasureStore {
  eraseUser(scope: Scope, userId: string): Promise<{ events: number; progress: number; unlocks: number; offerEvents: number; pointsLedger: number; streaks: number }>
}
