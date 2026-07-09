import { z } from 'zod'

export const walletResponseSchema = z.object({
  balance: z.number().int(),
  recent: z.array(
    z.object({
      delta: z.number().int(),
      source: z.enum(['event', 'unlock']),
      sourceRef: z.string(),
      at: z.iso.datetime(),
    }),
  ),
})
export type WalletResponse = z.infer<typeof walletResponseSchema>
