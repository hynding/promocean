import { and, eq, inArray, sql } from 'drizzle-orm'
import type { EventStore, ProgressStore, Scope, UsageStore } from '@promocean/core'
import { achievementProgress, events, monthlyActiveUsers, unlocks, usageCounters } from './schema.js'
import type { Db } from './index.js'

const scoped = (t: { projectId: any; environment: any }, s: Scope) =>
  and(eq(t.projectId, s.projectId), eq(t.environment, s.environment))

export class PgEventStore implements EventStore {
  constructor(private db: Db) {}
  async insertEvent(scope: Scope, e: { userId: string; type: string; idempotencyKey: string; occurredAt: Date; meta?: Record<string, unknown> }) {
    const inserted = await this.db.insert(events)
      .values({ ...scope, ...e })
      .onConflictDoNothing()
      .returning({ id: events.id })
    return { deduped: inserted.length === 0 }
  }
}

export class PgProgressStore implements ProgressStore {
  constructor(private db: Db) {}
  async getCounts(scope: Scope, userId: string, achievementIds: string[]) {
    if (achievementIds.length === 0) return new Map<string, number>()
    const rows = await this.db.select().from(achievementProgress).where(and(
      scoped(achievementProgress, scope),
      eq(achievementProgress.userId, userId),
      inArray(achievementProgress.achievementId, achievementIds),
    ))
    return new Map(rows.map((r) => [r.achievementId, r.current]))
  }
  async setProgress(scope: Scope, userId: string, achievementId: string, current: number) {
    await this.db.insert(achievementProgress)
      .values({ ...scope, userId, achievementId, current })
      .onConflictDoUpdate({
        target: [achievementProgress.projectId, achievementProgress.environment, achievementProgress.userId, achievementProgress.achievementId],
        set: { current, updatedAt: sql`now()` },
      })
  }
  async recordUnlock(scope: Scope, userId: string, achievementId: string, unlockedAt: Date) {
    const inserted = await this.db.insert(unlocks)
      .values({ ...scope, userId, achievementId, unlockedAt })
      .onConflictDoNothing()
      .returning({ achievementId: unlocks.achievementId })
    return inserted.length > 0
  }
  async getUserAchievements(scope: Scope, userId: string) {
    const progressRows = await this.db.select().from(achievementProgress)
      .where(and(scoped(achievementProgress, scope), eq(achievementProgress.userId, userId)))
    const unlockRows = await this.db.select().from(unlocks)
      .where(and(scoped(unlocks, scope), eq(unlocks.userId, userId)))
    const unlockedBy = new Map(unlockRows.map((r) => [r.achievementId, r.unlockedAt]))
    const ids = new Set([...progressRows.map((r) => r.achievementId), ...unlockedBy.keys()])
    return [...ids].map((achievementId) => ({
      achievementId,
      current: progressRows.find((r) => r.achievementId === achievementId)?.current ?? 0,
      unlockedAt: unlockedBy.get(achievementId) ?? null,
    }))
  }
}

export class PgUsageStore implements UsageStore {
  constructor(private db: Db) {}
  async recordUsage(scope: Scope, userId: string, month: string) {
    await this.db.insert(monthlyActiveUsers).values({ ...scope, month, userId }).onConflictDoNothing()
    await this.db.insert(usageCounters).values({ ...scope, month, eventsCount: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.projectId, usageCounters.environment, usageCounters.month],
        set: { eventsCount: sql`${usageCounters.eventsCount} + 1` },
      })
  }
}
