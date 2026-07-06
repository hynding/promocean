import { z } from 'zod'

export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/

export const trackEventRequestSchema = z.object({
  userId: z.string().min(1).max(128),
  type: z.string().regex(EVENT_TYPE_PATTERN).max(64),
  idempotencyKey: z.string().min(8).max(128),
  occurredAt: z.iso.datetime().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type TrackEventRequest = z.infer<typeof trackEventRequestSchema>

export const unlockPayloadSchema = z.object({
  achievementId: z.string(),
  name: z.string(),
  unlockedAt: z.iso.datetime(),
})
export type UnlockPayload = z.infer<typeof unlockPayloadSchema>

export const trackEventResponseSchema = z.object({
  deduped: z.boolean(),
  unlocks: z.array(unlockPayloadSchema),
  progress: z.array(
    z.object({ achievementId: z.string(), current: z.number().int(), target: z.number().int() }),
  ),
})
export type TrackEventResponse = z.infer<typeof trackEventResponseSchema>
