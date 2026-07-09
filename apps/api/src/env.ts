import { logger } from './logger.js'

/**
 * Reads an integer env var, guarding against `Number(junk)` silently producing NaN — a junk
 * `RATE_LIMIT_MAX_BUCKETS` would otherwise disable its cap entirely, and a junk grace-window
 * value would make sweeps throw every tick. Missing (unset) falls back silently; a value that
 * is set but not a finite number falls back with a warning so misconfiguration is visible.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    logger.warn({ name, raw, fallback }, 'env: invalid integer value, using fallback')
    return fallback
  }
  return parsed
}
