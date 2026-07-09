import { z } from 'zod'

export const recurrenceSchema = z.enum(['none', 'daily', 'weekly', 'monthly'])
export type Recurrence = z.infer<typeof recurrenceSchema>

export const liveTimedEventSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  state: z.enum(['scheduled', 'live', 'ending_soon']),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  multiplier: z.number().int().min(1),
  secondsUntilStart: z.number().int().nullable(),
  secondsUntilEnd: z.number().int(),
  // Additive-with-defaults: old-server responses without these fields still parse.
  recurrence: recurrenceSchema.default('none'),
  // Start of the occurrence AFTER the one reported in startsAt/endsAt; null when none.
  nextOccurrenceStartsAt: z.iso.datetime().nullable().default(null),
})
export type LiveTimedEvent = z.infer<typeof liveTimedEventSchema>

export const liveEventsResponseSchema = z.object({ events: z.array(liveTimedEventSchema) })
export type LiveEventsResponse = z.infer<typeof liveEventsResponseSchema>
