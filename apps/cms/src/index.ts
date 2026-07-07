import { createHash } from 'node:crypto'

async function seedAdminUser(strapi: any) {
  const { ADMIN_FIRST_NAME, ADMIN_LAST_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env
  if (!ADMIN_FIRST_NAME || !ADMIN_LAST_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) return
  const userService = strapi.service('admin::user')
  const hasAdmin = await userService.exists()
  if (hasAdmin) return
  const superAdminRole = await strapi.service('admin::role').getSuperAdmin()
  if (!superAdminRole) {
    strapi.log.warn('[promocean] no super admin role found; skipping admin seed')
    return
  }
  // createFirstAdmin is the same service method Strapi's own
  // /admin/register-admin endpoint uses: it hashes the password, sets
  // isActive/roles, and transactionally guards against a duplicate admin.
  await userService.createFirstAdmin({
    firstname: ADMIN_FIRST_NAME,
    lastname: ADMIN_LAST_NAME,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  })
  strapi.log.info(`[promocean] Seeded admin user ${ADMIN_EMAIL}`)
}

export default {
  register() {},
  async bootstrap({ strapi }: { strapi: any }) {
    await seedAdminUser(strapi)

    if (process.env.SEED_DEMO !== 'true') return
    const existing = await strapi.documents('api::project.project').findMany({ limit: 1 })
    if (existing.length > 0) return
    const project = await strapi.documents('api::project.project').create({
      data: { name: 'Demo', slug: 'demo' },
    })
    const rawKey = 'pk_test_demo_1234567890abcdef'
    await strapi.documents('api::api-key.api-key').create({
      data: {
        keyHash: createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.slice(0, 12),
        keyType: 'publishable',
        environment: 'test',
        project: project.documentId,
      },
    })
    const achievements = [
      { name: 'First Lesson', description: 'Complete your first lesson.', eventType: 'lesson_completed', targetCount: 1 },
      { name: 'Getting Started', description: 'Complete ten lessons.', eventType: 'lesson_completed', targetCount: 10 },
      { name: 'Profiled', description: 'Complete your profile.', eventType: 'profile_completed', targetCount: 1 },
    ]
    for (const a of achievements) {
      await strapi.documents('api::achievement.achievement').create({
        data: { ...a, artworkUrl: null, project: project.documentId },
      })
    }
    if (process.env.LOG_PLAINTEXT_KEYS === 'true') {
      strapi.log.info(`[promocean] Seeded demo project ${project.documentId} with key ${rawKey}`)
    } else {
      strapi.log.info(`[promocean] Seeded demo project ${project.documentId} with key prefix=pk_test_demo_ (set LOG_PLAINTEXT_KEYS=true in dev to reveal)`)
    }
  },
}
