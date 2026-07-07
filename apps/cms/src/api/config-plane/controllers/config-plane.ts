import { timingSafeEqual } from 'node:crypto'

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
    ctx.body = { projectId: key.project.documentId, environment: key.environment, keyType: key.keyType }
  },
}
