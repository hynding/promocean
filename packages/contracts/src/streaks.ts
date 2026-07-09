import { z } from 'zod'

export const streakResponseSchema = z.object({
  current: z.number().int(),
  longest: z.number().int(),
  lastActiveDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
})
export type StreakResponse = z.infer<typeof streakResponseSchema>
