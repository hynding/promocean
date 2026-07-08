import { createHash } from 'node:crypto'
import type { Context, Next } from 'hono'

const WINDOW_MS = 60_000

interface Bucket {
  count: number
  windowStart: number
}

// Single-instance MVP: state lives in an in-process Map, so limits are per
// server instance. Multi-instance (shared) rate limiting is backlog — would
// need a shared store (e.g. Redis) keyed the same way.
export function createRateLimiter(limitPerMinute: number) {
  const buckets = new Map<string, Bucket>()

  return async (c: Context, next: Next) => {
    if (limitPerMinute <= 0) {
      await next()
      return
    }

    const header = c.req.header('authorization') ?? ''
    const rawKey = header.startsWith('Bearer ') ? header.slice(7) : ''
    const key = createHash('sha256').update(rawKey).digest('hex')

    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: now }
      buckets.set(key, bucket)
    }

    bucket.count += 1

    if (bucket.count > limitPerMinute) {
      const retryAfterSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000)
      c.header('retry-after', String(Math.max(retryAfterSeconds, 1)))
      return c.json({ error: { code: 'rate_limited', message: 'Too many requests.' } }, 429)
    }

    await next()
  }
}
