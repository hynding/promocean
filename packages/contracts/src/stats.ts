import { z } from 'zod'

export const statsQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})
export type StatsQuery = z.infer<typeof statsQuerySchema>

export const statsResponseSchema = z.object({
  range: z.object({ from: z.iso.datetime().nullable(), to: z.iso.datetime().nullable() }),
  totals: z.object({
    events: z.number().int(), unlocks: z.number().int(),
    impressions: z.number().int(), clicks: z.number().int(),
    timedEventParticipants: z.number().int(),
  }),
  achievements: z.array(z.object({ achievementId: z.string(), unlocks: z.number().int() })),
  offers: z.array(z.object({
    offerId: z.string(), impressions: z.number().int(), clicks: z.number().int(),
    ctr: z.number().nullable(), // clicks/impressions, null when impressions === 0
  })),
  timedEvents: z.array(z.object({ eventId: z.string(), name: z.string(), participants: z.number().int() })),
})
export type StatsResponse = z.infer<typeof statsResponseSchema>
