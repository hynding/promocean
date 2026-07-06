export default {
  async achievements(ctx: any) {
    if (ctx.request.header['x-config-secret'] !== process.env.CONFIG_PLANE_SECRET) return ctx.unauthorized()
    const projectId = String(ctx.query.projectId ?? '')
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
  async verifyKey(ctx: any) {
    if (ctx.request.header['x-config-secret'] !== process.env.CONFIG_PLANE_SECRET) return ctx.unauthorized()
    const { keyHash } = ctx.request.body ?? {}
    const rows = await strapi.documents('api::api-key.api-key').findMany({
      filters: { keyHash: { $eq: String(keyHash ?? '') } },
      populate: ['project'],
      limit: 1,
    })
    const key = rows[0]
    if (!key || !key.project) return ctx.notFound()
    ctx.body = { projectId: key.project.documentId, environment: key.environment, keyType: key.keyType }
  },
}
