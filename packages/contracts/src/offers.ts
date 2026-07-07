import { z } from 'zod'

export const PLACEMENT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/

export const offerCreativeSchema = z.object({
  offerId: z.string(),
  headline: z.string(),
  body: z.string().nullable(),
  imageUrl: z.string().nullable(),
  ctaText: z.string().nullable(),
  ctaUrl: z.string().nullable(),
})
export type OfferCreative = z.infer<typeof offerCreativeSchema>

export const placementOfferResponseSchema = z.object({
  offer: offerCreativeSchema.nullable(),
})
export type PlacementOfferResponse = z.infer<typeof placementOfferResponseSchema>

export const offerClickRequestSchema = z.object({
  userId: z.string().min(1).max(128).optional(),
})
export type OfferClickRequest = z.infer<typeof offerClickRequestSchema>

export const offerClickResponseSchema = z.object({ recorded: z.boolean() })
export type OfferClickResponse = z.infer<typeof offerClickResponseSchema>
