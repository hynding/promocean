import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { ErasureStore, EventStore, IngestionStore, OfferMetricsStore, ProgressStore, Scope, StatsStore, TimedEventTransition, UsageStore, WebhookDeliveryStore } from '@promocean/core'
import { achievementProgress, events, monthlyActiveUsers, offerEvents, timedEventNotifications, unlocks, usageCounters, webhookDeadLetters } from './schema.js'
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

export class PgIngestionStore implements IngestionStore {
  constructor(private db: Db) {}
  async ingestEvent(
    scope: Scope,
    event: { userId: string; type: string; idempotencyKey: string; occurredAt: Date; meta?: Record<string, unknown> },
    increments: { achievementId: string; delta: number; target: number }[],
    month: string,
  ) {
    return this.db.transaction(async (tx) => {
      const insertedEvent = await tx.insert(events)
        .values({ ...scope, ...event })
        .onConflictDoNothing()
        .returning({ id: events.id })
      if (insertedEvent.length === 0) return { deduped: true as const }

      const progress: { achievementId: string; current: number; target: number }[] = []
      for (const inc of increments) {
        const [row] = await tx.insert(achievementProgress)
          .values({
            ...scope,
            userId: event.userId,
            achievementId: inc.achievementId,
            current: sql`LEAST(${inc.delta}::int, ${inc.target}::int)`,
          })
          .onConflictDoUpdate({
            target: [achievementProgress.projectId, achievementProgress.environment, achievementProgress.userId, achievementProgress.achievementId],
            set: {
              current: sql`LEAST(${achievementProgress.current} + ${inc.delta}::int, ${inc.target}::int)`,
              updatedAt: sql`now()`,
            },
          })
          .returning({ current: achievementProgress.current })
        progress.push({ achievementId: inc.achievementId, current: row!.current, target: inc.target })
      }

      // Computed once, shared by every unlock inserted in this call — every unlock crossed
      // its target in the same instant as far as this ingestion is concerned.
      const unlockedAt = new Date()
      const newUnlocks: { achievementId: string; unlockedAt: Date }[] = []
      for (const p of progress) {
        if (p.current < p.target) continue
        const insertedUnlock = await tx.insert(unlocks)
          .values({ ...scope, userId: event.userId, achievementId: p.achievementId, unlockedAt })
          .onConflictDoNothing()
          .returning({ achievementId: unlocks.achievementId })
        if (insertedUnlock.length > 0) newUnlocks.push({ achievementId: p.achievementId, unlockedAt })
      }

      await tx.insert(monthlyActiveUsers).values({ ...scope, month, userId: event.userId }).onConflictDoNothing()
      await tx.insert(usageCounters).values({ ...scope, month, eventsCount: 1 })
        .onConflictDoUpdate({
          target: [usageCounters.projectId, usageCounters.environment, usageCounters.month],
          set: { eventsCount: sql`${usageCounters.eventsCount} + 1` },
        })

      return { deduped: false as const, progress, newUnlocks }
    })
  }
}

export class PgOfferMetricsStore implements OfferMetricsStore {
  constructor(private db: Db) {}
  async recordImpression(scope: Scope, offerId: string, userId: string | null, at: Date, idempotencyKey: string) {
    // The partial unique index (project_id, environment, idempotency_key) WHERE kind =
    // 'impression' AND idempotency_key IS NOT NULL absorbs beacon retries/duplicates.
    await this.db.insert(offerEvents)
      .values({ ...scope, offerId, userId, kind: 'impression', createdAt: at, idempotencyKey })
      .onConflictDoNothing()
  }
  async recordClick(scope: Scope, offerId: string, userId: string | null, at: Date) {
    await this.db.insert(offerEvents).values({ ...scope, offerId, userId, kind: 'click', createdAt: at })
  }
}

const rangeConds = (col: { name?: string } & Parameters<typeof gte>[0], range: { from: Date | null; to: Date | null }) => {
  const conds = []
  if (range.from) conds.push(gte(col, range.from))
  if (range.to) conds.push(lte(col, range.to))
  return conds
}

export class PgStatsStore implements StatsStore {
  constructor(private db: Db) {}
  async getStats(
    scope: Scope,
    range: { from: Date | null; to: Date | null },
    timedEventWindows: { eventId: string; startsAt: Date; endsAt: Date }[],
  ) {
    const [eventCountRows, achievementRows, offerRows, timedEventRows, totalParticipants] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)::int` }).from(events)
        .where(and(scoped(events, scope), ...rangeConds(events.occurredAt, range))),
      this.db.select({ achievementId: unlocks.achievementId, unlocks: sql<number>`count(*)::int` })
        .from(unlocks)
        .where(and(scoped(unlocks, scope), ...rangeConds(unlocks.unlockedAt, range)))
        .groupBy(unlocks.achievementId),
      this.db.select({ offerId: offerEvents.offerId, kind: offerEvents.kind, count: sql<number>`count(*)::int` })
        .from(offerEvents)
        .where(and(scoped(offerEvents, scope), ...rangeConds(offerEvents.createdAt, range)))
        .groupBy(offerEvents.offerId, offerEvents.kind),
      Promise.all(timedEventWindows.map(async (w) => {
        // Range intersected with window: GREATEST/LEAST ignore null args, so a null
        // range.from/to simply falls back to the window's own bound.
        const result = await this.db.execute<{ n: number }>(sql`
          select count(distinct user_id)::int as n
          from runtime.events
          where project_id = ${scope.projectId} and environment = ${scope.environment}
            and occurred_at between GREATEST(${w.startsAt}::timestamptz, ${range.from}::timestamptz)
                                 and LEAST(${w.endsAt}::timestamptz, ${range.to}::timestamptz)
        `)
        return { eventId: w.eventId, participants: Number(result.rows[0]?.n ?? 0) }
      })),
      (async () => {
        if (timedEventWindows.length === 0) return 0
        const windowConds = timedEventWindows.map((w) => sql`(occurred_at between GREATEST(${w.startsAt}::timestamptz, ${range.from}::timestamptz) and LEAST(${w.endsAt}::timestamptz, ${range.to}::timestamptz))`)
        const result = await this.db.execute<{ n: number }>(sql`
          select count(distinct user_id)::int as n
          from runtime.events
          where project_id = ${scope.projectId} and environment = ${scope.environment} and (${sql.join(windowConds, sql` or `)})
        `)
        return Number(result.rows[0]?.n ?? 0)
      })(),
    ])

    const achievements = achievementRows.map((r) => ({ achievementId: r.achievementId, unlocks: r.unlocks }))
    const totalUnlocks = achievements.reduce((sum, a) => sum + a.unlocks, 0)

    const offerMap = new Map<string, { offerId: string; impressions: number; clicks: number }>()
    for (const r of offerRows) {
      const entry = offerMap.get(r.offerId) ?? { offerId: r.offerId, impressions: 0, clicks: 0 }
      if (r.kind === 'impression') entry.impressions = r.count
      else if (r.kind === 'click') entry.clicks = r.count
      offerMap.set(r.offerId, entry)
    }
    const offers = [...offerMap.values()]
    const totalImpressions = offers.reduce((sum, o) => sum + o.impressions, 0)
    const totalClicks = offers.reduce((sum, o) => sum + o.clicks, 0)

    return {
      totals: {
        events: eventCountRows[0]?.count ?? 0,
        unlocks: totalUnlocks,
        impressions: totalImpressions,
        clicks: totalClicks,
        timedEventParticipants: totalParticipants,
      },
      achievements,
      offers,
      timedEvents: timedEventRows,
    }
  }
}

export class PgWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private db: Db) {}
  async claimTransition(projectId: string, eventId: string, transition: TimedEventTransition) {
    const inserted = await this.db.insert(timedEventNotifications)
      .values({ projectId, eventId, transition })
      .onConflictDoNothing()
      .returning({ eventId: timedEventNotifications.eventId })
    return inserted.length > 0
  }
  async recordDeadLetter(projectId: string, url: string, payload: string, error: string, at: Date) {
    await this.db.insert(webhookDeadLetters).values({ projectId, url, payload, error, createdAt: at })
  }
}

export class PgErasureStore implements ErasureStore {
  constructor(private db: Db) {}
  async eraseUser(scope: Scope, userId: string) {
    return this.db.transaction(async (tx) => {
      const deletedEvents = await tx.delete(events)
        .where(and(scoped(events, scope), eq(events.userId, userId)))
        .returning({ id: events.id })
      const deletedProgress = await tx.delete(achievementProgress)
        .where(and(scoped(achievementProgress, scope), eq(achievementProgress.userId, userId)))
        .returning({ achievementId: achievementProgress.achievementId })
      const deletedUnlocks = await tx.delete(unlocks)
        .where(and(scoped(unlocks, scope), eq(unlocks.userId, userId)))
        .returning({ achievementId: unlocks.achievementId })
      const deletedOfferEvents = await tx.delete(offerEvents)
        .where(and(scoped(offerEvents, scope), eq(offerEvents.userId, userId)))
        .returning({ id: offerEvents.id })
      return {
        events: deletedEvents.length,
        progress: deletedProgress.length,
        unlocks: deletedUnlocks.length,
        offerEvents: deletedOfferEvents.length,
      }
    })
  }
}
