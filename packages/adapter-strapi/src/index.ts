import { createHash } from 'node:crypto'
import type { AchievementDefinition, ApiKeyStore, AuthContext, ConfigStore, OfferDefinition } from '@promocean/core'

export interface StrapiConfigPlaneOptions {
  baseUrl: string
  configSecret: string
  cacheTtlMs?: number
  fetchImpl?: typeof fetch
}

interface CacheEntry<T> { value: T; expires: number }

export class StrapiConfigPlane implements ConfigStore, ApiKeyStore {
  private readonly ttl: number
  private readonly fetchImpl: typeof fetch
  private achievementsCache = new Map<string, CacheEntry<AchievementDefinition[]>>()
  private offersCache = new Map<string, CacheEntry<OfferDefinition[]>>()
  private authCache = new Map<string, CacheEntry<AuthContext | null>>()

  constructor(private opts: StrapiConfigPlaneOptions) {
    this.ttl = opts.cacheTtlMs ?? 30_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private headers() {
    return { 'x-config-secret': this.opts.configSecret, 'content-type': 'application/json' }
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
      const body = (await res.json()) as { achievements: AchievementDefinition[] }
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
      const body = (await res.json()) as { offers: Array<Record<string, unknown>> }
      const offers: OfferDefinition[] = body.offers.map((o) => ({
        id: String(o.id),
        placementSlug: String(o.placementSlug),
        headline: String(o.headline),
        body: (o.body as string | null) ?? null,
        imageUrl: (o.imageUrl as string | null) ?? null,
        ctaText: (o.ctaText as string | null) ?? null,
        ctaUrl: (o.ctaUrl as string | null) ?? null,
        startsAt: o.startsAt ? new Date(String(o.startsAt)) : null,
        endsAt: o.endsAt ? new Date(String(o.endsAt)) : null,
        priority: Number(o.priority ?? 0),
        audience: { kind: 'everyone' },
      }))
      this.offersCache.set(projectId, { value: offers, expires: Date.now() + this.ttl })
      return offers
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
        headers: this.headers(),
        body: JSON.stringify({ keyHash }),
      })
      const value = res.status === 404 ? null : res.ok ? ((await res.json()) as AuthContext) : null
      if (!res.ok && res.status !== 404) throw new Error(`config plane responded ${res.status}`)
      this.authCache.set(keyHash, { value, expires: Date.now() + this.ttl })
      return value
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }
}
