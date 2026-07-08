import type { AchievementDefinition, AuthContext, OfferDefinition, Scope, TimedEventDefinition, TimedEventTransition, WebhookEndpointDefinition } from './types.js'

export interface ConfigStore {
  getAchievements(projectId: string): Promise<AchievementDefinition[]>
  getOffers(projectId: string): Promise<OfferDefinition[]>
  getTimedEvents(projectId: string): Promise<TimedEventDefinition[]>
  getAllTimedEvents(): Promise<Array<TimedEventDefinition & { projectId: string }>>
  getWebhookEndpoints(projectId: string): Promise<WebhookEndpointDefinition[]>
  getRegisteredEventTypes(projectId: string): Promise<string[]>
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
  ): Promise<
    | { deduped: true }
    | { deduped: false; progress: { achievementId: string; current: number; target: number }[]; newUnlocks: { achievementId: string; unlockedAt: Date }[] }
  >
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
}

export interface ErasureStore {
  eraseUser(scope: Scope, userId: string): Promise<{ events: number; progress: number; unlocks: number; offerEvents: number }>
}
