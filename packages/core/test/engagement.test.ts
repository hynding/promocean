import { describe, expect, it } from 'vitest'
import { applyStreak, localDayFromOffset, pointsForEvent, type PointRules, type StreakState } from '../src/index.js'

describe('localDayFromOffset', () => {
  it('offset 0 returns the UTC calendar day', () => {
    expect(localDayFromOffset(new Date('2026-07-06T12:00:00.000Z'), 0)).toBe('2026-07-06')
  })
  it('positive offset (east) can push the local day forward across midnight', () => {
    expect(localDayFromOffset(new Date('2026-07-06T23:30:00.000Z'), 120)).toBe('2026-07-07')
  })
  it('positive offset that does not cross midnight stays on the same day', () => {
    expect(localDayFromOffset(new Date('2026-07-06T12:00:00.000Z'), 120)).toBe('2026-07-06')
  })
  it('negative offset (west) can push the local day backward across midnight', () => {
    expect(localDayFromOffset(new Date('2026-07-06T00:30:00.000Z'), -120)).toBe('2026-07-05')
  })
  it('negative offset that does not cross midnight stays on the same day', () => {
    expect(localDayFromOffset(new Date('2026-07-06T12:00:00.000Z'), -120)).toBe('2026-07-06')
  })
  it('clamps offsets above +840 to +840', () => {
    // 900 minutes (15h) would push into 2026-07-07; clamp to 840 (14h) still crosses midnight from 23:30Z
    const withClamp = localDayFromOffset(new Date('2026-07-06T23:30:00.000Z'), 900)
    const atClampBoundary = localDayFromOffset(new Date('2026-07-06T23:30:00.000Z'), 840)
    expect(withClamp).toBe(atClampBoundary)
    expect(withClamp).toBe('2026-07-07')
  })
  it('clamps offsets below -840 to -840', () => {
    const withClamp = localDayFromOffset(new Date('2026-07-06T00:30:00.000Z'), -900)
    const atClampBoundary = localDayFromOffset(new Date('2026-07-06T00:30:00.000Z'), -840)
    expect(withClamp).toBe(atClampBoundary)
    expect(withClamp).toBe('2026-07-05')
  })
  it('treats undefined offset as 0', () => {
    expect(localDayFromOffset(new Date('2026-07-06T12:00:00.000Z'), undefined)).toBe('2026-07-06')
  })
  it('treats NaN offset as 0', () => {
    expect(localDayFromOffset(new Date('2026-07-06T12:00:00.000Z'), NaN)).toBe('2026-07-06')
  })
  it('treats non-finite offset (Infinity) as 0', () => {
    expect(localDayFromOffset(new Date('2026-07-06T12:00:00.000Z'), Infinity)).toBe('2026-07-06')
    expect(localDayFromOffset(new Date('2026-07-06T12:00:00.000Z'), -Infinity)).toBe('2026-07-06')
  })
  it('exact boundary instant: UTC midnight with offset 0 stays on that day', () => {
    expect(localDayFromOffset(new Date('2026-07-06T00:00:00.000Z'), 0)).toBe('2026-07-06')
  })
  it('exact boundary instant crossing a year forward', () => {
    expect(localDayFromOffset(new Date('2026-12-31T23:59:00.000Z'), 1)).toBe('2027-01-01')
  })
  it('exact boundary instant crossing a year backward', () => {
    expect(localDayFromOffset(new Date('2026-01-01T00:00:00.000Z'), -1)).toBe('2025-12-31')
  })
  it('pads single-digit month and day with zeros', () => {
    expect(localDayFromOffset(new Date('2026-01-05T12:00:00.000Z'), 0)).toBe('2026-01-05')
  })
})

describe('applyStreak', () => {
  it('returns null (same-day no-op) when the day matches lastActiveDay', () => {
    const prev: StreakState = { current: 3, longest: 5, lastActiveDay: '2026-07-06' }
    expect(applyStreak(prev, '2026-07-06')).toBeNull()
  })
  it('increments current on a consecutive calendar day', () => {
    const prev: StreakState = { current: 3, longest: 5, lastActiveDay: '2026-07-06' }
    expect(applyStreak(prev, '2026-07-07')).toEqual({ current: 4, longest: 5, lastActiveDay: '2026-07-07' })
  })
  it('handles a consecutive day across a month rollover (30-day month)', () => {
    const prev: StreakState = { current: 1, longest: 1, lastActiveDay: '2026-06-30' }
    expect(applyStreak(prev, '2026-07-01')).toEqual({ current: 2, longest: 2, lastActiveDay: '2026-07-01' })
  })
  it('handles a consecutive day across a month rollover (31-day month)', () => {
    const prev: StreakState = { current: 1, longest: 1, lastActiveDay: '2026-07-31' }
    expect(applyStreak(prev, '2026-08-01')).toEqual({ current: 2, longest: 2, lastActiveDay: '2026-08-01' })
  })
  it('handles a consecutive day across a year rollover', () => {
    const prev: StreakState = { current: 4, longest: 4, lastActiveDay: '2025-12-31' }
    expect(applyStreak(prev, '2026-01-01')).toEqual({ current: 5, longest: 5, lastActiveDay: '2026-01-01' })
  })
  it('handles a consecutive day across a leap-year Feb 29', () => {
    const prev: StreakState = { current: 1, longest: 1, lastActiveDay: '2024-02-28' }
    expect(applyStreak(prev, '2024-02-29')).toEqual({ current: 2, longest: 2, lastActiveDay: '2024-02-29' })
  })
  it('handles the day after a leap-year Feb 29', () => {
    const prev: StreakState = { current: 2, longest: 2, lastActiveDay: '2024-02-29' }
    expect(applyStreak(prev, '2024-03-01')).toEqual({ current: 3, longest: 3, lastActiveDay: '2024-03-01' })
  })
  it('treats Feb 28 -> Mar 1 as consecutive in a non-leap year (no Feb 29 exists)', () => {
    const prev: StreakState = { current: 5, longest: 5, lastActiveDay: '2023-02-28' }
    expect(applyStreak(prev, '2023-03-01')).toEqual({ current: 6, longest: 6, lastActiveDay: '2023-03-01' })
  })
  it('does NOT treat Feb 28 -> Mar 1 as consecutive in a leap year (Feb 29 is skipped)', () => {
    const prev: StreakState = { current: 5, longest: 5, lastActiveDay: '2024-02-28' }
    expect(applyStreak(prev, '2024-03-01')).toEqual({ current: 1, longest: 5, lastActiveDay: '2024-03-01' })
  })
  it('resets current to 1 on a gap (skipped day)', () => {
    const prev: StreakState = { current: 5, longest: 5, lastActiveDay: '2026-07-01' }
    expect(applyStreak(prev, '2026-07-03')).toEqual({ current: 1, longest: 5, lastActiveDay: '2026-07-03' })
  })
  it('resets current to 1 when the new day is before lastActiveDay (out of order)', () => {
    const prev: StreakState = { current: 5, longest: 5, lastActiveDay: '2026-07-10' }
    expect(applyStreak(prev, '2026-07-05')).toEqual({ current: 1, longest: 5, lastActiveDay: '2026-07-05' })
  })
  it('tracks longest as the max ever seen, growing when current exceeds it', () => {
    const prev: StreakState = { current: 5, longest: 5, lastActiveDay: '2026-07-06' }
    expect(applyStreak(prev, '2026-07-07')).toEqual({ current: 6, longest: 6, lastActiveDay: '2026-07-07' })
  })
  it('never decreases longest when current is below the existing record', () => {
    const prev: StreakState = { current: 1, longest: 10, lastActiveDay: '2026-07-06' }
    expect(applyStreak(prev, '2026-07-07')).toEqual({ current: 2, longest: 10, lastActiveDay: '2026-07-07' })
  })
  it('starts a streak of 1 on the first-ever event (lastActiveDay null)', () => {
    const prev: StreakState = { current: 0, longest: 0, lastActiveDay: null }
    expect(applyStreak(prev, '2026-07-06')).toEqual({ current: 1, longest: 1, lastActiveDay: '2026-07-06' })
  })
})

describe('pointsForEvent', () => {
  const rules: PointRules = { lesson_completed: 10, signup: 0, broken: -5, weird: NaN }
  it('returns the configured points for a matching rule', () => {
    expect(pointsForEvent(rules, 'lesson_completed')).toBe(10)
  })
  it('returns 0 when no rule matches the event type', () => {
    expect(pointsForEvent(rules, 'unknown_event')).toBe(0)
  })
  it('returns 0 when the rule is explicitly 0', () => {
    expect(pointsForEvent(rules, 'signup')).toBe(0)
  })
  it('floors a negative rule value to 0', () => {
    expect(pointsForEvent(rules, 'broken')).toBe(0)
  })
  it('floors a non-finite rule value (NaN) to 0', () => {
    expect(pointsForEvent(rules, 'weird')).toBe(0)
  })
})
