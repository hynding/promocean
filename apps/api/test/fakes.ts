import type {
  AchievementDefinition, ApiKeyStore, AuthContext, ConfigStore, ErasureStore, IngestionStore, OfferDefinition,
  OfferMetricsStore, ProgressStore, Scope, StatsStore, TimedEventDefinition,
} from '@promocean/core'

const sk = (s: Scope, rest: string) => `${s.projectId}:${s.environment}:${rest}`

export function makeFakes(
  definitions: AchievementDefinition[],
  auth: AuthContext | null,
  offers: OfferDefinition[] = [],
  timedEvents: TimedEventDefinition[] = [],
  registeredEventTypes: string[] = [],
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
    getRegisteredEventTypes: async () => registeredEventTypes,
  }
  const apiKeyStore: ApiKeyStore = { verifyKey: async (raw) => (raw === 'pk_test_valid_key_1' ? auth : null) }
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
  // Mirrors PgIngestionStore's transactional semantics in-memory: dedup by idempotencyKey,
  // increments clamped at target, unlocks recorded exactly once. Shares the `progress` /
  // `unlockDates` maps with progressStore above so GET /users/:userId/achievements (still
  // reading through progressStore) reflects state written via ingestEvent, same as the real
  // stores share the same underlying tables.
  const ingestionStore: IngestionStore = {
    ingestEvent: async (scope, event, increments, month) => {
      const idemKey = sk(scope, event.idempotencyKey)
      if (seenIdem.has(idemKey)) return { deduped: true }
      seenIdem.add(idemKey)

      const resultProgress: { achievementId: string; current: number; target: number }[] = []
      for (const inc of increments) {
        const key = sk(scope, `${event.userId}:${inc.achievementId}`)
        const next = Math.min((progress.get(key) ?? 0) + inc.delta, inc.target)
        progress.set(key, next)
        resultProgress.push({ achievementId: inc.achievementId, current: next, target: inc.target })
      }

      const unlockedAt = new Date()
      const newUnlocks: { achievementId: string; unlockedAt: Date }[] = []
      for (const p of resultProgress) {
        if (p.current < p.target) continue
        const key = sk(scope, `${event.userId}:${p.achievementId}`)
        if (unlockDates.has(key)) continue
        unlockDates.set(key, unlockedAt)
        newUnlocks.push({ achievementId: p.achievementId, unlockedAt })
      }

      usage.push(`${event.userId}:${month}`)
      return { deduped: false, progress: resultProgress, newUnlocks }
    },
  }
  const metrics: { impressions: Array<{ offerId: string; userId: string | null }>; clicks: Array<{ offerId: string; userId: string | null }> } = { impressions: [], clicks: [] }
  const seenImpressionKeys = new Set<string>()
  const offerMetricsStore: OfferMetricsStore = {
    recordImpression: async (s, offerId, userId, _at, idempotencyKey) => {
      const key = sk(s, idempotencyKey)
      if (seenImpressionKeys.has(key)) return
      seenImpressionKeys.add(key)
      metrics.impressions.push({ offerId, userId })
    },
    recordClick: async (_s, offerId, userId) => { metrics.clicks.push({ offerId, userId }) },
  }
  const erasedUsers: Array<{ scope: Scope; userId: string }> = []
  const erasureCounts = { events: 1, progress: 2, unlocks: 3, offerEvents: 4 }
  const erasureStore: ErasureStore = {
    eraseUser: async (scope, userId) => {
      erasedUsers.push({ scope, userId })
      return erasureCounts
    },
  }
  type StatsResult = Awaited<ReturnType<StatsStore['getStats']>>
  const statsCalls: Array<{
    scope: Scope
    range: { from: Date | null; to: Date | null }
    timedEventWindows: { eventId: string; startsAt: Date; endsAt: Date }[]
  }> = []
  let statsResult: StatsResult = {
    totals: { events: 0, unlocks: 0, impressions: 0, clicks: 0, timedEventParticipants: 0 },
    achievements: [],
    offers: [],
    timedEvents: [],
  }
  const statsStore: StatsStore = {
    getStats: async (scope, range, timedEventWindows) => {
      statsCalls.push({ scope, range, timedEventWindows })
      return statsResult
    },
  }
  const setStatsResult = (r: StatsResult) => { statsResult = r }
  return {
    configStore, apiKeyStore, progressStore, ingestionStore, usage, offerMetricsStore, metrics, erasureStore,
    erasedUsers, erasureCounts, statsStore, statsCalls, setStatsResult,
  }
}
