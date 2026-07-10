import { Hono } from 'hono'
import { statsQuerySchema, type StatsResponse } from '@promocean/contracts'
import { occurrenceWindowsInRange, type Scope, type TimedEventDefinition } from '@promocean/core'
import type { AppDeps } from '../app.js'
import { logger } from '../logger.js'

export function statsRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/', async (c) => {
    const auth = c.get('auth')
    if (auth.keyType !== 'secret') {
      return c.json({ error: { code: 'forbidden', message: 'Secret key required.' } }, 403)
    }

    const parsed = statsQuerySchema.safeParse({ from: c.req.query('from'), to: c.req.query('to') })
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid query.', details: parsed.error.issues } }, 400)
    }
    const from = parsed.data.from ? new Date(parsed.data.from) : null
    const to = parsed.data.to ? new Date(parsed.data.to) : null
    if (from && to && from > to) {
      return c.json({ error: { code: 'invalid_payload', message: '`from` must not be after `to`.' } }, 400)
    }

    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }

    let timedEventDefs: TimedEventDefinition[] = []
    try {
      timedEventDefs = await deps.configStore.getTimedEvents(scope.projectId)
    } catch (err) {
      logger.child({ requestId: c.get('requestId') }).warn(
        { err }, 'timed events fetch failed; stats serving with empty timed-event windows',
      )
    }
    // Enumerate each event's occurrence windows intersecting the range (recurring events
    // contribute one window per occurrence). occurrenceWindowsInRange clamps to the most recent
    // 400 windows per event; the core defaults nulls here to the event's start / now.
    const now = new Date()
    const windows = timedEventDefs.flatMap((e) =>
      occurrenceWindowsInRange(e, from ?? e.startsAt, to ?? now).map((w) => ({
        eventId: e.id,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
      })),
    )

    const stats = await deps.statsStore.getStats(scope, { from, to }, windows)

    const offers = stats.offers.map((o) => ({
      offerId: o.offerId,
      impressions: o.impressions,
      clicks: o.clicks,
      ctr: o.impressions === 0 ? null : o.clicks / o.impressions,
    }))

    const participantsByEventId = new Map(stats.timedEvents.map((t) => [t.eventId, t.participants]))
    const timedEvents = timedEventDefs.map((e) => ({
      eventId: e.id,
      name: e.name,
      participants: participantsByEventId.get(e.id) ?? 0,
    }))

    return c.json({
      range: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
      totals: stats.totals,
      achievements: stats.achievements,
      offers,
      timedEvents,
    } satisfies StatsResponse)
  })
  return app
}
