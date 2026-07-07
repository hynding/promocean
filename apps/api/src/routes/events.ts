import { Hono } from 'hono'
import { trackEventRequestSchema, type TrackEventResponse } from '@promocean/contracts'
import { evaluateEvent, type Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function eventsRoute(deps: AppDeps) {
  const app = new Hono()
  app.post('/', async (c) => {
    const parsed = trackEventRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid track payload.', details: parsed.error.issues } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const { userId, type, idempotencyKey, meta } = parsed.data
    const occurredAt = parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date()

    const { deduped } = await deps.eventStore.insertEvent(scope, { userId, type, idempotencyKey, occurredAt, meta })
    if (deduped) {
      return c.json({ deduped: true, unlocks: [], progress: [] } satisfies TrackEventResponse)
    }

    const definitions = await deps.configStore.getAchievements(scope.projectId)
    const relevant = definitions.filter((d) => d.eventType === type)
    const counts = await deps.progressStore.getCounts(scope, userId, relevant.map((d) => d.id))
    const result = evaluateEvent({ userId, type, occurredAt }, definitions, counts)

    const unlockedAt = new Date()
    const unlocks: TrackEventResponse['unlocks'] = []
    for (const u of result.progressUpdates) {
      await deps.progressStore.setProgress(scope, userId, u.achievementId, u.current)
    }
    for (const u of result.unlocks) {
      const isNew = await deps.progressStore.recordUnlock(scope, userId, u.achievementId, unlockedAt)
      if (isNew) unlocks.push({ achievementId: u.achievementId, name: u.name, unlockedAt: unlockedAt.toISOString() })
    }
    await deps.usageStore.recordUsage(scope, userId, occurredAt.toISOString().slice(0, 7))

    return c.json({ deduped: false, unlocks, progress: result.progressUpdates } satisfies TrackEventResponse)
  })
  return app
}
