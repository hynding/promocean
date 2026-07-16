import { z } from 'zod'
import { EVENT_TYPE_PATTERN } from './events.js'

export const configSlugSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/)

// Event-type keys/entries must match the SAME pattern the cms READ mappers filter
// through (mapPointRules / mapRegisteredEventTypes in the config-plane controller,
// mirroring events.ts EVENT_TYPE_PATTERN). Import WRITES raw, so a key the read
// side would silently drop diffs as forever-changed — permanent exit 2 in the CI
// drift check. Reject it at parse time instead.
const configEventTypeSchema = z.string().regex(EVENT_TYPE_PATTERN)

// A single file must not name the same slug twice within one type: the diff keys
// buckets by slug, so a dup means the dry-run predicts a clean plan the apply then
// 422s on (duplicate-key write). Reject it here, naming the type + offending slug.
function rejectDuplicateSlugs(typeName: string) {
  return (items: Array<{ slug: string }>, ctx: z.RefinementCtx) => {
    const seen = new Set<string>()
    for (let i = 0; i < items.length; i++) {
      const slug = items[i].slug
      if (seen.has(slug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate slug "${slug}" in ${typeName}`,
          path: [i, 'slug'],
        })
      }
      seen.add(slug)
    }
  }
}

export const configFileSchema = z.object({
  formatVersion: z.literal(1),
  project: z.object({
    pointRules: z.record(configEventTypeSchema, z.number().int().min(0)),
    registeredEventTypes: z.array(configEventTypeSchema),
    allowedOrigins: z.array(z.string()).nullable(),
  }),
  placements: z.array(z.object({ slug: configSlugSchema, name: z.string() }))
    .superRefine(rejectDuplicateSlugs('placements')),
  achievements: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    artworkUrl: z.string().nullable(), eventType: z.string(),
    targetCount: z.number().int().min(1), pointsValue: z.number().int().min(0),
  })).superRefine(rejectDuplicateSlugs('achievements')),
  timedEvents: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
    endingSoonMinutes: z.number().int().min(1), multiplier: z.number().int().min(1),
    recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']),
    recurrenceEndsAt: z.iso.datetime().nullable(), enabled: z.boolean(),
  })).superRefine(rejectDuplicateSlugs('timedEvents')),
  offers: z.array(z.object({
    slug: configSlugSchema, name: z.string(), headline: z.string(),
    body: z.string().nullable(), imageUrl: z.string().nullable(),
    ctaText: z.string().nullable(), ctaUrl: z.string().nullable(),
    startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
    priority: z.number().int(), placement: configSlugSchema,
    timedEvent: configSlugSchema.nullable(),
  })).superRefine(rejectDuplicateSlugs('offers')),
  rewards: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    codeType: z.enum(['generated', 'static']), staticCode: z.string().nullable(),
    codePrefix: z.string().nullable(), pointsPrice: z.number().int().min(0),
    startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
    perUserLimit: z.number().int().min(1), inventory: z.number().int().min(1).nullable(),
    enabled: z.boolean(),
  })).superRefine(rejectDuplicateSlugs('rewards')),
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
