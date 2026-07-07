import { randomBytes } from 'node:crypto'

export default {
  beforeCreate(event: any) {
    const data = event.params.data
    if (data.secret) return // seeded with a precomputed secret
    const raw = `whsec_${randomBytes(16).toString('hex')}`
    data.secret = raw
    if (process.env.LOG_PLAINTEXT_KEYS === 'true') {
      strapi.log.info(`[promocean] Webhook endpoint secret created — shown ONCE: ${raw}`)
    } else {
      strapi.log.info(`[promocean] Webhook endpoint secret created: prefix=${raw.slice(0, 12)} (set LOG_PLAINTEXT_KEYS=true in dev to reveal at creation)`)
    }
  },
}
