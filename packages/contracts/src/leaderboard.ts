import { z } from 'zod'

export const leaderboardWindowSchema = z.enum(['all', '7d', '30d'])
export type LeaderboardWindow = z.infer<typeof leaderboardWindowSchema>

export const leaderboardResponseSchema = z.object({
  window: leaderboardWindowSchema,
  entries: z.array(
    z.object({
      rank: z.number().int().min(1),
      userId: z.string(),
      points: z.number().int(),
    }),
  ),
})
export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>
