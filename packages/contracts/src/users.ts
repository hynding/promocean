import { z } from 'zod'

export const eraseUserResponseSchema = z.object({
  erased: z.literal(true),
  counts: z.object({
    events: z.number().int(),
    progress: z.number().int(),
    unlocks: z.number().int(),
    offerEvents: z.number().int(),
    pointsLedger: z.number().int(),
    streaks: z.number().int(),
    coupons: z.number().int(),
  }),
})
export type EraseUserResponse = z.infer<typeof eraseUserResponseSchema>
