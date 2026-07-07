import type {
  AchievementDefinition, ApiKeyStore, AuthContext, ConfigStore, EventStore, OfferDefinition, OfferMetricsStore,
  ProgressStore, Scope, TimedEventDefinition, UsageStore,
} from '@promocean/core'

const sk = (s: Scope, rest: string) => `${s.projectId}:${s.environment}:${rest}`

export function makeFakes(
  definitions: AchievementDefinition[],
  auth: AuthContext | null,
  offers: OfferDefinition[] = [],
  timedEvents: TimedEventDefinition[] = [],
) {
  const seenIdem = new Set<string>()
  const progress = new Map<string, number>()
  const unlockDates = new Map<string, Date>()
  const usage: string[] = []
  const configStore: ConfigStore = {
    getAchievements: async () => definitions,
    getOffers: async () => offers,
    getTimedEvents: async () => timedEvents,
    getAllTimedEvents: async () => [],
    getWebhookEndpoints: async () => [],
  }
  const apiKeyStore: ApiKeyStore = { verifyKey: async (raw) => (raw === 'pk_test_valid_key_1' ? auth : null) }
  const eventStore: EventStore = {
    insertEvent: async (s, e) => {
      const k = sk(s, e.idempotencyKey)
      if (seenIdem.has(k)) return { deduped: true }
      seenIdem.add(k)
      return { deduped: false }
    },
  }
  const progressStore: ProgressStore = {
    getCounts: async (s, u, ids) =>
      new Map(ids.flatMap((id) => (progress.has(sk(s, `${u}:${id}`)) ? [[id, progress.get(sk(s, `${u}:${id}`))!] as const] : []))),
    setProgress: async (s, u, id, c) => { progress.set(sk(s, `${u}:${id}`), c) },
    recordUnlock: async (s, u, id, at) => {
      const k = sk(s, `${u}:${id}`)
      if (unlockDates.has(k)) return false
      unlockDates.set(k, at)
      return true
    },
    getUserAchievements: async (s, u) =>
      [...progress.entries()]
        .filter(([k]) => k.startsWith(sk(s, `${u}:`)))
        .map(([k, current]) => {
          const achievementId = k.split(':').at(-1)!
          return { achievementId, current, unlockedAt: unlockDates.get(sk(s, `${u}:${achievementId}`)) ?? null }
        }),
  }
  const usageStore: UsageStore = { recordUsage: async (_s, u, m) => { usage.push(`${u}:${m}`) } }
  const metrics: { impressions: Array<{ offerId: string; userId: string | null }>; clicks: Array<{ offerId: string; userId: string | null }> } = { impressions: [], clicks: [] }
  const offerMetricsStore: OfferMetricsStore = {
    recordImpression: async (_s, offerId, userId) => { metrics.impressions.push({ offerId, userId }) },
    recordClick: async (_s, offerId, userId) => { metrics.clicks.push({ offerId, userId }) },
  }
  return { configStore, apiKeyStore, eventStore, progressStore, usageStore, usage, offerMetricsStore, metrics }
}
