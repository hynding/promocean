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
        name: r.name,
        description: r.description ?? null,
        artworkUrl: r.artworkUrl ?? null,
        eventType: r.eventType,
        targetCount: r.targetCount,
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
        name: r.name,
        description: r.description ?? null,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        endingSoonMinutes: r.endingSoonMinutes,
        multiplier: r.multiplier,
        enabled: r.enabled,
      })),
    }
  },
  async timedEventsAll(ctx: any) {
    if (!configSecretOk(ctx)) return ctx.unauthorized()
    // ?endedWithinMinutes=<positive int>: excludes events with endsAt < now - N minutes.
    // Absent or invalid (non-integer, zero, negative) -> unfiltered, for backward compatibility.
    const rawParam = String(ctx.query.endedWithinMinutes ?? '')
    const filters: Record<string, unknown> = {}
    if (/^[1-9][0-9]*$/.test(rawParam)) {
      const cutoff = new Date(Date.now() - Number(rawParam) * 60_000)
      filters.endsAt = { $gte: cutoff.toISOString() }
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
          name: r.name,
          description: r.description ?? null,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          endingSoonMinutes: r.endingSoonMinutes,
          multiplier: r.multiplier,
          enabled: r.enabled,
          projectId: r.project.documentId,
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
