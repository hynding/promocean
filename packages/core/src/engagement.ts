import type { PointRules } from './types.js'

const MIN_TZ_OFFSET_MINUTES = -840
const MAX_TZ_OFFSET_MINUTES = 840
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Resolves the client-local calendar day for an event, given a client-supplied tz offset in
 * minutes (east-positive, i.e. UTC+1 is +60 — the opposite sign convention from
 * Date.prototype.getTimezoneOffset()). The offset is clamped to the real-world range
 * [-840, 840] (UTC-14..UTC+14) and any missing/invalid input is treated as 0 (UTC).
 *
 * Implementation shifts the instant by the offset and reads the UTC calendar fields off the
 * shifted Date — this is pure UTC Date arithmetic (no timezone libraries) and is
 * calendar-correct across month/year boundaries because it never touches the host's local
 * timezone.
 */
export function localDayFromOffset(occurredAt: Date, tzOffsetMinutes: number | undefined): string {
  const offset = typeof tzOffsetMinutes === 'number' && Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0
  const clamped = Math.min(MAX_TZ_OFFSET_MINUTES, Math.max(MIN_TZ_OFFSET_MINUTES, offset))
  const shifted = new Date(occurredAt.getTime() + clamped * 60_000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface StreakState {
  current: number
  longest: number
  lastActiveDay: string | null
}

/** Epoch ms of UTC midnight for a 'YYYY-MM-DD' day string. */
function dayToUtcMs(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}

/**
 * Advances streak state for an activity on `day` ('YYYY-MM-DD', already offset-resolved by
 * the caller). Returns null when `day` is the same as the last active day (same-day
 * no-op — callers should not double-count multiple events in one local day). Otherwise
 * increments current by 1 when `day` is exactly the calendar day after lastActiveDay, or
 * resets current to 1 for any other case (gap, out-of-order day, or first-ever event).
 * `longest` never decreases.
 *
 * The "day after" check compares millisecond difference between Date.UTC of the two parsed
 * day strings — this is exact calendar-day arithmetic (always MS_PER_DAY apart for
 * consecutive calendar days, in UTC, with no DST ambiguity) and is correct across month and
 * year rollovers, including leap years.
 */
export function applyStreak(prev: StreakState, day: string): StreakState | null {
  if (prev.lastActiveDay === day) return null
  const isConsecutive = prev.lastActiveDay !== null && dayToUtcMs(day) - dayToUtcMs(prev.lastActiveDay) === MS_PER_DAY
  const current = isConsecutive ? prev.current + 1 : 1
  const longest = Math.max(prev.longest, current)
  return { current, longest, lastActiveDay: day }
}

/** Looks up the point award for an event type; unmatched, zero, negative, or non-finite rules all yield 0. */
export function pointsForEvent(rules: PointRules, eventType: string): number {
  const raw = rules[eventType] ?? 0
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}
