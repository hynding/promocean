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
      data: {
        name: 'Demo',
        slug: 'demo',
        registeredEventTypes: ['lesson_completed', 'profile_completed'],
        pointRules: { lesson_completed: 10, profile_completed: 25 },
      },
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
    // Secret key: same mechanism as the publishable key above, but keyType
    // 'secret' — grants access to secret-only endpoints (GET /v1/stats,
    // DELETE /v1/users/:userId). Server-side only: the demo's /stats page
    // reads this via PROMOCEAN_SECRET_KEY (never NEXT_PUBLIC_*).
    const rawSecretKey = 'sk_test_demo_1234567890abcdef'
    await strapi.documents('api::api-key.api-key').create({
      data: {
        keyHash: createHash('sha256').update(rawSecretKey).digest('hex'),
        keyPrefix: rawSecretKey.slice(0, 12),
        keyType: 'secret',
        environment: 'test',
        project: project.documentId,
      },
    })
    const achievements = [
      { name: 'First Lesson', description: 'Complete your first lesson.', eventType: 'lesson_completed', targetCount: 1, pointsValue: 50 },
      { name: 'Getting Started', description: 'Complete ten lessons.', eventType: 'lesson_completed', targetCount: 10, pointsValue: 100 },
      { name: 'Profiled', description: 'Complete your profile.', eventType: 'profile_completed', targetCount: 1, pointsValue: 75 },
    ]
    for (const a of achievements) {
      await strapi.documents('api::achievement.achievement').create({
        data: { ...a, artworkUrl: null, project: project.documentId },
      })
    }
    const placement = await strapi.documents('api::placement.placement').create({
      data: { name: 'Homepage Banner', slug: 'homepage-banner', project: project.documentId },
    })
    await strapi.documents('api::offer.offer').create({
      data: {
        name: 'Welcome offer',
        headline: 'Welcome to Promocean',
        body: 'Track achievements and run promos from one API.',
        ctaText: 'Learn more',
        ctaUrl: 'https://github.com/hynding/promocean',
        priority: 0,
        placement: placement.documentId,
        project: project.documentId,
      },
    })
    await strapi.documents('api::timed-event.timed-event').create({
      data: {
        name: 'Double Progress Weekend',
        description: 'All achievement progress counts double.',
        startsAt: new Date(Date.now() - 3600_000),
        endsAt: new Date(Date.now() + 7 * 24 * 3600_000),
        endingSoonMinutes: 1440,
        multiplier: 2,
        enabled: true,
        project: project.documentId,
      },
    })
    const happyHourStartsAt = new Date(Date.now())
    happyHourStartsAt.setUTCHours(17, 0, 0, 0)
    await strapi.documents('api::timed-event.timed-event').create({
      data: {
        name: 'Weekly Happy Hour',
        description: 'A recurring window of double points every week.',
        startsAt: happyHourStartsAt,
        endsAt: new Date(happyHourStartsAt.getTime() + 2 * 3600_000),
        endingSoonMinutes: 30,
        multiplier: 2,
        enabled: true,
        recurrence: 'weekly',
        recurrenceEndsAt: null,
        project: project.documentId,
      },
    })
    const rewards = [
      {
        slug: 'welcome_coupon',
        name: 'Welcome Coupon',
        description: 'A one-time welcome discount, free of charge.',
        codeType: 'static' as const,
        staticCode: 'WELCOME10',
        codePrefix: null,
        pointsPrice: 0,
        startsAt: null,
        endsAt: null,
        perUserLimit: 1,
        inventory: null,
        enabled: true,
      },
      {
        slug: 'demo_discount',
        name: 'Demo Discount',
        description: 'A generated-code discount reward for the demo project.',
        codeType: 'generated' as const,
        staticCode: null,
        codePrefix: 'DEMO-',
        pointsPrice: 100,
        startsAt: null,
        endsAt: null,
        perUserLimit: 5,
        inventory: 50,
        enabled: true,
      },
    ]
    for (const r of rewards) {
      await strapi.documents('api::reward.reward').create({
        data: { ...r, project: project.documentId },
      })
    }
    if (process.env.LOG_PLAINTEXT_KEYS === 'true') {
      strapi.log.info(`[promocean] Seeded demo project ${project.documentId} with keys pk=${rawKey} sk=${rawSecretKey}`)
    } else {
      strapi.log.info(`[promocean] Seeded demo project ${project.documentId} with key prefixes pk=pk_test_demo_ sk=sk_test_demo_ (set LOG_PLAINTEXT_KEYS=true in dev to reveal)`)
    }
  },
}
