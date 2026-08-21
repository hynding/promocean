import { z } from 'zod'

export const planIdSchema = z.enum(['free', 'growth', 'scale', 'enterprise'])
export type PlanId = z.infer<typeof planIdSchema>

export const usageQuerySchema = z.object({
  // Historical month key. Omitted → the current calendar month (UTC).
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM').optional(),
})
export type UsageQuery = z.infer<typeof usageQuerySchema>

export const usageResponseSchema = z.object({
  month: z.string(), // 'YYYY-MM'
  environment: z.enum(['test', 'live']),
  mau: z.number().int(), // distinct active users this month, this environment
  events: z.number().int(), // tracked events this month, this environment
  plan: planIdSchema.nullable(), // null = self-hosted / unmetered
  // null when plan is null (unmetered) or the plan has no fixed cap (enterprise).
  mauIncluded: z.number().int().nullable(),
  // mau / mauIncluded, rounded to an integer percent; null when mauIncluded is null.
  percentUsed: z.number().int().nullable(),
  overLimit: z.boolean(),
})
export type UsageResponse = z.infer<typeof usageResponseSchema>
