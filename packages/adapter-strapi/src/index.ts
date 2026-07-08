import { createHash } from 'node:crypto'
import type {
  AchievementDefinition,
  ApiKeyStore,
  AuthContext,
  ConfigStore,
  OfferDefinition,
  TimedEventDefinition,
  WebhookEndpointDefinition,
} from '@promocean/core'
import type { z } from 'zod'
import {
  achievementsResponseSchema,
  allTimedEventsResponseSchema,
  eventTypesResponseSchema,
  offersResponseSchema,
  timedEventsResponseSchema,
  verifyKeyResponseSchema,
  webhookEndpointsResponseSchema,
} from './schemas.js'

export interface StrapiConfigPlaneOptions {
  baseUrl: string
  configSecret: string
  cacheTtlMs?: number
  fetchImpl?: typeof fetch
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
  private timedEventsCache = new Map<string, CacheEntry<TimedEventDefinition[]>>()
  private allTimedEventsCache = new Map<string, CacheEntry<Array<TimedEventDefinition & { projectId: string }>>>()
  private webhookEndpointsCache = new Map<string, CacheEntry<WebhookEndpointDefinition[]>>()
  private eventTypesCache = new Map<string, CacheEntry<string[]>>()

  constructor(private opts: StrapiConfigPlaneOptions) {
    this.ttl = opts.cacheTtlMs ?? 30_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
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
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/config-plane/timed-events/all`, {
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
        }
      }
      this.authCache.set(keyHash, { value, expires: Date.now() + this.ttl })
      return value
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }
}
