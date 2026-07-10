import { Hono } from 'hono'
import type { BackfillResponse } from '@promocean/contracts'
import type { Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

/**
 * Retroactive achievement backfill: recomputes progress/unlocks/points for an achievement
 * against all historical events of its eventType, for callers who added or changed an
 * achievement definition after events had already been ingested. Mutating and potentially
 * expensive (scans all matching events for the project/environment), so — like coupons.ts —
 * it requires a secret key. Config-plane failures propagate to the app-level onError handler
 * (500, fail closed): we never want to backfill against a definition we failed to resolve.
 */
export function achievementsRoute(deps: AppDeps) {
  const app = new Hono()

  app.post('/:id/backfill', async (c) => {
    const auth = c.get('auth')
    if (auth.keyType !== 'secret') {
      return c.json({ error: { code: 'forbidden', message: 'Secret key required.' } }, 403)
    }
    const id = c.req.param('id')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const defs = await deps.configStore.getAchievements(scope.projectId)
    const def = defs.find((d) => d.id === id)
    if (!def) {
      return c.json({ error: { code: 'not_found', message: 'Unknown achievement id.' } }, 404)
    }
    const result = await deps.backfillStore.backfillAchievement(scope, def)
    if (!result.ok) {
      return c.json({ error: { code: 'backfill_in_progress', message: 'A backfill for this achievement is already running.' } }, 409)
    }
    const summary: BackfillResponse = {
      usersEvaluated: result.usersEvaluated,
      progressRaised: result.progressRaised,
      unlocksGranted: result.unlocksGranted,
      pointsAwarded: result.pointsAwarded,
    }
    return c.json(summary satisfies BackfillResponse)
  })

  return app
}
