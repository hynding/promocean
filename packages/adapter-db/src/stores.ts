import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm'
import { applyStreak, couponCodeFromBytes, decideClaim, type AchievementDefinition, type BackfillStore, type EngagementStore, type EngagementWrite, type ErasureStore, type IngestionStore, type OfferMetricsStore, type ProgressStore, type RewardDefinition, type RewardStore, type Scope, type StatsStore, type StreakState, type TimedEventTransition, type UsageStore, type WebhookDeliveryStore } from '@promocean/core'
import { achievementProgress, coupons, events, monthlyActiveUsers, offerEvents, pointsLedger, timedEventNotifications, unlocks, usageCounters, userStreaks, webhookDeadLetters } from './schema.js'
import type { Db } from './index.js'

const scoped = (t: { projectId: any; environment: any }, s: Scope) =>
  and(eq(t.projectId, s.projectId), eq(t.environment, s.environment))

/**
 * Drizzle declares `last_active_day` in string mode, and the adapter's node-postgres session
 * overrides pg's own DATE type parser to hand back the raw wire text (see
 * drizzle-orm/node-postgres/session.js) — so in practice this column always arrives as a plain
 * 'YYYY-MM-DD' string through drizzle's query builder. We still normalize defensively here in
 * case a Date instance ever reaches this path (e.g. a future raw-driver query), reading its
 * *local* fields — Postgres date-only values are conventionally parsed as local time by
 * node-postgres's own (bypassed-by-drizzle) date parser, so local fields are the correct ones
 * to read back off a Date, not UTC fields.
 */
function normalizeDay(value: string | Date | null): string | null {
  if (value === null) return null
  if (value instanceof Date) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return value.slice(0, 10)
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
    engagement: EngagementWrite,
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

      if (engagement.eventPoints) {
        await tx.insert(pointsLedger).values({
          ...scope,
          userId: event.userId,
          delta: engagement.eventPoints.points,
          source: 'event',
          sourceRef: engagement.eventPoints.sourceRef,
        })
      }
      for (const u of newUnlocks) {
        const points = engagement.unlockPoints[u.achievementId]
        if (!points || points <= 0) continue
        await tx.insert(pointsLedger).values({
          ...scope,
          userId: event.userId,
          delta: points,
          source: 'unlock',
          sourceRef: u.achievementId,
        })
      }

      // Streak: ensure a row exists, then lock it for the duration of this tx so concurrent
      // same-user ingests serialize through applyStreak rather than racing on a read-then-write.
      await tx.insert(userStreaks)
        .values({ ...scope, userId: event.userId, currentStreak: 0, longestStreak: 0, lastActiveDay: null })
        .onConflictDoNothing()
      const [streakRow] = await tx.select({
        currentStreak: userStreaks.currentStreak,
        longestStreak: userStreaks.longestStreak,
        lastActiveDay: userStreaks.lastActiveDay,
      })
        .from(userStreaks)
        .where(and(scoped(userStreaks, scope), eq(userStreaks.userId, event.userId)))
        .for('update')
      const prevStreak: StreakState = {
        current: streakRow!.currentStreak,
        longest: streakRow!.longestStreak,
        lastActiveDay: normalizeDay(streakRow!.lastActiveDay),
      }
      const nextStreak = applyStreak(prevStreak, engagement.localDay)
      if (nextStreak) {
        await tx.update(userStreaks)
          .set({
            currentStreak: nextStreak.current,
            longestStreak: nextStreak.longest,
            lastActiveDay: nextStreak.lastActiveDay,
            updatedAt: sql`now()`,
          })
          .where(and(scoped(userStreaks, scope), eq(userStreaks.userId, event.userId)))
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

export class PgEngagementStore implements EngagementStore {
  constructor(private db: Db) {}
  async getWallet(scope: Scope, userId: string) {
    const [balanceRow] = await this.db.select({ balance: sql<number>`COALESCE(SUM(${pointsLedger.delta}), 0)::int` })
      .from(pointsLedger)
      .where(and(scoped(pointsLedger, scope), eq(pointsLedger.userId, userId)))
    const recentRows = await this.db.select({
      delta: pointsLedger.delta,
      source: pointsLedger.source,
      sourceRef: pointsLedger.sourceRef,
      at: pointsLedger.createdAt,
    })
      .from(pointsLedger)
      .where(and(scoped(pointsLedger, scope), eq(pointsLedger.userId, userId)))
      .orderBy(desc(pointsLedger.createdAt), desc(pointsLedger.id))
      .limit(20)
    return {
      balance: balanceRow?.balance ?? 0,
      recent: recentRows.map((r) => ({ delta: r.delta, source: r.source as 'event' | 'unlock' | 'redemption', sourceRef: r.sourceRef, at: r.at })),
    }
  }
  async getStreak(scope: Scope, userId: string) {
    const [row] = await this.db.select({
      currentStreak: userStreaks.currentStreak,
      longestStreak: userStreaks.longestStreak,
      lastActiveDay: userStreaks.lastActiveDay,
    })
      .from(userStreaks)
      .where(and(scoped(userStreaks, scope), eq(userStreaks.userId, userId)))
    if (!row) return { current: 0, longest: 0, lastActiveDay: null }
    return { current: row.currentStreak, longest: row.longestStreak, lastActiveDay: normalizeDay(row.lastActiveDay) }
  }
  async getLeaderboard(scope: Scope, window: 'all' | '7d' | '30d', limit: number) {
    const conds = [scoped(pointsLedger, scope)]
    if (window === '7d') conds.push(sql`${pointsLedger.createdAt} >= now() - interval '7 days'`)
    else if (window === '30d') conds.push(sql`${pointsLedger.createdAt} >= now() - interval '30 days'`)
    const rows = await this.db.select({
      userId: pointsLedger.userId,
      points: sql<number>`SUM(${pointsLedger.delta})::int`,
    })
      .from(pointsLedger)
      .where(and(...conds))
      .groupBy(pointsLedger.userId)
      .orderBy(sql`SUM(${pointsLedger.delta}) DESC`, asc(pointsLedger.userId))
      .limit(limit)
    return rows.map((r, i) => ({ rank: i + 1, userId: r.userId, points: r.points }))
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

/**
 * Groups the flat window list by eventId while preserving first-seen order, so a single event
 * with several occurrence windows collapses to one output row whose participant count unions all
 * of its windows.
 */
type TimedEventWindow = { eventId: string; startsAt: Date; endsAt: Date }
const groupWindowsByEvent = (windows: TimedEventWindow[]): Map<string, TimedEventWindow[]> => {
  const byEvent = new Map<string, TimedEventWindow[]>()
  for (const w of windows) {
    const existing = byEvent.get(w.eventId)
    if (existing) existing.push(w)
    else byEvent.set(w.eventId, [w])
  }
  return byEvent
}

export class PgStatsStore implements StatsStore {
  /**
   * `chunkSize` caps how many events a single cross-event participant query spans, keeping the
   * OR-of-windows predicate (and its bind-parameter count) bounded when a project has many timed
   * events. Chunking is by EVENT — one event's windows are never split across chunks — and the
   * cross-event total merges each chunk's DISTINCT user_ids as JS Sets, so a user active in
   * events from different chunks is still counted once. Default 50; tests force 1 to prove the
   * chunk-count is irrelevant to the result.
   */
  constructor(private db: Db, private chunkSize = 50) {}
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
      Promise.all([...groupWindowsByEvent(timedEventWindows)].map(async ([eventId, windows]) => {
        // Participants per event = distinct users active in ANY of that event's windows: OR the
        // per-window predicates so a user active in two occurrences counts once. Range intersected
        // with each window: GREATEST/LEAST ignore null args, so a null range.from/to simply falls
        // back to the window's own bound.
        const windowConds = windows.map((w) => sql`(occurred_at between GREATEST(${w.startsAt}::timestamptz, ${range.from}::timestamptz) and LEAST(${w.endsAt}::timestamptz, ${range.to}::timestamptz))`)
        const result = await this.db.execute<{ n: number }>(sql`
          select count(distinct user_id)::int as n
          from runtime.events
          where project_id = ${scope.projectId} and environment = ${scope.environment} and (${sql.join(windowConds, sql` or `)})
        `)
        return { eventId, participants: Number(result.rows[0]?.n ?? 0) }
      })),
      (async () => {
        if (timedEventWindows.length === 0) return 0
        // Chunk the per-event window groups so each query spans at most `chunkSize` events,
        // never splitting one event's windows. Each chunk returns its DISTINCT user_ids, which
        // we merge into a single JS Set — a user active in events from two different chunks is
        // therefore counted exactly once, matching the single-query behaviour bit for bit.
        const eventGroups = [...groupWindowsByEvent(timedEventWindows)]
        const userIds = new Set<string>()
        for (let i = 0; i < eventGroups.length; i += this.chunkSize) {
          const chunkWindows = eventGroups.slice(i, i + this.chunkSize).flatMap(([, windows]) => windows)
          const windowConds = chunkWindows.map((w) => sql`(occurred_at between GREATEST(${w.startsAt}::timestamptz, ${range.from}::timestamptz) and LEAST(${w.endsAt}::timestamptz, ${range.to}::timestamptz))`)
          const result = await this.db.execute<{ user_id: string }>(sql`
            select distinct user_id
            from runtime.events
            where project_id = ${scope.projectId} and environment = ${scope.environment} and (${sql.join(windowConds, sql` or `)})
          `)
          for (const row of result.rows) userIds.add(row.user_id)
        }
        return userIds.size
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
  async claimTransition(projectId: string, eventId: string, occurrenceKey: string, transition: TimedEventTransition) {
    const inserted = await this.db.insert(timedEventNotifications)
      .values({ projectId, eventId, occurrenceKey, transition })
      .onConflictDoNothing()
      .returning({ eventId: timedEventNotifications.eventId })
    return inserted.length > 0
  }
  async recordDeadLetter(projectId: string, url: string, payload: string, error: string, at: Date) {
    await this.db.insert(webhookDeadLetters).values({ projectId, url, payload, error, createdAt: at })
  }
  async markDelivered(projectId: string, eventId: string, occurrenceKey: string, transition: TimedEventTransition) {
    await this.db.update(timedEventNotifications)
      .set({ deliveredAt: sql`now()` })
      .where(and(
        eq(timedEventNotifications.projectId, projectId),
        eq(timedEventNotifications.eventId, eventId),
        eq(timedEventNotifications.occurrenceKey, occurrenceKey),
        eq(timedEventNotifications.transition, transition),
        isNull(timedEventNotifications.deliveredAt),
      ))
  }
  async findStaleClaims(olderThan: Date, maxAttempts: number) {
    const rows = await this.db.select({
      projectId: timedEventNotifications.projectId,
      eventId: timedEventNotifications.eventId,
      occurrenceKey: timedEventNotifications.occurrenceKey,
      transition: timedEventNotifications.transition,
      attempts: timedEventNotifications.attempts,
    }).from(timedEventNotifications)
      .where(and(
        isNull(timedEventNotifications.deliveredAt),
        lt(timedEventNotifications.firedAt, olderThan),
        lt(timedEventNotifications.attempts, maxAttempts),
      ))
    return rows.map((r) => ({ ...r, transition: r.transition as TimedEventTransition }))
  }
  async incrementAttempts(projectId: string, eventId: string, occurrenceKey: string, transition: TimedEventTransition) {
    await this.db.update(timedEventNotifications)
      .set({ attempts: sql`${timedEventNotifications.attempts} + 1` })
      .where(and(
        eq(timedEventNotifications.projectId, projectId),
        eq(timedEventNotifications.eventId, eventId),
        eq(timedEventNotifications.occurrenceKey, occurrenceKey),
        eq(timedEventNotifications.transition, transition),
      ))
  }
  async findExhaustedClaims(minAttempts: number) {
    const rows = await this.db.select({
      projectId: timedEventNotifications.projectId,
      eventId: timedEventNotifications.eventId,
      occurrenceKey: timedEventNotifications.occurrenceKey,
      transition: timedEventNotifications.transition,
      attempts: timedEventNotifications.attempts,
    }).from(timedEventNotifications)
      .where(and(
        isNull(timedEventNotifications.deliveredAt),
        gte(timedEventNotifications.attempts, minAttempts),
      ))
    return rows.map((r) => ({ ...r, transition: r.transition as TimedEventTransition }))
  }
  async deleteDeadLettersBefore(cutoff: Date) {
    const deleted = await this.db.delete(webhookDeadLetters)
      .where(lt(webhookDeadLetters.createdAt, cutoff))
      .returning({ id: webhookDeadLetters.id })
    return deleted.length
  }
  async deleteDeliveredClaimsBefore(cutoff: Date) {
    // Only rows that have actually delivered are eligible for the sweep. Undelivered rows
    // (delivered_at IS NULL) are never matched by `delivered_at < cutoff` — the redelivery
    // sweep owns them until they deliver or exhaust their attempts.
    const deleted = await this.db.delete(timedEventNotifications)
      .where(and(
        isNotNull(timedEventNotifications.deliveredAt),
        lt(timedEventNotifications.deliveredAt, cutoff),
      ))
      .returning({ eventId: timedEventNotifications.eventId })
    return deleted.length
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
      const deletedPointsLedger = await tx.delete(pointsLedger)
        .where(and(scoped(pointsLedger, scope), eq(pointsLedger.userId, userId)))
        .returning({ id: pointsLedger.id })
      const deletedStreaks = await tx.delete(userStreaks)
        .where(and(scoped(userStreaks, scope), eq(userStreaks.userId, userId)))
        .returning({ userId: userStreaks.userId })
      const deletedCoupons = await tx.delete(coupons)
        .where(and(scoped(coupons, scope), eq(coupons.userId, userId)))
        .returning({ id: coupons.id })
      return {
        events: deletedEvents.length,
        progress: deletedProgress.length,
        unlocks: deletedUnlocks.length,
        offerEvents: deletedOfferEvents.length,
        pointsLedger: deletedPointsLedger.length,
        streaks: deletedStreaks.length,
        coupons: deletedCoupons.length,
      }
    })
  }
}

/**
 * Detects the coupons_code_uq unique violation (Postgres SQLSTATE 23505) that a concurrent
 * insert of the same generated code produces, tolerating drizzle's error wrapping (the pg
 * error may surface directly or under `.cause`). We only treat *this* constraint as retryable;
 * any other 23505 (or non-unique error) is rethrown so real bugs aren't masked.
 */
function isCouponCodeUniqueViolation(err: unknown): boolean {
  let e: any = err
  for (let depth = 0; depth < 5 && e != null; depth++) {
    if (e.code === '23505' && (e.constraint === undefined || e.constraint === 'coupons_code_uq')) return true
    e = e.cause
  }
  return false
}

export class PgRewardStore implements RewardStore {
  constructor(private db: Db) {}

  async getClaimCounts(scope: Scope, rewardIds: string[]) {
    if (rewardIds.length === 0) return new Map<string, number>()
    const rows = await this.db.select({
      rewardId: coupons.rewardId,
      count: sql<number>`count(*)::int`,
    })
      .from(coupons)
      .where(and(scoped(coupons, scope), inArray(coupons.rewardId, rewardIds)))
      .groupBy(coupons.rewardId)
    return new Map(rows.map((r) => [r.rewardId, r.count]))
  }

  async claimCoupon(scope: Scope, userId: string, reward: RewardDefinition, now: Date) {
    return this.db.transaction(async (tx) => {
      const ns = `${scope.projectId}:${scope.environment}`
      // Lock order is invariant: reward advisory lock first, then (only when the reward is
      // priced) the user advisory lock. The user lock serializes ALL priced claims for a user
      // across every reward, which is what makes the balance debit safe. A free reward never
      // touches the wallet, so it skips the user lock entirely.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ns}), hashtext(${'reward:' + reward.id}))`)
      if (reward.pointsPrice > 0) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ns}), hashtext(${'user:' + userId}))`)
      }

      const [claimedRow] = await tx.select({ n: sql<number>`count(*)::int` })
        .from(coupons)
        .where(and(scoped(coupons, scope), eq(coupons.rewardId, reward.id)))
      const claimedCount = claimedRow?.n ?? 0

      const [userRow] = await tx.select({ n: sql<number>`count(*)::int` })
        .from(coupons)
        .where(and(scoped(coupons, scope), eq(coupons.rewardId, reward.id), eq(coupons.userId, userId)))
      const userClaimedCount = userRow?.n ?? 0

      let balance = 0
      if (reward.pointsPrice > 0) {
        const [balRow] = await tx.select({ balance: sql<number>`COALESCE(SUM(${pointsLedger.delta}), 0)::int` })
          .from(pointsLedger)
          .where(and(scoped(pointsLedger, scope), eq(pointsLedger.userId, userId)))
        balance = balRow?.balance ?? 0
      }

      const decision = decideClaim({ reward, now, claimedCount, userClaimedCount, balance })
      if (!decision.ok) {
        // Committed-but-empty: nothing was written, so nothing rolls back. Returning the
        // rejection lets the transaction COMMIT cleanly.
        return { ok: false as const, reason: decision.reason }
      }

      let couponId: string
      let code: string
      let claimedAt: Date

      if (reward.codeType === 'static') {
        // Should be unreachable in practice — the cms lifecycle requires a non-empty staticCode
        // for every codeType: 'static' reward — but guard explicitly so a misconfigured reward
        // fails with a clear message instead of an opaque NOT NULL constraint violation on the
        // insert below.
        if (!reward.staticCode) {
          throw new Error(`static reward ${reward.id} has no staticCode configured`)
        }
        code = reward.staticCode
        const [row] = await tx.insert(coupons)
          .values({ ...scope, rewardId: reward.id, userId, code, codeShared: true })
          .returning({ id: coupons.id, claimedAt: coupons.claimedAt })
        couponId = row!.id
        claimedAt = row!.claimedAt
      } else {
        // Generated codes: up to 3 insert attempts, regenerating entropy on each collision.
        // Each attempt runs inside a SAVEPOINT (nested tx) so a 23505 rolls back only the
        // failed insert, leaving the outer claim transaction alive to retry.
        let inserted: { id: string; claimedAt: Date } | undefined
        code = ''
        for (let attempt = 0; attempt < 3; attempt++) {
          code = couponCodeFromBytes(randomBytes(10), reward.codePrefix)
          try {
            inserted = await tx.transaction(async (sp) => {
              const [row] = await sp.insert(coupons)
                .values({ ...scope, rewardId: reward.id, userId, code, codeShared: false })
                .returning({ id: coupons.id, claimedAt: coupons.claimedAt })
              return row!
            })
            break
          } catch (err) {
            if (isCouponCodeUniqueViolation(err) && attempt < 2) continue
            throw err
          }
        }
        couponId = inserted!.id
        claimedAt = inserted!.claimedAt
      }

      if (reward.pointsPrice > 0) {
        await tx.insert(pointsLedger).values({
          ...scope,
          userId,
          delta: -reward.pointsPrice,
          source: 'redemption',
          sourceRef: couponId,
        })
      }

      return { ok: true as const, couponId, code, claimedAt, pointsSpent: reward.pointsPrice }
    })
  }

  async validateCoupon(scope: Scope, code: string) {
    const [row] = await this.db.select({ rewardId: coupons.rewardId, status: coupons.status })
      .from(coupons)
      .where(and(scoped(coupons, scope), eq(coupons.code, code)))
      // Prefer an unredeemed (claimed) row so a shared code reports 'claimed' while any
      // claim remains available; then oldest-first, with id as the final tiebreak for a
      // fully deterministic pick (matches the redeem subselect's claimed_at ASC, id ASC).
      .orderBy(sql`(${coupons.status} = 'claimed') DESC`, asc(coupons.claimedAt), asc(coupons.id))
      .limit(1)
    if (!row) return { found: false as const }
    return { found: true as const, rewardId: row.rewardId, status: row.status as 'claimed' | 'redeemed' }
  }

  async redeemCoupon(scope: Scope, code: string) {
    return this.db.transaction(async (tx) => {
      const updated = await tx.execute<{ reward_id: string; redeemed_at: string | Date }>(sql`
        UPDATE runtime.coupons SET status = 'redeemed', redeemed_at = now()
        WHERE id = (
          SELECT id FROM runtime.coupons
          WHERE project_id = ${scope.projectId} AND environment = ${scope.environment}
            AND code = ${code} AND status = 'claimed'
          ORDER BY claimed_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING reward_id, redeemed_at
      `)
      const row = updated.rows[0]
      // Raw execute bypasses drizzle's parser mapping, so timestamptz arrives as wire text —
      // normalize to a Date to satisfy the RewardStore contract.
      if (row) return { ok: true as const, rewardId: row.reward_id, redeemedAt: new Date(row.redeemed_at) }

      // Zero rows: either no coupon has this code (not_found), or every matching claim is
      // already redeemed or was locked-then-redeemed by a concurrent redeemer (already_redeemed).
      const existing = await tx.execute(sql`
        SELECT 1 FROM runtime.coupons
        WHERE project_id = ${scope.projectId} AND environment = ${scope.environment} AND code = ${code}
        LIMIT 1
      `)
      if (existing.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }
      return { ok: false as const, reason: 'already_redeemed' as const }
    })
  }
}

/**
 * Retroactively applies an achievement definition against already-stored events — the path a
 * newly-created (or newly-eligible) achievement takes so historical activity counts toward it.
 *
 * The whole run is one transaction guarded by a TRY advisory lock keyed on
 * (project+environment, 'backfill:' + def.id): a concurrent backfill of the same definition does
 * NOT queue on the lock (which would stack pool connections and starve DB-backed endpoints) —
 * it returns { ok: false, reason: 'backfill_in_progress' } immediately and commits its empty
 * transaction. Live ingestion NEVER takes this lock — so a concurrent ingestEvent can race us. Two
 * belts guard that race: the progress upsert wraps its target-clamped value in GREATEST so a
 * concurrent live increment is never lowered, and the unlock insert is onConflictDoNothing so only
 * one of {backfill, ingest} wins the row and writes the single unlock bonus.
 */
export class PgBackfillStore implements BackfillStore {
  constructor(private db: Db) {}
  async backfillAchievement(scope: Scope, def: AchievementDefinition) {
    return this.db.transaction(async (tx) => {
      const ns = `${scope.projectId}:${scope.environment}`
      const [lockRow] = (await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${ns}), hashtext(${'backfill:' + def.id})) AS locked`,
      )).rows
      if (!lockRow?.locked) {
        // Another backfill of this achievement holds the lock — bail without waiting. The empty
        // transaction commits cleanly (nothing was written), leaving the running backfill alone.
        return { ok: false as const, reason: 'backfill_in_progress' as const }
      }

      const aggregate = await tx.execute<{ user_id: string; cnt: number }>(sql`
        SELECT user_id, COUNT(*)::int AS cnt
        FROM runtime.events
        WHERE project_id = ${scope.projectId} AND environment = ${scope.environment} AND type = ${def.eventType}
        GROUP BY user_id
      `)
      const rows = aggregate.rows
      const usersEvaluated = rows.length
      // Empty aggregate: nothing to evaluate, so return an all-zero summary without any writes.
      if (usersEvaluated === 0) {
        return { ok: true as const, usersEvaluated: 0, progressRaised: 0, unlocksGranted: 0, pointsAwarded: 0 }
      }

      const userIds = rows.map((r) => r.user_id)
      const existingRows = await tx.select({
        userId: achievementProgress.userId,
        current: achievementProgress.current,
      })
        .from(achievementProgress)
        .where(and(
          scoped(achievementProgress, scope),
          eq(achievementProgress.achievementId, def.id),
          inArray(achievementProgress.userId, userIds),
        ))
      const existing = new Map(existingRows.map((r) => [r.userId, r.current]))

      // Every unlock granted in this run shares one instant, exactly as PgIngestionStore does.
      const unlockedAt = new Date()
      let progressRaised = 0
      let unlocksGranted = 0
      let pointsAwarded = 0

      for (const r of rows) {
        const cnt = r.cnt
        const desired = Math.min(cnt, def.targetCount)
        const prev = existing.get(r.user_id) ?? 0
        // Only raise progress where the retroactive count actually exceeds what's stored — a live
        // (possibly multiplier-inflated) value at or above `desired` is left untouched, so it does
        // not count toward progressRaised.
        if (desired > prev) {
          await tx.insert(achievementProgress)
            .values({ ...scope, userId: r.user_id, achievementId: def.id, current: desired })
            .onConflictDoUpdate({
              target: [achievementProgress.projectId, achievementProgress.environment, achievementProgress.userId, achievementProgress.achievementId],
              // GREATEST belts the live-ingest race: a concurrent increment that landed after our
              // read is never lowered by this write.
              set: {
                current: sql`GREATEST(${achievementProgress.current}, LEAST(${cnt}::int, ${def.targetCount}::int))`,
                updatedAt: sql`now()`,
              },
            })
          progressRaised++
        }

        if (cnt >= def.targetCount) {
          const insertedUnlock = await tx.insert(unlocks)
            .values({ ...scope, userId: r.user_id, achievementId: def.id, unlockedAt })
            .onConflictDoNothing()
            .returning({ achievementId: unlocks.achievementId })
          if (insertedUnlock.length > 0) {
            unlocksGranted++
            // Gated exactly as PgIngestionStore: award the unlock bonus only for a genuinely new
            // unlock row AND a positive point value. A zero-point achievement grants no ledger row.
            if (def.pointsValue > 0) {
              await tx.insert(pointsLedger).values({
                ...scope,
                userId: r.user_id,
                delta: def.pointsValue,
                source: 'unlock',
                sourceRef: def.id,
              })
              pointsAwarded += def.pointsValue
            }
          }
        }
      }

      return { ok: true as const, usersEvaluated, progressRaised, unlocksGranted, pointsAwarded }
    })
  }
}
