import { z } from 'zod'

export const configSlugSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/)
export const configFileSchema = z.object({
  formatVersion: z.literal(1),
  project: z.object({
    pointRules: z.record(z.string(), z.number().int().min(0)),
    registeredEventTypes: z.array(z.string()),
    allowedOrigins: z.array(z.string()).nullable(),
  }),
  placements: z.array(z.object({ slug: configSlugSchema, name: z.string() })),
  achievements: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    artworkUrl: z.string().nullable(), eventType: z.string(),
    targetCount: z.number().int().min(1), pointsValue: z.number().int().min(0),
  })),
  timedEvents: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
    endingSoonMinutes: z.number().int().min(1), multiplier: z.number().int().min(1),
    recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']),
    recurrenceEndsAt: z.iso.datetime().nullable(), enabled: z.boolean(),
  })),
  offers: z.array(z.object({
    slug: configSlugSchema, name: z.string(), headline: z.string(),
    body: z.string().nullable(), imageUrl: z.string().nullable(),
    ctaText: z.string().nullable(), ctaUrl: z.string().nullable(),
    startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
    priority: z.number().int(), placement: configSlugSchema,
    timedEvent: configSlugSchema.nullable(),
  })),
  rewards: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    codeType: z.enum(['generated', 'static']), staticCode: z.string().nullable(),
    codePrefix: z.string().nullable(), pointsPrice: z.number().int().min(0),
    startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
    perUserLimit: z.number().int().min(1), inventory: z.number().int().min(1).nullable(),
    enabled: z.boolean(),
  })),
})
export const importRequestSchema = z.object({
  file: configFileSchema,
  prune: z.boolean().default(false),
  dryRun: z.boolean().default(false),
})
const typePlanSchema = z.object({
  creates: z.array(z.string()), updates: z.array(z.string()),
  deletes: z.array(z.string()), unchanged: z.number().int().min(0),
})
export const importResponseSchema = z.object({
  applied: z.boolean(),
  plan: z.object({
    project: typePlanSchema, placements: typePlanSchema, achievements: typePlanSchema,
    timedEvents: typePlanSchema, offers: typePlanSchema, rewards: typePlanSchema,
  }),
  error: z.object({ stage: z.string(), message: z.string() }).optional(),
})
export type ConfigFile = z.infer<typeof configFileSchema>
export type ImportRequest = z.infer<typeof importRequestSchema>
export type ImportResponse = z.infer<typeof importResponseSchema>
