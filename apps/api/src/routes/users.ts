import { Hono } from 'hono'
import type { UserAchievementsResponse } from '@promocean/contracts'
import type { Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function usersRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/:userId/achievements', async (c) => {
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const userId = c.req.param('userId')
    const [definitions, states] = await Promise.all([
      deps.configStore.getAchievements(scope.projectId),
      deps.progressStore.getUserAchievements(scope, userId),
    ])
    const byId = new Map(states.map((s) => [s.achievementId, s]))
    const achievements = definitions.map((d) => {
      const s = byId.get(d.id)
      return {
        achievementId: d.id, name: d.name, description: d.description, artworkUrl: d.artworkUrl,
        current: s?.current ?? 0, target: d.targetCount,
        unlockedAt: s?.unlockedAt ? s.unlockedAt.toISOString() : null,
      }
    })
    return c.json({ achievements } satisfies UserAchievementsResponse)
  })
  return app
}
