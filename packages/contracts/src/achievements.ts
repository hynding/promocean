import { z } from 'zod'

export const achievementStatusSchema = z.object({
  achievementId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  current: z.number().int(),
  target: z.number().int(),
  unlockedAt: z.iso.datetime().nullable(),
})
export type AchievementStatus = z.infer<typeof achievementStatusSchema>

export const userAchievementsResponseSchema = z.object({
  achievements: z.array(achievementStatusSchema),
})
export type UserAchievementsResponse = z.infer<typeof userAchievementsResponseSchema>

export const backfillResponseSchema = z.object({
  usersEvaluated: z.number().int().min(0),
  progressRaised: z.number().int().min(0),
  unlocksGranted: z.number().int().min(0),
  pointsAwarded: z.number().int().min(0),
})
export type BackfillResponse = z.infer<typeof backfillResponseSchema>
