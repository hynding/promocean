import { z } from 'zod'

export const webhookMessageSchema = z.object({
  type: z.enum(['timed_event.live', 'timed_event.ending_soon', 'timed_event.ended', 'achievement.unlocked']),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
})
export type WebhookMessage = z.infer<typeof webhookMessageSchema>

export const WEBHOOK_SIGNATURE_HEADER = 'x-promocean-signature'
