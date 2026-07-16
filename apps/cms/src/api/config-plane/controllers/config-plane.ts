import { timingSafeEqual } from 'node:crypto'
import { importRequestSchema, type ConfigFile, type ImportResponse } from '@promocean/contracts'
import { computePlan, findUnknownRefs, type CurrentState } from '../services/import-plan'

// mirrors packages/contracts/src/events.ts EVENT_TYPE_PATTERN — cms doesn't import contracts
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/

function configSecretOk(ctx: any): boolean {
  const expected = process.env.CONFIG_PLANE_SECRET
  if (!expected) return false // fail closed when unset
  const provided = Buffer.from(String(ctx.request.header['x-config-secret'] ?? ''))
  const expectedBuf = Buffer.from(expected)
  return provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf)
}

// exportProject's own output ordering, independent of whatever order findMany happens to
// return rows in (DB id-assignment order, which isn't guaranteed to match input file order
// for content created via import — e.g. concurrent creates — nor guaranteed stable across
// reseeds of the same seed script). Config files are meant to be diffed/version-controlled
// and re-imported into other projects, so export's array order must be deterministic and
// depend only on content, not incidental DB history. Slug is unique per project per type, so
// sorting by it is a total order.
function sortBySlug<T extends { slug: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.slug.localeCompare(b.slug))
}

// Tolerant project-settings mappers (mirror exportProject's inline logic):
// coerce whatever is stored in the JSON columns into the file's shape,
// dropping malformed entries rather than surfacing them.
function mapPointRules(raw: any): Record<string, number> {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!EVENT_TYPE_PATTERN.test(key) || typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue
    out[key] = value
  }
  return out
}
function mapRegisteredEventTypes(raw: any): string[] {
  if (Array.isArray(raw)) return raw.filter((t: unknown): t is string => typeof t === 'string' && EVENT_TYPE_PATTERN.test(t))
  return []
}
function mapAllowedOrigins(raw: any): string[] | null {
  if (Array.isArray(raw) && raw.every((o: unknown) => typeof o === 'string')) return raw
  return null
}

// Load the current project state mapped into the file's shape (for diffing),
// plus a slug->documentId map per type (for apply's update/delete writes), plus
// the project's own slug (for the project plan bucket). Re-queried fresh on
// each call, so the post-partial-apply recompute sees the real DB state.
async function loadCurrentState(
  projectId: string,
): Promise<{ state: CurrentState; ids: Record<string, Map<string, string>>; projectSlug: string } | null> {
  const project = await strapi.documents('api::project.project').findOne({ documentId: projectId })
  if (!project) return null

  const [placements, achievements, timedEvents, offers, rewards] = await Promise.all([
    strapi.documents('api::placement.placement').findMany({ filters: { project: { documentId: projectId } } }),
    strapi.documents('api::achievement.achievement').findMany({ filters: { project: { documentId: projectId } } }),
    strapi.documents('api::timed-event.timed-event').findMany({ filters: { project: { documentId: projectId } } }),
    strapi.documents('api::offer.offer').findMany({
      filters: { project: { documentId: projectId } },
      populate: ['placement', 'timedEvent'],
    }),
    strapi.documents('api::reward.reward').findMany({ filters: { project: { documentId: projectId } } }),
  ])

  const state: CurrentState = {
    project: {
      pointRules: mapPointRules(project.pointRules),
      registeredEventTypes: mapRegisteredEventTypes(project.registeredEventTypes),
      allowedOrigins: mapAllowedOrigins(project.allowedOrigins),
    },
    placements: placements.map((r: any) => ({ slug: r.slug, name: r.name })),
    achievements: achievements.map((r: any) => ({
      slug: r.slug,
      name: r.name,
      description: r.description ?? null,
      artworkUrl: r.artworkUrl ?? null,
      eventType: r.eventType,
      targetCount: r.targetCount,
      pointsValue: r.pointsValue ?? 0,
    })),
    timedEvents: timedEvents.map((r: any) => ({
      slug: r.slug,
      name: r.name,
      description: r.description ?? null,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      endingSoonMinutes: r.endingSoonMinutes,
      multiplier: r.multiplier,
      recurrence: r.recurrence ?? 'none',
      recurrenceEndsAt: r.recurrenceEndsAt ?? null,
      enabled: r.enabled,
    })),
    offers: offers.map((r: any) => ({
      slug: r.slug,
      name: r.name,
      headline: r.headline,
      body: r.body ?? null,
      imageUrl: r.imageUrl ?? null,
      ctaText: r.ctaText ?? null,
      ctaUrl: r.ctaUrl ?? null,
      startsAt: r.startsAt ?? null,
      endsAt: r.endsAt ?? null,
      priority: r.priority ?? 0,
      placement: r.placement?.slug ?? '',
      timedEvent: r.timedEvent?.slug ?? null,
    })),
    rewards: rewards.map((r: any) => ({
      slug: r.slug,
      name: r.name,
      description: r.description ?? null,
      codeType: r.codeType,
      staticCode: r.staticCode ?? null,
      codePrefix: r.codePrefix ?? null,
      pointsPrice: r.pointsPrice ?? 0,
      startsAt: r.startsAt ?? null,
      endsAt: r.endsAt ?? null,
      perUserLimit: r.perUserLimit ?? 1,
      inventory: r.inventory ?? null,
      enabled: r.enabled,
    })),
  }

  const idMap = (rows: any[]) => new Map<string, string>(rows.map((r: any) => [r.slug, r.documentId]))
  const ids = {
    placements: idMap(placements),
    timedEvents: idMap(timedEvents),
    achievements: idMap(achievements),
    offers: idMap(offers),
    rewards: idMap(rewards),
  }

  return { state, ids, projectSlug: project.slug ?? 'project' }
}

export default {
  async achievements(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.query.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')
    const rows = await strapi.documents('api::achievement.achievement').findMany({
      filters: { project: { documentId: projectId } },
    })
    ctx.body = {
      achievements: rows.map((r: any) => ({
        id: r.documentId,
        slug: r.slug,
        name: r.name,
        description: r.description ?? null,
        artworkUrl: r.artworkUrl ?? null,
        eventType: r.eventType,
        targetCount: r.targetCount,
        pointsValue: r.pointsValue ?? 0,
      })),
    }
  },
  async offers(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.query.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')
    const rows = await strapi.documents('api::offer.offer').findMany({
      filters: { project: { documentId: projectId } },
      populate: ['placement', 'timedEvent'],
    })
    ctx.body = {
      offers: rows
        .filter((r: any) => r.placement?.slug)
        .map((r: any) => ({
          id: r.documentId,
          slug: r.slug,
          placementSlug: r.placement.slug,
          headline: r.headline,
          body: r.body ?? null,
          imageUrl: r.imageUrl ?? null,
          ctaText: r.ctaText ?? null,
          ctaUrl: r.ctaUrl ?? null,
          startsAt: r.startsAt ?? null,
          endsAt: r.endsAt ?? null,
          priority: r.priority ?? 0,
          timedEventId: r.timedEvent?.documentId ?? null,
        })),
    }
  },
  async timedEvents(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.query.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')
    const rows = await strapi.documents('api::timed-event.timed-event').findMany({
      filters: { project: { documentId: projectId } },
    })
    ctx.body = {
      events: rows.map((r: any) => ({
        id: r.documentId,
        slug: r.slug,
        name: r.name,
        description: r.description ?? null,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        endingSoonMinutes: r.endingSoonMinutes,
        multiplier: r.multiplier,
        enabled: r.enabled,
        recurrence: r.recurrence ?? 'none',
        recurrenceEndsAt: r.recurrenceEndsAt ?? null,
      })),
    }
  },
  async timedEventsAll(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    // ?endedWithinMinutes=<positive int>: excludes events with endsAt < now - N minutes —
    // UNLESS the event is recurring and its recurrence hasn't ended yet (recurrenceEndsAt is
    // null or still in the future). A months-old weekly event's occurrence-0 endsAt is ancient;
    // without this OR-branch the scheduler would never see it again. Absent or invalid
    // (non-integer, zero, negative) endedWithinMinutes -> unfiltered, for backward compatibility.
    const rawParam = String(ctx.query.endedWithinMinutes ?? '')
    const filters: Record<string, unknown> = {}
    if (/^[1-9][0-9]*$/.test(rawParam)) {
      const now = Date.now()
      const cutoff = new Date(now - Number(rawParam) * 60_000).toISOString()
      // recurrenceEndsAt bounds occurrence STARTS, not ends: the final occurrence may end up to
      // one interval after recurrenceEndsAt — at most 28 days, the monthly duration cap the
      // timed-event lifecycle validation enforces (2_419_200_000 ms). Pad the recurring branch's
      // cutoff by that max duration, or a bounded recurrence whose recurrenceEndsAt lands just
      // after the final start scrolls out of the feed before its final ending_soon/ended are
      // claimable. Over-fetching a finished event is harmless — its claims are conflict no-ops.
      const MAX_OCCURRENCE_DURATION_MS = 2_419_200_000 // 28 days, the monthly duration cap
      const recurringCutoff = new Date(now - Number(rawParam) * 60_000 - MAX_OCCURRENCE_DURATION_MS).toISOString()
      filters.$or = [
        { endsAt: { $gte: cutoff } },
        {
          recurrence: { $ne: 'none' },
          $or: [{ recurrenceEndsAt: { $null: true } }, { recurrenceEndsAt: { $gte: recurringCutoff } }],
        },
      ]
    }
    const rows = await strapi.documents('api::timed-event.timed-event').findMany({
      filters,
      populate: ['project'],
    })
    ctx.body = {
      events: rows
        .filter((r: any) => r.project?.documentId)
        .map((r: any) => ({
          id: r.documentId,
          slug: r.slug,
          name: r.name,
          description: r.description ?? null,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          endingSoonMinutes: r.endingSoonMinutes,
          multiplier: r.multiplier,
          enabled: r.enabled,
          recurrence: r.recurrence ?? 'none',
          recurrenceEndsAt: r.recurrenceEndsAt ?? null,
          projectId: r.project.documentId,
        })),
    }
  },
  async rewards(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.query.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')
    const rows = await strapi.documents('api::reward.reward').findMany({
      filters: { project: { documentId: projectId } },
    })
    ctx.body = {
      rewards: rows.map((r: any) => ({
        id: r.documentId,
        slug: r.slug,
        name: r.name,
        description: r.description ?? null,
        codeType: r.codeType,
        staticCode: r.staticCode ?? null,
        codePrefix: r.codePrefix ?? null,
        pointsPrice: r.pointsPrice ?? 0,
        startsAt: r.startsAt ?? null,
        endsAt: r.endsAt ?? null,
        perUserLimit: r.perUserLimit ?? 1,
        inventory: r.inventory ?? null,
        enabled: r.enabled,
      })),
    }
  },
  async webhookEndpoints(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.query.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')
    const rows = await strapi.documents('api::webhook-endpoint.webhook-endpoint').findMany({
      filters: { project: { documentId: projectId } },
    })
    ctx.body = {
      endpoints: rows.map((r: any) => ({
        id: r.documentId,
        url: r.url,
        secret: r.secret,
        enabled: r.enabled,
      })),
    }
  },
  async eventTypes(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.params.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')
    const project = await strapi.documents('api::project.project').findOne({ documentId: projectId })
    if (!project) return ctx.notFound()
    const raw = project.registeredEventTypes
    let eventTypes: string[]
    if (Array.isArray(raw)) {
      eventTypes = raw.filter((t: unknown): t is string => typeof t === 'string' && EVENT_TYPE_PATTERN.test(t))
    } else if (raw == null) {
      eventTypes = []
    } else {
      strapi.log.warn(`[promocean] project ${project.documentId} registeredEventTypes is not an array; ignoring`)
      eventTypes = []
    }
    ctx.body = { eventTypes }
  },
  async pointRules(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.params.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')
    const project = await strapi.documents('api::project.project').findOne({ documentId: projectId })
    if (!project) return ctx.notFound()
    const raw = project.pointRules
    let pointRules: Record<string, number>
    if (raw == null) {
      pointRules = {}
    } else if (typeof raw === 'object' && !Array.isArray(raw)) {
      pointRules = {}
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!EVENT_TYPE_PATTERN.test(key) || typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          strapi.log.warn(`[promocean] project ${project.documentId} pointRules entry "${key}" is invalid; dropping`)
          continue
        }
        pointRules[key] = value
      }
    } else {
      strapi.log.warn(`[promocean] project ${project.documentId} pointRules is not an object; ignoring`)
      pointRules = {}
    }
    ctx.body = { pointRules }
  },
  async exportProject(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.params.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')
    const project = await strapi.documents('api::project.project').findOne({ documentId: projectId })
    if (!project) return ctx.notFound()

    const [placementsRaw, achievementsRaw, timedEventsRaw, offersRaw, rewardsRaw] = await Promise.all([
      strapi.documents('api::placement.placement').findMany({ filters: { project: { documentId: projectId } } }),
      strapi.documents('api::achievement.achievement').findMany({ filters: { project: { documentId: projectId } } }),
      strapi.documents('api::timed-event.timed-event').findMany({ filters: { project: { documentId: projectId } } }),
      strapi.documents('api::offer.offer').findMany({
        filters: { project: { documentId: projectId } },
        populate: ['placement', 'timedEvent'],
      }),
      strapi.documents('api::reward.reward').findMany({ filters: { project: { documentId: projectId } } }),
    ])
    // Sorted by slug (see sortBySlug) so the export's array order is deterministic and
    // content-derived, not an artifact of DB creation/id order — required for the file to be
    // diff-stable across re-imports, reseeds, and different target projects.
    const placements = sortBySlug(placementsRaw as Array<{ slug: string; [k: string]: any }>)
    const achievements = sortBySlug(achievementsRaw as Array<{ slug: string; [k: string]: any }>)
    const timedEvents = sortBySlug(timedEventsRaw as Array<{ slug: string; [k: string]: any }>)
    const offers = sortBySlug(offersRaw as Array<{ slug: string; [k: string]: any }>)
    const rewards = sortBySlug(rewardsRaw as Array<{ slug: string; [k: string]: any }>)

    // Every content type covered by the export must carry a non-empty slug —
    // the file format cross-references content by slug (offers -> placement/
    // timedEvent), so a row missing one would either silently break those
    // refs or produce a file that fails configFileSchema. Collect EVERY
    // offender rather than failing fast on the first, so an operator can fix
    // them all in one pass. An offer whose populated `placement` relation
    // itself has no resolvable slug is listed the same way — from the
    // export's perspective that offer can't be represented either.
    const findings: string[] = []
    function offenderLine(type: string, row: any): string {
      return `${type} "${row.name}" (documentId ${row.documentId})`
    }
    function hasSlug(row: any): boolean {
      return typeof row.slug === 'string' && row.slug.length > 0
    }
    for (const row of placements) if (!hasSlug(row)) findings.push(offenderLine('placement', row))
    for (const row of achievements) if (!hasSlug(row)) findings.push(offenderLine('achievement', row))
    for (const row of timedEvents) if (!hasSlug(row)) findings.push(offenderLine('timed-event', row))
    for (const row of offers) if (!hasSlug(row) || !hasSlug(row.placement ?? {})) findings.push(offenderLine('offer', row))
    for (const row of rewards) if (!hasSlug(row)) findings.push(offenderLine('reward', row))

    if (findings.length > 0) {
      ctx.status = 500
      ctx.body = { error: 'unexported definitions missing slugs', findings }
      return
    }

    const rawPointRules = project.pointRules
    let pointRules: Record<string, number>
    if (rawPointRules == null) {
      pointRules = {}
    } else if (typeof rawPointRules === 'object' && !Array.isArray(rawPointRules)) {
      pointRules = {}
      for (const [key, value] of Object.entries(rawPointRules as Record<string, unknown>)) {
        if (!EVENT_TYPE_PATTERN.test(key) || typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          strapi.log.warn(`[promocean] project ${project.documentId} pointRules entry "${key}" is invalid; dropping`)
          continue
        }
        pointRules[key] = value
      }
    } else {
      strapi.log.warn(`[promocean] project ${project.documentId} pointRules is not an object; ignoring`)
      pointRules = {}
    }

    const rawEventTypes = project.registeredEventTypes
    let registeredEventTypes: string[]
    if (Array.isArray(rawEventTypes)) {
      registeredEventTypes = rawEventTypes.filter((t: unknown): t is string => typeof t === 'string' && EVENT_TYPE_PATTERN.test(t))
    } else if (rawEventTypes == null) {
      registeredEventTypes = []
    } else {
      strapi.log.warn(`[promocean] project ${project.documentId} registeredEventTypes is not an array; ignoring`)
      registeredEventTypes = []
    }

    const rawOrigins = project.allowedOrigins
    let allowedOrigins: string[] | null
    if (Array.isArray(rawOrigins) && rawOrigins.every((o: unknown) => typeof o === 'string')) {
      allowedOrigins = rawOrigins
    } else if (rawOrigins == null) {
      allowedOrigins = null
    } else {
      strapi.log.warn(`[promocean] project ${project.documentId} allowedOrigins is not a string array; ignoring`)
      allowedOrigins = null
    }

    ctx.body = {
      formatVersion: 1,
      project: { pointRules, registeredEventTypes, allowedOrigins },
      placements: placements.map((r: any) => ({
        slug: r.slug,
        name: r.name,
      })),
      achievements: achievements.map((r: any) => ({
        slug: r.slug,
        name: r.name,
        description: r.description ?? null,
        artworkUrl: r.artworkUrl ?? null,
        eventType: r.eventType,
        targetCount: r.targetCount,
        pointsValue: r.pointsValue ?? 0,
      })),
      timedEvents: timedEvents.map((r: any) => ({
        slug: r.slug,
        name: r.name,
        description: r.description ?? null,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        endingSoonMinutes: r.endingSoonMinutes,
        multiplier: r.multiplier,
        recurrence: r.recurrence ?? 'none',
        recurrenceEndsAt: r.recurrenceEndsAt ?? null,
        enabled: r.enabled,
      })),
      offers: offers.map((r: any) => ({
        slug: r.slug,
        name: r.name,
        headline: r.headline,
        body: r.body ?? null,
        imageUrl: r.imageUrl ?? null,
        ctaText: r.ctaText ?? null,
        ctaUrl: r.ctaUrl ?? null,
        startsAt: r.startsAt ?? null,
        endsAt: r.endsAt ?? null,
        priority: r.priority ?? 0,
        placement: r.placement.slug,
        timedEvent: r.timedEvent?.slug ?? null,
      })),
      rewards: rewards.map((r: any) => ({
        slug: r.slug,
        name: r.name,
        description: r.description ?? null,
        codeType: r.codeType,
        staticCode: r.staticCode ?? null,
        codePrefix: r.codePrefix ?? null,
        pointsPrice: r.pointsPrice ?? 0,
        startsAt: r.startsAt ?? null,
        endsAt: r.endsAt ?? null,
        perUserLimit: r.perUserLimit ?? 1,
        inventory: r.inventory ?? null,
        enabled: r.enabled,
      })),
    }
  },
  async verifyKey(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const { keyHash } = ctx.request.body ?? {}
    const rows = await strapi.documents('api::api-key.api-key').findMany({
      filters: { keyHash: { $eq: String(keyHash ?? '') } },
      populate: ['project'],
      limit: 1,
    })
    const key = rows[0]
    if (!key || !key.project) return ctx.notFound()
    const rawOrigins = key.project.allowedOrigins
    let allowedOrigins: string[] | null
    if (Array.isArray(rawOrigins) && rawOrigins.every((o: unknown) => typeof o === 'string')) {
      allowedOrigins = rawOrigins
    } else if (rawOrigins == null) {
      allowedOrigins = null
    } else {
      strapi.log.warn(`[promocean] project ${key.project.documentId} allowedOrigins is not a string array; ignoring`)
      allowedOrigins = null
    }
    ctx.body = {
      projectId: key.project.documentId,
      environment: key.environment,
      keyType: key.keyType,
      allowedOrigins,
    }
  },
  async importProject(ctx: any) {
    // 1. Guard -> 401.
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    const projectId = String(ctx.params.projectId ?? '')
    if (!projectId) return ctx.badRequest('projectId is required')

    // 2. Parse body -> 400 with zod issues.
    const parsed = importRequestSchema.safeParse(ctx.request.body)
    if (!parsed.success) {
      ctx.status = 400
      ctx.body = { error: 'invalid config file', issues: parsed.error.issues }
      return
    }
    const { file, prune, dryRun } = parsed.data

    const loaded = await loadCurrentState(projectId)
    if (!loaded) return ctx.notFound()
    const { state, ids, projectSlug } = loaded

    // 3. Cross-ref resolution -> 400 BEFORE any write.
    const unknownRefs = findUnknownRefs(file, state)
    if (unknownRefs.length > 0) {
      ctx.status = 400
      ctx.body = { error: 'unknown reference', details: unknownRefs }
      return
    }

    // 4. Plan.
    const plan = computePlan(file, state, projectSlug, prune)

    // 5. dryRun short-circuit -> zero writes.
    if (dryRun) {
      ctx.body = { applied: false, plan } satisfies ImportResponse
      return
    }

    // 6. Apply through strapi.documents() (lifecycles fire) in dependency
    //    order; deletes last, reverse order. On a mid-run lifecycle rejection,
    //    recompute the actually-applied plan from the re-queried DB and 422.
    let stage = ''
    try {
      // project settings (update-or-unchanged)
      if (plan.project.updates.length > 0) {
        stage = `project/${projectSlug}`
        await strapi.documents('api::project.project').update({
          documentId: projectId,
          data: {
            pointRules: file.project.pointRules,
            registeredEventTypes: file.project.registeredEventTypes,
            allowedOrigins: file.project.allowedOrigins,
          },
        })
      }

      // placements — track created ids so offers can resolve refs written this run
      const placementIds = new Map(ids.placements)
      for (const p of file.placements) {
        if (plan.placements.creates.includes(p.slug)) {
          stage = `placements/${p.slug}`
          const created = await strapi.documents('api::placement.placement').create({
            data: { slug: p.slug, name: p.name, project: projectId },
          })
          placementIds.set(p.slug, created.documentId)
        } else if (plan.placements.updates.includes(p.slug)) {
          stage = `placements/${p.slug}`
          await strapi.documents('api::placement.placement').update({
            documentId: placementIds.get(p.slug)!,
            data: { name: p.name },
          })
        }
      }

      // timedEvents
      const timedEventIds = new Map(ids.timedEvents)
      for (const t of file.timedEvents) {
        const data: any = {
          slug: t.slug,
          name: t.name,
          description: t.description,
          startsAt: t.startsAt,
          endsAt: t.endsAt,
          endingSoonMinutes: t.endingSoonMinutes,
          multiplier: t.multiplier,
          recurrence: t.recurrence,
          recurrenceEndsAt: t.recurrenceEndsAt,
          enabled: t.enabled,
        }
        if (plan.timedEvents.creates.includes(t.slug)) {
          stage = `timedEvents/${t.slug}`
          const created = await strapi.documents('api::timed-event.timed-event').create({
            data: { ...data, project: projectId },
          })
          timedEventIds.set(t.slug, created.documentId)
        } else if (plan.timedEvents.updates.includes(t.slug)) {
          stage = `timedEvents/${t.slug}`
          await strapi.documents('api::timed-event.timed-event').update({
            documentId: timedEventIds.get(t.slug)!,
            data,
          })
        }
      }

      // achievements
      for (const a of file.achievements) {
        const data: any = {
          slug: a.slug,
          name: a.name,
          description: a.description,
          artworkUrl: a.artworkUrl,
          eventType: a.eventType,
          targetCount: a.targetCount,
          pointsValue: a.pointsValue,
        }
        if (plan.achievements.creates.includes(a.slug)) {
          stage = `achievements/${a.slug}`
          await strapi.documents('api::achievement.achievement').create({ data: { ...data, project: projectId } })
        } else if (plan.achievements.updates.includes(a.slug)) {
          stage = `achievements/${a.slug}`
          await strapi.documents('api::achievement.achievement').update({
            documentId: ids.achievements.get(a.slug)!,
            data,
          })
        }
      }

      // rewards
      for (const r of file.rewards) {
        const data: any = {
          slug: r.slug,
          name: r.name,
          description: r.description,
          codeType: r.codeType,
          staticCode: r.staticCode,
          codePrefix: r.codePrefix,
          pointsPrice: r.pointsPrice,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          perUserLimit: r.perUserLimit,
          inventory: r.inventory,
          enabled: r.enabled,
        }
        if (plan.rewards.creates.includes(r.slug)) {
          stage = `rewards/${r.slug}`
          await strapi.documents('api::reward.reward').create({ data: { ...data, project: projectId } })
        } else if (plan.rewards.updates.includes(r.slug)) {
          stage = `rewards/${r.slug}`
          await strapi.documents('api::reward.reward').update({ documentId: ids.rewards.get(r.slug)!, data })
        }
      }

      // offers — resolve placement/timedEvent slugs to documentIds at write time
      for (const o of file.offers) {
        const data: any = {
          slug: o.slug,
          name: o.name,
          headline: o.headline,
          body: o.body,
          imageUrl: o.imageUrl,
          ctaText: o.ctaText,
          ctaUrl: o.ctaUrl,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          priority: o.priority,
          placement: placementIds.get(o.placement) ?? null,
          timedEvent: o.timedEvent != null ? timedEventIds.get(o.timedEvent) ?? null : null,
        }
        if (plan.offers.creates.includes(o.slug)) {
          stage = `offers/${o.slug}`
          await strapi.documents('api::offer.offer').create({ data: { ...data, project: projectId } })
        } else if (plan.offers.updates.includes(o.slug)) {
          stage = `offers/${o.slug}`
          await strapi.documents('api::offer.offer').update({ documentId: ids.offers.get(o.slug)!, data })
        }
      }

      // deletes LAST, reverse dependency order (offers -> ... -> placements)
      for (const slug of plan.offers.deletes) {
        stage = `offers/${slug}`
        await strapi.documents('api::offer.offer').delete({ documentId: ids.offers.get(slug)! })
      }
      for (const slug of plan.rewards.deletes) {
        stage = `rewards/${slug}`
        await strapi.documents('api::reward.reward').delete({ documentId: ids.rewards.get(slug)! })
      }
      for (const slug of plan.achievements.deletes) {
        stage = `achievements/${slug}`
        await strapi.documents('api::achievement.achievement').delete({ documentId: ids.achievements.get(slug)! })
      }
      for (const slug of plan.timedEvents.deletes) {
        stage = `timedEvents/${slug}`
        await strapi.documents('api::timed-event.timed-event').delete({ documentId: ids.timedEvents.get(slug)! })
      }
      for (const slug of plan.placements.deletes) {
        stage = `placements/${slug}`
        await strapi.documents('api::placement.placement').delete({ documentId: ids.placements.get(slug)! })
      }
    } catch (e: any) {
      // Recompute the ACTUALLY-applied plan by re-querying and re-diffing —
      // never report the intended plan. Fully-applied types collapse to
      // unchanged; the failing/not-yet-reached ones remain in their buckets.
      const after = await loadCurrentState(projectId)
      const recomputed = after ? computePlan(file, after.state, after.projectSlug, prune) : plan
      ctx.status = 422
      ctx.body = {
        applied: true,
        plan: recomputed,
        error: { stage, message: e?.message ?? String(e) },
      } satisfies ImportResponse
      return
    }

    // 7. Full success.
    ctx.body = { applied: true, plan } satisfies ImportResponse
  },
}
