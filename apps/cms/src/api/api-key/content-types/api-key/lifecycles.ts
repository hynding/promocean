import { createHash, randomBytes } from 'node:crypto'

export default {
  beforeCreate(event: any) {
    const data = event.params.data
    if (data.keyHash) return // seeded with a precomputed hash
    const prefix = data.keyType === 'secret' ? 'sk' : 'pk'
    const raw = `${prefix}_${data.environment}_${randomBytes(16).toString('hex')}`
    data.keyHash = createHash('sha256').update(raw).digest('hex')
    data.keyPrefix = raw.slice(0, 12)
    strapi.log.info(`[promocean] API key created — shown ONCE: ${raw}`)
  },
}
