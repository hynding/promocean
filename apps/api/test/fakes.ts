import type {
  AchievementDefinition, ApiKeyStore, AuthContext, ConfigStore, EngagementStore, EngagementWrite, ErasureStore,
  IngestionStore, OfferDefinition, OfferMetricsStore, PointRules, ProgressStore, Scope, StatsStore, TimedEventDefinition,
} from '@promocean/core'

const sk = (s: Scope, rest: string) => `${s.projectId}:${s.environment}:${rest}`

export function makeFakes(
  definitions: AchievementDefinition[],
  auth: AuthContext | null,
  offers: OfferDefinition[] = [],
  timedEvents: TimedEventDefinition[] = [],
  registeredEventTypes: string[] = [],
  pointRules: PointRules = {},
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
    getPointRules: async () => pointRules,
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
  // Recorded verbatim so tests can assert on exactly what the route computed and passed
  // through — TS's function-parameter bivariance would let a 4-param fake satisfy
  // IngestionStore's 5-param type silently, so the 5th param is named and captured explicitly
  // rather than relied on via the compiler.
  const engagementCalls: Array<{ scope: Scope; event: { userId: string; type: string; idempotencyKey: string; occurredAt: Date; meta?: Record<string, unknown> }; engagement: EngagementWrite }> = []
  const ingestionStore: IngestionStore = {
    ingestEvent: async (scope, event, increments, month, engagement) => {
      engagementCalls.push({ scope, event, engagement })
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

  type WalletResult = Awaited<ReturnType<EngagementStore['getWallet']>>
  type StreakResult = Awaited<ReturnType<EngagementStore['getStreak']>>
  type LeaderboardResult = Awaited<ReturnType<EngagementStore['getLeaderboard']>>
  let walletResult: WalletResult = { balance: 0, recent: [] }
  let streakResult: StreakResult = { current: 0, longest: 0, lastActiveDay: null }
  let leaderboardResult: LeaderboardResult = []
  const leaderboardCalls: Array<{ scope: Scope; window: 'all' | '7d' | '30d'; limit: number }> = []
  const engagementStore: EngagementStore = {
    getWallet: async () => walletResult,
    getStreak: async () => streakResult,
    getLeaderboard: async (scope, window, limit) => {
      leaderboardCalls.push({ scope, window, limit })
      return leaderboardResult
    },
  }
  const setWalletResult = (r: WalletResult) => { walletResult = r }
  const setStreakResult = (r: StreakResult) => { streakResult = r }
  const setLeaderboardResult = (r: LeaderboardResult) => { leaderboardResult = r }

  return {
    configStore, apiKeyStore, progressStore, ingestionStore, usage, offerMetricsStore, metrics, erasureStore,
    erasedUsers, erasureCounts, statsStore, statsCalls, setStatsResult, engagementCalls,
    engagementStore, setWalletResult, setStreakResult, setLeaderboardResult, leaderboardCalls,
  }
}
