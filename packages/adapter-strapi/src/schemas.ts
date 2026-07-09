/**
 * Module-local zod schemas for the Strapi config-plane HTTP responses.
 *
 * These validate the wire shapes StrapiConfigPlane fetches from the CMS. They are
 * intentionally NOT exported from @promocean/contracts (contracts stays wire-API-only,
 * i.e. the API surface promocean's own HTTP API exposes to SDK consumers) and are not
 * part of this package's public surface either — index.ts does not re-export them.
 */
import { z } from 'zod'

export const achievementsResponseSchema = z.object({
  achievements: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      artworkUrl: z.string().nullable(),
      eventType: z.string(),
      targetCount: z.number(),
      pointsValue: z.number().int().min(0).default(0),
    }),
  ),
})

export const offersResponseSchema = z.object({
  offers: z.array(
    z.object({
      id: z.string(),
      placementSlug: z.string(),
      headline: z.string(),
      body: z.string().nullable(),
      imageUrl: z.string().nullable(),
      ctaText: z.string().nullable(),
      ctaUrl: z.string().nullable(),
      startsAt: z.string().nullable(),
      endsAt: z.string().nullable(),
      priority: z.number().default(0),
      timedEventId: z.string().nullable(),
    }),
  ),
})

const timedEventFieldsSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  endingSoonMinutes: z.number().default(1440),
  multiplier: z.number().default(1),
  enabled: z.boolean(),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
  recurrenceEndsAt: z.string().nullable().default(null),
})

export const timedEventsResponseSchema = z.object({
  events: z.array(timedEventFieldsSchema),
})

export const allTimedEventsResponseSchema = z.object({
  events: z.array(timedEventFieldsSchema.extend({ projectId: z.string() })),
})

export const webhookEndpointsResponseSchema = z.object({
  endpoints: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      secret: z.string(),
      enabled: z.boolean(),
    }),
  ),
})

export const eventTypesResponseSchema = z.object({
  eventTypes: z.array(z.string()),
})

// Values are floored to non-negative integers on map (see StrapiConfigPlane.getPointRules) as
// defense in depth — the cms config-plane controller already filters non-integer/negative
// entries out of pointRules before responding, this mirrors that cheaply on our side too.
export const pointRulesResponseSchema = z.object({
  pointRules: z.record(z.string(), z.number()),
})

export const rewardsResponseSchema = z.object({
  rewards: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      codeType: z.enum(['generated', 'static']),
      staticCode: z.string().nullable(),
      codePrefix: z.string().nullable(),
      pointsPrice: z.number().int().min(0),
      startsAt: z.iso.datetime().nullable(),
      endsAt: z.iso.datetime().nullable(),
      perUserLimit: z.number().int().min(1),
      inventory: z.number().int().min(1).nullable(),
      enabled: z.boolean(),
    }),
  ),
})

// allowedOrigins is intentionally z.unknown(): a junk value (wrong element types, non-array,
// etc.) must not fail the whole parse — it degrades to `null` in AuthContext, same as today.
// environment/keyType, by contrast, must validate strictly: a bad enum means the CMS record
// is corrupt and verifyKey must fail closed to `null` auth rather than return a bad AuthContext.
export const verifyKeyResponseSchema = z.object({
  projectId: z.string(),
  environment: z.enum(['test', 'live']),
  keyType: z.enum(['publishable', 'secret']),
  allowedOrigins: z.unknown(),
})
