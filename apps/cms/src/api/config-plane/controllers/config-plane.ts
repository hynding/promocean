import { timingSafeEqual } from 'node:crypto'

// mirrors packages/contracts/src/events.ts EVENT_TYPE_PATTERN — cms doesn't import contracts
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/

function configSecretOk(ctx: any): boolean {
  const expected = process.env.CONFIG_PLANE_SECRET
  if (!expected) return false // fail closed when unset
  const provided = Buffer.from(String(ctx.request.header['x-config-secret'] ?? ''))
  const expectedBuf = Buffer.from(expected)
  return provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf)
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
}
