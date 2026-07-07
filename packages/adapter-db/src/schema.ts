import { integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
}, (t) => [uniqueIndex('events_idem_uq').on(t.projectId, t.environment, t.idempotencyKey)])

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
}, (t) => [uniqueIndex('unlocks_uq').on(t.projectId, t.environment, t.userId, t.achievementId)])

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
