import { describe, expect, it } from 'vitest'
import { activeEventIds, activeMultiplier, timedEventState, type TimedEventDefinition } from '../src/index.js'

const mk = (over: Partial<TimedEventDefinition>): TimedEventDefinition => ({
  id: 'e1', name: 'E', description: null,
  startsAt: new Date('2026-07-10T00:00:00Z'), endsAt: new Date('2026-07-17T00:00:00Z'),
  endingSoonMinutes: 1440, multiplier: 2, enabled: true, ...over,
})

describe('timedEventState', () => {
  const e = mk({})
  it('walks the full lifecycle', () => {
    expect(timedEventState(mk({ enabled: false }), new Date('2026-07-12T00:00:00Z'))).toBe('draft')
    expect(timedEventState(e, new Date('2026-07-09T00:00:00Z'))).toBe('scheduled')
    expect(timedEventState(e, new Date('2026-07-10T00:00:00Z'))).toBe('live')      // startsAt inclusive
    expect(timedEventState(e, new Date('2026-07-16T00:00:00Z'))).toBe('ending_soon') // exactly 24h left
    expect(timedEventState(e, new Date('2026-07-17T00:00:00Z'))).toBe('ended')     // endsAt exclusive
  })
})

describe('activeMultiplier / activeEventIds', () => {
  const now = new Date('2026-07-12T00:00:00Z')
  it('takes the max across live events, floor 1', () => {
    expect(activeMultiplier([], now)).toBe(1)
    expect(activeMultiplier([mk({ multiplier: 2 }), mk({ id: 'e2', multiplier: 3 })], now)).toBe(3)
    expect(activeMultiplier([mk({ enabled: false, multiplier: 5 })], now)).toBe(1)
    expect(activeMultiplier([mk({ startsAt: new Date('2026-08-01T00:00:00Z'), multiplier: 5 })], now)).toBe(1)
  })
  it('collects live and ending_soon ids only', () => {
    const events = [mk({}), mk({ id: 'e2', endsAt: new Date('2026-07-12T12:00:00Z') }), mk({ id: 'e3', enabled: false })]
    expect(activeEventIds(events, now)).toEqual(new Set(['e1', 'e2']))
  })
})
