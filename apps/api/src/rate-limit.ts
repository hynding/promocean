import { createHash } from 'node:crypto'
import type { Context, Next } from 'hono'

const WINDOW_MS = 60_000
const DEFAULT_MAX_BUCKETS = 10_000

// Shared bucket key for requests from keys we haven't seen this window once the
// map is at cap. Never collides with a sha256 hex digest (64 chars), so it's a
// safe sentinel alongside real per-key buckets.
const OVERFLOW_KEY = '__overflow__'

interface Bucket {
  count: number
  windowStart: number
}

export interface RateLimiterOptions {
  /** Max distinct buckets tracked before new keys share the overflow bucket. Default 10000. */
  maxBuckets?: number
  /** Injectable clock, for tests. Default `Date.now`. */
  now?: () => number
}

export interface RateLimiterMiddleware {
  (c: Context, next: Next): Promise<Response | undefined>
  /** Test-only: current number of tracked buckets (including the shared overflow
   * bucket, if in use). Not part of the public rate-limiter contract. */
  _bucketCount(): number
}

// Single-instance MVP: state lives in an in-process Map, so limits are per
// server instance. Multi-instance (shared) rate limiting is backlog — would
// need a shared store (e.g. Redis) keyed the same way.
export function createRateLimiter(limitPerMinute: number, opts: RateLimiterOptions = {}): RateLimiterMiddleware {
  const buckets = new Map<string, Bucket>()
  const maxBuckets = opts.maxBuckets ?? DEFAULT_MAX_BUCKETS
  const now = opts.now ?? Date.now

  const middleware = (async (c: Context, next: Next) => {
    if (limitPerMinute <= 0) {
      await next()
      return
    }

    const header = c.req.header('authorization') ?? ''
    const rawKey = header.startsWith('Bearer ') ? header.slice(7) : ''
    const hashedKey = createHash('sha256').update(rawKey).digest('hex')

    const nowMs = now()
    const isNewKey = !buckets.has(hashedKey)
    // At cap, keys we haven't seen this window share one overflow bucket instead of
    // growing the map further — still counted and 429-able, never unlimited, never
    // denied outright.
    const effectiveKey = isNewKey && buckets.size >= maxBuckets ? OVERFLOW_KEY : hashedKey

    let bucket = buckets.get(effectiveKey)
    if (!bucket || nowMs - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: nowMs }
      buckets.set(effectiveKey, bucket)

      // Lazy sweep, piggybacked on this request's own bucket rollover: reclaim every
      // expired bucket in the map. O(n) over the map per sweep, but a sweep only runs
      // when *this* key's own bucket rolls over — at most once per window per active
      // key — so the amortized cost stays cheap even at the 10k-bucket cap.
      for (const [k, b] of buckets) {
        if (k !== effectiveKey && nowMs - b.windowStart >= WINDOW_MS) buckets.delete(k)
      }
    }

    bucket.count += 1

    if (bucket.count > limitPerMinute) {
      const retryAfterSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - nowMs) / 1000)
      c.header('retry-after', String(Math.max(retryAfterSeconds, 1)))
      return c.json({ error: { code: 'rate_limited', message: 'Too many requests.' } }, 429)
    }

    await next()
    return undefined
  }) as RateLimiterMiddleware

  middleware._bucketCount = () => buckets.size

  return middleware
}
