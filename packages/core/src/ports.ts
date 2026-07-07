import type { AchievementDefinition, AuthContext, OfferDefinition, Scope } from './types.js'

export interface ConfigStore {
  getAchievements(projectId: string): Promise<AchievementDefinition[]>
  getOffers(projectId: string): Promise<OfferDefinition[]>
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
  recordImpression(scope: Scope, offerId: string, userId: string | null, at: Date): Promise<void>
  recordClick(scope: Scope, offerId: string, userId: string | null, at: Date): Promise<void>
}
