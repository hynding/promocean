import { z } from 'zod'

export const achievementStatusSchema = z.object({
  achievementId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  current: z.number().int(),
  target: z.number().int(),
  unlockedAt: z.string().datetime().nullable(),
})
export type AchievementStatus = z.infer<typeof achievementStatusSchema>

export const userAchievementsResponseSchema = z.object({
  achievements: z.array(achievementStatusSchema),
})
export type UserAchievementsResponse = z.infer<typeof userAchievementsResponseSchema>
