import { Hono } from 'hono'
import type { LiveEventsResponse } from '@promocean/contracts'
import { occurrenceWindow, timedEventState, type Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function liveEventsRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/live', async (c) => {
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const defs = await deps.configStore.getTimedEvents(scope.projectId)
    const now = new Date()
    const events = defs
      .map((e) => ({ e, state: timedEventState(e, now), w: occurrenceWindow(e, now) }))
      .filter((x): x is typeof x & { w: NonNullable<typeof x.w> } => x.w !== null)
      .filter(({ state }) => state === 'scheduled' || state === 'live' || state === 'ending_soon')
      .map(({ e, state, w }) => ({
        eventId: e.id,
        name: e.name,
        description: e.description,
        state: state as 'scheduled' | 'live' | 'ending_soon',
        // The CURRENT (or next) occurrence's window, not the definition's own bounds.
        startsAt: w.startsAt.toISOString(),
        endsAt: w.endsAt.toISOString(),
        multiplier: e.multiplier,
        secondsUntilStart: state === 'scheduled' ? Math.ceil((w.startsAt.getTime() - now.getTime()) / 1000) : null,
        secondsUntilEnd: Math.ceil((w.endsAt.getTime() - now.getTime()) / 1000),
        recurrence: e.recurrence,
        // Evaluating occurrenceWindow AT w.endsAt yields the occurrence after this one, because
        // window containment is end-exclusive; 'none' events return null there (no next).
        nextOccurrenceStartsAt: occurrenceWindow(e, w.endsAt)?.startsAt.toISOString() ?? null,
      }))
    return c.json({ events } satisfies LiveEventsResponse)
  })
  return app
}
