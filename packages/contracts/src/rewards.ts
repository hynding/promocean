import { z } from 'zod'

export const rewardSchema = z.object({
  slug: z.string(), name: z.string(), description: z.string().nullable(),
  codeType: z.enum(['generated', 'static']),   // staticCode itself is NEVER in this schema
  pointsPrice: z.number().int().min(0),
  startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
  perUserLimit: z.number().int().min(1),
  inventory: z.number().int().min(1).nullable(),
  remaining: z.number().int().min(0).nullable(), // null = uncapped
})
export const rewardsResponseSchema = z.object({ rewards: z.array(rewardSchema) })
export const claimRewardRequestSchema = z.object({ userId: z.string().min(1).max(128) })
export const claimRewardResponseSchema = z.object({
  code: z.string(), rewardSlug: z.string(), claimedAt: z.iso.datetime(), pointsSpent: z.number().int().min(0),
})
export const couponCodeSchema = z.string().min(1).max(64)
export const validateCouponRequestSchema = z.object({ code: couponCodeSchema })
export const validateCouponResponseSchema = z.object({
  valid: z.boolean(),
  rewardSlug: z.string().optional(),           // present whenever the code resolved to a reward
  status: z.enum(['claimed', 'redeemed']).optional(),
  reason: z.enum(['not_found', 'already_redeemed', 'expired']).optional(), // present iff valid: false
})
export const redeemCouponRequestSchema = z.object({ code: couponCodeSchema })
export const redeemCouponResponseSchema = z.object({
  redeemed: z.literal(true), rewardSlug: z.string(), redeemedAt: z.iso.datetime(),
})
export type Reward = z.infer<typeof rewardSchema>
export type RewardsResponse = z.infer<typeof rewardsResponseSchema>
export type ClaimRewardRequest = z.infer<typeof claimRewardRequestSchema>
export type ClaimRewardResponse = z.infer<typeof claimRewardResponseSchema>
export type CouponCode = z.infer<typeof couponCodeSchema>
export type ValidateCouponRequest = z.infer<typeof validateCouponRequestSchema>
export type ValidateCouponResponse = z.infer<typeof validateCouponResponseSchema>
export type RedeemCouponRequest = z.infer<typeof redeemCouponRequestSchema>
export type RedeemCouponResponse = z.infer<typeof redeemCouponResponseSchema>
