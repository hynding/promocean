import { sql } from 'drizzle-orm'
import { date, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const runtime = pgSchema('runtime')

export const events = runtime.table('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('events_idem_uq').on(t.projectId, t.environment, t.idempotencyKey),
  index('events_stats_ix').on(t.projectId, t.environment, t.occurredAt),
])

export const achievementProgress = runtime.table('achievement_progress', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  userId: text('user_id').notNull(),
  achievementId: text('achievement_id').notNull(),
  current: integer('current').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('progress_uq').on(t.projectId, t.environment, t.userId, t.achievementId)])

export const unlocks = runtime.table('unlocks', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  userId: text('user_id').notNull(),
  achievementId: text('achievement_id').notNull(),
  unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex('unlocks_uq').on(t.projectId, t.environment, t.userId, t.achievementId),
  index('unlocks_stats_ix').on(t.projectId, t.environment, t.achievementId),
])

export const monthlyActiveUsers = runtime.table('monthly_active_users', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  month: text('month').notNull(),
  userId: text('user_id').notNull(),
}, (t) => [uniqueIndex('mau_uq').on(t.projectId, t.environment, t.month, t.userId)])

export const usageCounters = runtime.table('usage_counters', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  month: text('month').notNull(),
  eventsCount: integer('events_count').notNull().default(0),
}, (t) => [uniqueIndex('usage_uq').on(t.projectId, t.environment, t.month)])

export const offerEvents = runtime.table('offer_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  offerId: text('offer_id').notNull(),
  userId: text('user_id'),
  kind: text('kind').notNull(), // 'impression' | 'click'
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('offer_events_idem_uq')
    .on(t.projectId, t.environment, t.idempotencyKey)
    .where(sql`${t.kind} = 'impression' and ${t.idempotencyKey} is not null`),
  index('offer_events_stats_ix').on(t.projectId, t.environment, t.offerId, t.kind),
])

export const timedEventNotifications = runtime.table('timed_event_notifications', {
  projectId: text('project_id').notNull(),
  eventId: text('event_id').notNull(),
  transition: text('transition').notNull(),
  firedAt: timestamp('fired_at', { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
}, (t) => [uniqueIndex('event_notif_uq').on(t.projectId, t.eventId, t.transition)])

export const webhookDeadLetters = runtime.table('webhook_dead_letters', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: text('project_id').notNull(),
  url: text('url').notNull(),
  payload: text('payload').notNull(),
  error: text('error').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const pointsLedger = runtime.table('points_ledger', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  userId: text('user_id').notNull(),
  delta: integer('delta').notNull(),
  source: text('source').notNull(),
  sourceRef: text('source_ref').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('points_ledger_user_ix').on(t.projectId, t.environment, t.userId),
  index('points_ledger_window_ix').on(t.projectId, t.environment, t.createdAt),
])

export const userStreaks = runtime.table('user_streaks', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  userId: text('user_id').notNull(),
  currentStreak: integer('current_streak').notNull().default(0),
  longestStreak: integer('longest_streak').notNull().default(0),
  lastActiveDay: date('last_active_day'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('user_streaks_uq').on(t.projectId, t.environment, t.userId),
])
