import { Hono } from 'hono'
import { z } from 'zod'
import { leaderboardWindowSchema, type LeaderboardResponse, type StreakResponse, type WalletResponse } from '@promocean/contracts'
import type { Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

const leaderboardQuerySchema = z.object({
  window: leaderboardWindowSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
})

function isValidUserId(userId: string) {
  return userId.length >= 1 && userId.length <= 128
}

/**
 * Wallet, streak, and leaderboard read endpoints. Housed in one file: they share nothing but
 * deps (all three are thin reads through EngagementStore, mapping to contract shapes), so a
 * dedicated file per handler would just be ceremony.
 */
export function engagementRoute(deps: AppDeps) {
  const app = new Hono()

  app.get('/users/:userId/wallet', async (c) => {
    const userId = c.req.param('userId')
    if (!isValidUserId(userId)) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid userId.' } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const wallet = await deps.engagementStore.getWallet(scope, userId)
    return c.json({
      balance: wallet.balance,
      recent: wallet.recent.map((r) => ({ delta: r.delta, source: r.source, sourceRef: r.sourceRef, at: r.at.toISOString() })),
    } satisfies WalletResponse)
  })

  app.get('/users/:userId/streak', async (c) => {
    const userId = c.req.param('userId')
    if (!isValidUserId(userId)) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid userId.' } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const streak = await deps.engagementStore.getStreak(scope, userId)
    return c.json({
      current: streak.current,
      longest: streak.longest,
      lastActiveDay: streak.lastActiveDay,
    } satisfies StreakResponse)
  })

  app.get('/leaderboard', async (c) => {
    const parsed = leaderboardQuerySchema.safeParse({
      window: c.req.query('window') ?? undefined,
      limit: c.req.query('limit') ?? undefined,
    })
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid query.', details: parsed.error.issues } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const entries = await deps.engagementStore.getLeaderboard(scope, parsed.data.window, parsed.data.limit)
    return c.json({ window: parsed.data.window, entries } satisfies LeaderboardResponse)
  })

  return app
}
