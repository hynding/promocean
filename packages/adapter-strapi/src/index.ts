import { createHash } from 'node:crypto'
import type {
  AchievementDefinition,
  ApiKeyStore,
  AuthContext,
  ConfigStore,
  OfferDefinition,
  PointRules,
  RewardDefinition,
  TimedEventDefinition,
  WebhookEndpointDefinition,
} from '@promocean/core'
import type { z } from 'zod'
import {
  achievementsResponseSchema,
  allTimedEventsResponseSchema,
  eventTypesResponseSchema,
  offersResponseSchema,
  pointRulesResponseSchema,
  rewardsResponseSchema,
  timedEventsResponseSchema,
  verifyKeyResponseSchema,
  webhookEndpointsResponseSchema,
} from './schemas.js'

export interface StrapiConfigPlaneOptions {
  baseUrl: string
  configSecret: string
  cacheTtlMs?: number
  fetchImpl?: typeof fetch
  /** When set, getAllTimedEvents requests only events that ended within the last N minutes
   * (or haven't ended yet) via `?endedWithinMinutes=<n>`, keeping the scan feed bounded. */
  allTimedEventsEndedWithinMinutes?: number
  /** Max number of cached `null` (unknown-key) verifyKey results tracked before the
   * oldest is evicted. Bounds unbounded growth from random/invalid key probing. Default 1000. */
  maxNegativeAuthEntries?: number
}

interface CacheEntry<T> { value: T; expires: number }

/** Parses `data` against `schema`; a validation failure is treated exactly like a failed
 * fetch (throws) so callers' existing TTL stale-on-error path applies uniformly. */
function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new Error(`config plane response failed validation: ${parsed.error.message}`)
  }
  return parsed.data
}

export class StrapiConfigPlane implements ConfigStore, ApiKeyStore {
  private readonly ttl: number
  private readonly fetchImpl: typeof fetch
  private achievementsCache = new Map<string, CacheEntry<AchievementDefinition[]>>()
  private offersCache = new Map<string, CacheEntry<OfferDefinition[]>>()
  private authCache = new Map<string, CacheEntry<AuthContext | null>>()
  // Insertion-ordered set of keyHashes currently cached with a `null` (unknown-key)
  // verifyKey result — a Set preserves insertion order, so its first entry is always
  // the oldest, letting us evict FIFO without a separate linked-list/queue structure.
  // Positive (non-null) results are never tracked here and never evicted by this bound.
  private nullAuthKeys = new Set<string>()
  private readonly maxNegativeAuthEntries: number
  private timedEventsCache = new Map<string, CacheEntry<TimedEventDefinition[]>>()
  private allTimedEventsCache = new Map<string, CacheEntry<Array<TimedEventDefinition & { projectId: string }>>>()
  private webhookEndpointsCache = new Map<string, CacheEntry<WebhookEndpointDefinition[]>>()
  private eventTypesCache = new Map<string, CacheEntry<string[]>>()
  private pointRulesCache = new Map<string, CacheEntry<PointRules>>()
  private rewardsCache = new Map<string, CacheEntry<RewardDefinition[]>>()

  constructor(private opts: StrapiConfigPlaneOptions) {
    this.ttl = opts.cacheTtlMs ?? 30_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.maxNegativeAuthEntries = opts.maxNegativeAuthEntries ?? 1000
  }

  /** Sets an authCache entry while maintaining the bounded negative-result tracking:
   * evicts the oldest cached `null` entry when caching a new `null` at capacity, and
   * untracks a key that transitions from a cached `null` to a positive result (so it
   * can't later be evicted as if it were still a stale null). */
  private setAuthCacheEntry(keyHash: string, entry: CacheEntry<AuthContext | null>) {
    if (entry.value === null) {
      if (!this.nullAuthKeys.has(keyHash) && this.nullAuthKeys.size >= this.maxNegativeAuthEntries) {
        const oldest = this.nullAuthKeys.values().next().value
        if (oldest !== undefined) {
          this.nullAuthKeys.delete(oldest)
          this.authCache.delete(oldest)
        }
      }
      this.nullAuthKeys.add(keyHash) // no-op if already present; Set keeps original insertion order
    } else {
      this.nullAuthKeys.delete(keyHash)
    }
    this.authCache.set(keyHash, entry)
  }

  private headers() {
    return { 'x-config-secret': this.opts.configSecret }
  }

  private jsonHeaders() {
    return { ...this.headers(), 'content-type': 'application/json' }
  }

  async getAchievements(projectId: string): Promise<AchievementDefinition[]> {
    const cached = this.achievementsCache.get(projectId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/api/config-plane/achievements?projectId=${encodeURIComponent(projectId)}`,
        { headers: this.headers() },
      )
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = parseOrThrow(achievementsResponseSchema, await res.json())
      this.achievementsCache.set(projectId, { value: body.achievements, expires: Date.now() + this.ttl })
      return body.achievements
    } catch (err) {
      if (cached) return cached.value // stale-on-error
      throw err
    }
  }

  async getOffers(projectId: string): Promise<OfferDefinition[]> {
    const cached = this.offersCache.get(projectId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/api/config-plane/offers?projectId=${encodeURIComponent(projectId)}`,
        { headers: this.headers() },
      )
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = parseOrThrow(offersResponseSchema, await res.json())
      const offers: OfferDefinition[] = body.offers.map((o) => ({
        id: o.id,
        placementSlug: o.placementSlug,
        headline: o.headline,
        body: o.body,
        imageUrl: o.imageUrl,
        ctaText: o.ctaText,
        ctaUrl: o.ctaUrl,
        startsAt: o.startsAt ? new Date(o.startsAt) : null,
        endsAt: o.endsAt ? new Date(o.endsAt) : null,
        priority: o.priority,
        audience: { kind: 'everyone' },
        timedEventId: o.timedEventId,
      }))
      this.offersCache.set(projectId, { value: offers, expires: Date.now() + this.ttl })
      return offers
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }

  async getTimedEvents(projectId: string): Promise<TimedEventDefinition[]> {
    const cached = this.timedEventsCache.get(projectId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/api/config-plane/timed-events?projectId=${encodeURIComponent(projectId)}`,
        { headers: this.headers() },
      )
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = parseOrThrow(timedEventsResponseSchema, await res.json())
      const events: TimedEventDefinition[] = body.events.map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        startsAt: new Date(e.startsAt),
        endsAt: new Date(e.endsAt),
        endingSoonMinutes: e.endingSoonMinutes,
        multiplier: e.multiplier,
        enabled: e.enabled,
      }))
      this.timedEventsCache.set(projectId, { value: events, expires: Date.now() + this.ttl })
      return events
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }

  async getAllTimedEvents(): Promise<Array<TimedEventDefinition & { projectId: string }>> {
    const key = '*'
    const cached = this.allTimedEventsCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const url = new URL(`${this.opts.baseUrl}/api/config-plane/timed-events/all`)
      if (this.opts.allTimedEventsEndedWithinMinutes !== undefined) {
        url.searchParams.set('endedWithinMinutes', String(this.opts.allTimedEventsEndedWithinMinutes))
      }
      const res = await this.fetchImpl(url, {
        headers: this.headers(),
      })
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = parseOrThrow(allTimedEventsResponseSchema, await res.json())
      const events: Array<TimedEventDefinition & { projectId: string }> = body.events.map((e) => ({
        id: e.id,
        projectId: e.projectId,
        name: e.name,
        description: e.description,
        startsAt: new Date(e.startsAt),
        endsAt: new Date(e.endsAt),
        endingSoonMinutes: e.endingSoonMinutes,
        multiplier: e.multiplier,
        enabled: e.enabled,
      }))
      this.allTimedEventsCache.set(key, { value: events, expires: Date.now() + this.ttl })
      return events
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }

  async getWebhookEndpoints(projectId: string): Promise<WebhookEndpointDefinition[]> {
    const cached = this.webhookEndpointsCache.get(projectId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/api/config-plane/webhook-endpoints?projectId=${encodeURIComponent(projectId)}`,
        { headers: this.headers() },
      )
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = parseOrThrow(webhookEndpointsResponseSchema, await res.json())
      const endpoints: WebhookEndpointDefinition[] = body.endpoints.map((e) => ({
        id: e.id,
        url: e.url,
        secret: e.secret,
        enabled: e.enabled,
      }))
      this.webhookEndpointsCache.set(projectId, { value: endpoints, expires: Date.now() + this.ttl })
      return endpoints
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }

  async getRegisteredEventTypes(projectId: string): Promise<string[]> {
    const cached = this.eventTypesCache.get(projectId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/api/config-plane/projects/${encodeURIComponent(projectId)}/event-types`,
        { headers: this.headers() },
      )
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = parseOrThrow(eventTypesResponseSchema, await res.json())
      this.eventTypesCache.set(projectId, { value: body.eventTypes, expires: Date.now() + this.ttl })
      return body.eventTypes
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }

  async getPointRules(projectId: string): Promise<PointRules> {
    const cached = this.pointRulesCache.get(projectId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/api/config-plane/projects/${encodeURIComponent(projectId)}/point-rules`,
        { headers: this.headers() },
      )
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = parseOrThrow(pointRulesResponseSchema, await res.json())
      // Defense in depth: the cms already filters pointRules to non-negative integers before
      // responding, but re-filter here cheaply rather than trust the wire format blindly.
      const pointRules: PointRules = {}
      for (const [eventType, value] of Object.entries(body.pointRules)) {
        if (Number.isInteger(value) && value >= 0) pointRules[eventType] = value
      }
      this.pointRulesCache.set(projectId, { value: pointRules, expires: Date.now() + this.ttl })
      return pointRules
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }

  async getRewards(projectId: string): Promise<RewardDefinition[]> {
    const cached = this.rewardsCache.get(projectId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/api/config-plane/rewards?projectId=${encodeURIComponent(projectId)}`,
        { headers: this.headers() },
      )
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = parseOrThrow(rewardsResponseSchema, await res.json())
      const rewards: RewardDefinition[] = body.rewards.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        codeType: r.codeType,
        staticCode: r.staticCode,
        codePrefix: r.codePrefix,
        pointsPrice: r.pointsPrice,
        startsAt: r.startsAt ? new Date(r.startsAt) : null,
        endsAt: r.endsAt ? new Date(r.endsAt) : null,
        perUserLimit: r.perUserLimit,
        inventory: r.inventory,
        enabled: r.enabled,
      }))
      this.rewardsCache.set(projectId, { value: rewards, expires: Date.now() + this.ttl })
      return rewards
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }

  async verifyKey(rawKey: string): Promise<AuthContext | null> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const cached = this.authCache.get(keyHash)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/config-plane/verify-key`, {
        method: 'POST',
        headers: this.jsonHeaders(),
        body: JSON.stringify({ keyHash }),
      })
      let value: AuthContext | null = null
      if (res.status !== 404) {
        if (!res.ok) throw new Error(`config plane responded ${res.status}`)
        // A parse failure here (including a bad environment/keyType enum) means the CMS
        // record is unusable — fail closed to `null` auth rather than throw, and rather
        // than ever construct a corrupt AuthContext.
        const parsed = verifyKeyResponseSchema.safeParse(await res.json())
        if (parsed.success) {
          const { allowedOrigins } = parsed.data
          value = {
            projectId: parsed.data.projectId,
            environment: parsed.data.environment,
            keyType: parsed.data.keyType,
            allowedOrigins:
              Array.isArray(allowedOrigins) && allowedOrigins.every((o) => typeof o === 'string')
                ? (allowedOrigins as string[])
                : null,
          }
        } else {
          console.warn(
            '[promocean:adapter-strapi] verify-key response failed validation; treating key as invalid',
            { issues: parsed.error.issues },
          )
        }
      }
      // Deliberate fail-closed trade-off: caching `null` here overwrites even a previously-good
      // cached AuthContext for one TTL window if the CMS starts returning malformed bodies
      // (auth boundary: correctness over availability).
      this.setAuthCacheEntry(keyHash, { value, expires: Date.now() + this.ttl })
      return value
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }
}
