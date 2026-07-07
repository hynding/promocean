import { Hono } from 'hono'
import type { LiveEventsResponse } from '@promocean/contracts'
import { timedEventState, type Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function liveEventsRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/live', async (c) => {
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const defs = await deps.configStore.getTimedEvents(scope.projectId)
    const now = new Date()
    const events = defs
      .map((e) => ({ e, state: timedEventState(e, now) }))
      .filter(({ state }) => state === 'scheduled' || state === 'live' || state === 'ending_soon')
      .map(({ e, state }) => ({
        eventId: e.id,
        name: e.name,
        description: e.description,
        state: state as 'scheduled' | 'live' | 'ending_soon',
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        multiplier: e.multiplier,
        secondsUntilStart: state === 'scheduled' ? Math.ceil((e.startsAt.getTime() - now.getTime()) / 1000) : null,
        secondsUntilEnd: Math.ceil((e.endsAt.getTime() - now.getTime()) / 1000),
      }))
    return c.json({ events } satisfies LiveEventsResponse)
  })
  return app
}
