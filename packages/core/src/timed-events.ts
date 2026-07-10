import type { TimedEventDefinition, TimedEventState } from './types.js'

const DAY_MS = 86_400_000
const WEEK_MS = 604_800_000

export interface OccurrenceWindow {
  index: number
  startsAt: Date
  endsAt: Date
  key: string
}

/** Fixed millisecond step for daily/weekly recurrence; monthly has no fixed step. */
function fixedIntervalMs(recurrence: TimedEventDefinition['recurrence']): number | null {
  if (recurrence === 'daily') return DAY_MS
  if (recurrence === 'weekly') return WEEK_MS
  return null
}

/**
 * UTC calendar-month stepping with day-of-month clamping (Jan 31 + 1mo -> Feb 28/29). Pure
 * UTC-instant arithmetic, no timezone libraries — same style as engagement.ts's day math.
 */
function addMonthsUtcClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  const totalMonths = month + months
  const targetYear = year + Math.floor(totalMonths / 12)
  const targetMonth = ((totalMonths % 12) + 12) % 12
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const clampedDay = Math.min(day, daysInTargetMonth)
  return new Date(Date.UTC(
    targetYear, targetMonth, clampedDay,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ))
}

/**
 * Greatest occurrence index N (>= 0) whose UTC-stepped monthly start is <= `instantMs`.
 * `instantMs` is guaranteed by the caller to be >= base.getTime(). Estimates N via a direct
 * year/month-count division (O(1)) then corrects by at most one step to account for
 * day-of-month clamping — never an unbounded scan from occurrence 0.
 */
function monthlyIndexAtOrBefore(base: Date, instantMs: number): number {
  const instant = new Date(instantMs)
  let n = (instant.getUTCFullYear() - base.getUTCFullYear()) * 12 + (instant.getUTCMonth() - base.getUTCMonth())
  if (n < 0) n = 0
  while (addMonthsUtcClamped(base, n).getTime() > instantMs) n--
  while (addMonthsUtcClamped(base, n + 1).getTime() <= instantMs) n++
  return n
}

/** Occurrence start for a given index (0-based), per the recurrence's stepping rule. */
function occurrenceStart(event: TimedEventDefinition, index: number): Date {
  if (event.recurrence === 'none') return event.startsAt
  if (event.recurrence === 'monthly') return addMonthsUtcClamped(event.startsAt, index)
  const interval = fixedIntervalMs(event.recurrence)! // daily | weekly
  return new Date(event.startsAt.getTime() + index * interval)
}

function occurrenceDuration(event: TimedEventDefinition): number {
  return event.endsAt.getTime() - event.startsAt.getTime()
}

function windowFor(event: TimedEventDefinition, index: number): OccurrenceWindow {
  const startsAt = occurrenceStart(event, index)
  const endsAt = new Date(startsAt.getTime() + occurrenceDuration(event))
  const key = event.recurrence === 'none' ? '' : startsAt.toISOString()
  return { index, startsAt, endsAt, key }
}

/**
 * Greatest occurrence index N (>= 0) with startsAt_N <= `instantMs`, or null if even
 * occurrence 0 hasn't started by `instantMs`. O(1) for daily/weekly (fixed-interval division);
 * bounded month-count arithmetic for monthly — never an unbounded loop from occurrence 0.
 */
function indexAtOrBefore(event: TimedEventDefinition, instantMs: number): number | null {
  const startMs = event.startsAt.getTime()
  if (instantMs < startMs) return null
  if (event.recurrence === 'none') return 0
  const interval = fixedIntervalMs(event.recurrence)
  if (interval !== null) return Math.floor((instantMs - startMs) / interval)
  return monthlyIndexAtOrBefore(event.startsAt, instantMs)
}

/**
 * Greatest existing occurrence index, bounded by recurrenceEndsAt: null means unbounded
 * (every index computed by indexAtOrBefore is valid); a finite number bounds valid indices to
 * [0, n]; -1 means no occurrence exists at all (recurrenceEndsAt at or before startsAt).
 * Not applicable (and not consulted) for recurrence === 'none'.
 */
function maxValidIndex(event: TimedEventDefinition): number | null {
  if (!event.recurrenceEndsAt) return null
  const idx = indexAtOrBefore(event, event.recurrenceEndsAt.getTime() - 1)
  return idx === null ? -1 : idx
}

/** Clamps a candidate index against recurrenceEndsAt; returns null if the index doesn't exist. */
function existingIndex(event: TimedEventDefinition, index: number): number | null {
  if (event.recurrence === 'none') return index === 0 ? 0 : null
  const maxIdx = maxValidIndex(event)
  if (maxIdx === null) return index
  if (maxIdx < 0 || index > maxIdx) return null
  return index
}

/**
 * The occurrence containing `now`, else the NEXT upcoming one, else null (no current-or-future
 * occurrence: a non-recurring event past endsAt, or recurrence past recurrenceEndsAt). This is
 * the DISPLAY/multiplier view.
 */
export function occurrenceWindow(event: TimedEventDefinition, now: Date): OccurrenceWindow | null {
  if (event.recurrence === 'none') {
    return now.getTime() < event.endsAt.getTime() ? windowFor(event, 0) : null
  }
  const nowMs = now.getTime()
  const atOrBefore = indexAtOrBefore(event, nowMs)
  let targetIndex: number
  if (atOrBefore === null) {
    targetIndex = 0 // before the first occurrence -> it's the upcoming one
  } else {
    const current = windowFor(event, atOrBefore)
    targetIndex = nowMs < current.endsAt.getTime() ? atOrBefore : atOrBefore + 1
  }
  const idx = existingIndex(event, targetIndex)
  return idx === null ? null : windowFor(event, idx)
}

/**
 * The latest EXISTING occurrence with startsAt <= now, else null (nothing started yet). This is
 * the SCHEDULER view: between occurrences it returns the just-elapsed occurrence so its
 * 'ended' transition can fire; occurrenceWindow would already be pointing at the next one.
 */
export function transitionOccurrence(event: TimedEventDefinition, now: Date): OccurrenceWindow | null {
  const atOrBefore = indexAtOrBefore(event, now.getTime())
  if (atOrBefore === null) return null
  const maxIdx = maxValidIndex(event)
  const clamped = event.recurrence === 'none' ? 0 : maxIdx === null ? atOrBefore : Math.min(atOrBefore, maxIdx)
  const idx = existingIndex(event, clamped)
  return idx === null ? null : windowFor(event, idx)
}

/**
 * '' -> the definition's own window (index 0). Otherwise parse the ISO key, validate it lands
 * exactly on an existing occurrence start, derive the window. null on garbage/misaligned keys.
 * Used by the redelivery sweep to rebuild messages for stale per-occurrence claims.
 */
export function occurrenceFromKey(event: TimedEventDefinition, key: string): OccurrenceWindow | null {
  if (key === '') {
    const idx = existingIndex(event, 0)
    return idx === null ? null : windowFor(event, idx)
  }
  if (event.recurrence === 'none') return null // only '' is ever valid for non-recurring events
  const parsed = new Date(key)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== key) return null
  const instantMs = parsed.getTime()
  const startMs = event.startsAt.getTime()
  if (instantMs < startMs) return null
  let index: number
  const interval = fixedIntervalMs(event.recurrence)
  if (interval !== null) {
    const diff = instantMs - startMs
    if (diff % interval !== 0) return null
    index = diff / interval
  } else {
    const candidate = monthlyIndexAtOrBefore(event.startsAt, instantMs)
    if (addMonthsUtcClamped(event.startsAt, candidate).getTime() !== instantMs) return null
    index = candidate
  }
  const idx = existingIndex(event, index)
  return idx === null ? null : windowFor(event, idx)
}

/**
 * Occurrence windows intersecting [from, to]. Takes CONCRETE bounds — core stays clock-free;
 * the caller defaults nulls (stats route: from ?? event.startsAt, to ?? new Date()). cap
 * (default 400): keeps the most RECENT `cap` windows in range, dropping the oldest.
 */
export function occurrenceWindowsInRange(
  event: TimedEventDefinition, from: Date, to: Date, cap = 400,
): Array<{ startsAt: Date; endsAt: Date }> {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  if (toMs <= fromMs) return []

  if (event.recurrence === 'none') {
    const w = windowFor(event, 0)
    return w.startsAt.getTime() < toMs && w.endsAt.getTime() > fromMs
      ? [{ startsAt: w.startsAt, endsAt: w.endsAt }]
      : []
  }

  // Only the occurrence at-or-before `from` could partially overlap it (duration <= interval
  // means the previous one always ends by then); occurrences strictly after it, up through the
  // one at-or-before `to`, are the rest of the candidate range.
  const fromAtOrBefore = indexAtOrBefore(event, fromMs)
  const lowIndex = fromAtOrBefore ?? 0
  // Overlap requires startsAt < to, i.e. startsAt <= to - 1ms — mirrors maxValidIndex's
  // strict-cutoff trick so the anchor index itself is guaranteed to satisfy the filter below.
  const toAtOrBefore = indexAtOrBefore(event, toMs - 1)
  if (toAtOrBefore === null) return [] // nothing starts before `to`

  const maxIdx = maxValidIndex(event)
  if (maxIdx !== null && maxIdx < 0) return []
  const highIndex = maxIdx === null ? toAtOrBefore : Math.min(toAtOrBefore, maxIdx)
  if (highIndex < lowIndex) return []

  // Keep computation bounded to ~cap windows even when [from, to] spans a huge range: start
  // from the most-recent end and only walk back as far as needed.
  const startIndex = Math.max(lowIndex, highIndex - cap + 1)

  const results: Array<{ startsAt: Date; endsAt: Date }> = []
  for (let i = startIndex; i <= highIndex; i++) {
    const w = windowFor(event, i)
    if (w.startsAt.getTime() < toMs && w.endsAt.getTime() > fromMs) {
      results.push({ startsAt: w.startsAt, endsAt: w.endsAt })
    }
  }
  return results.length > cap ? results.slice(results.length - cap) : results
}

export function timedEventState(event: TimedEventDefinition, now: Date): TimedEventState {
  if (!event.enabled) return 'draft'
  const w = occurrenceWindow(event, now)
  if (w === null) return 'ended'
  if (now.getTime() < w.startsAt.getTime()) return 'scheduled' // before-first or between-occurrences
  const msLeft = w.endsAt.getTime() - now.getTime()
  return msLeft <= event.endingSoonMinutes * 60_000 ? 'ending_soon' : 'live'
}

const isActive = (s: TimedEventState) => s === 'live' || s === 'ending_soon'

export function activeMultiplier(events: TimedEventDefinition[], now: Date): number {
  let max = 1
  for (const e of events) if (isActive(timedEventState(e, now)) && e.multiplier > max) max = e.multiplier
  return max
}

export function activeEventIds(events: TimedEventDefinition[], now: Date): Set<string> {
  const ids = new Set<string>()
  for (const e of events) if (isActive(timedEventState(e, now))) ids.add(e.id)
  return ids
}
