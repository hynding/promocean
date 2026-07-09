import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { trackEventRequestSchema, type TrackEventResponse } from '@promocean/contracts'
import {
  activeMultiplier, evaluateEvent, localDayFromOffset, pointsForEvent, suggestEventType,
  type EngagementWrite, type Scope,
} from '@promocean/core'
import type { AppDeps } from '../app.js'
import { logger } from '../logger.js'

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

    // Config-plane failure must not block ingestion: fail open (same pattern as the
    // multiplier lookup below), just without enforcement for this request.
    const registered = await deps.configStore.getRegisteredEventTypes(scope.projectId).catch((err) => {
      logger.child({ requestId: c.get('requestId') }).warn(
        { err }, 'registered event types fetch failed; skipping unregistered-event-type enforcement',
      )
      return [] as string[]
    })
    if (registered.length > 0 && !registered.includes(type)) {
      return c.json({
        error: {
          code: 'unregistered_event_type',
          message: `Unknown event type "${type}".`,
          details: { suggestion: suggestEventType(type, registered) },
        },
      }, 400)
    }

    const definitions = await deps.configStore.getAchievements(scope.projectId)

    // Same fail-open contract as the registered-types gate above: a config-plane hiccup must
    // not block ingestion, it just means no point award is applied for this request.
    const pointRules = await deps.configStore.getPointRules(scope.projectId).catch((err) => {
      logger.child({ requestId: c.get('requestId') }).warn({ err }, 'point rules fetch failed; skipping point award for this request')
      return {}
    })

    let multiplier = 1
    try {
      multiplier = activeMultiplier(await deps.configStore.getTimedEvents(scope.projectId), occurredAt)
    } catch (err) {
      logger.child({ requestId: c.get('requestId') }).warn({ err }, 'timed events fetch failed; defaulting multiplier to 1')
    }

    const plan = evaluateEvent({ userId, type, occurredAt }, definitions, multiplier)
    const month = new Date().toISOString().slice(0, 7)

    // Built from the already-fetched `definitions` above — no second config-plane round trip.
    // Safe lookup (not `!`): mirrors the nameById fallback below for the same reason (a store/
    // evaluation mismatch must degrade gracefully, not throw).
    const defsById = new Map(definitions.map((d) => [d.id, d]))
    const eventPoints = pointsForEvent(pointRules, type)
    const engagement: EngagementWrite = {
      localDay: localDayFromOffset(occurredAt, parsed.data.tzOffsetMinutes),
      eventPoints: eventPoints > 0 ? { points: eventPoints, sourceRef: type } : null,
      unlockPoints: Object.fromEntries(
        plan.increments
          .filter((i) => (defsById.get(i.achievementId)?.pointsValue ?? 0) > 0)
          .map((i) => [i.achievementId, defsById.get(i.achievementId)?.pointsValue ?? 0]),
      ),
    }

    const outcome = await deps.ingestionStore.ingestEvent(
      scope,
      { userId, type, idempotencyKey, occurredAt, meta },
      plan.increments.map(({ achievementId, delta, target }) => ({ achievementId, delta, target })),
      month,
      engagement,
    )
    if (outcome.deduped) {
      return c.json({ deduped: true, unlocks: [], progress: [] } satisfies TrackEventResponse)
    }

    const nameById = new Map(plan.increments.map((i) => [i.achievementId, i.name]))
    const unlocks: TrackEventResponse['unlocks'] = outcome.newUnlocks.map((u) => ({
      achievementId: u.achievementId,
      name: nameById.get(u.achievementId) ?? u.achievementId,
      unlockedAt: u.unlockedAt.toISOString(),
    }))

    if (unlocks.length > 0 && deps.webhooks) {
      void deps.webhooks
        .deliver(scope.projectId, {
          messageId: randomUUID(),
          type: 'achievement.unlocked',
          data: { userId, environment: scope.environment, unlocks },
          createdAt: unlocks[0]!.unlockedAt,
        })
        .catch(() => {})
    }

    return c.json({ deduped: false, unlocks, progress: outcome.progress } satisfies TrackEventResponse)
  })
  return app
}
