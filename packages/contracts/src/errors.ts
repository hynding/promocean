import { z } from 'zod'

export const errorCodeSchema = z.enum([
  'invalid_api_key',
  'invalid_payload',
  'rate_limited',
  'origin_not_allowed',
  'forbidden',
  'not_found',
  'internal_error',
  'unregistered_event_type',
])
export type ErrorCode = z.infer<typeof errorCodeSchema>

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>
