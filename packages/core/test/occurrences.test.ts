import { describe, expect, it } from 'vitest'
import {
  activeEventIds,
  activeMultiplier,
  occurrenceFromKey,
  occurrenceWindow,
  occurrenceWindowsInRange,
  timedEventState,
  transitionOccurrence,
  type TimedEventDefinition,
} from '../src/index.js'

const DAY_MS = 86_400_000

const mk = (over: Partial<TimedEventDefinition>): TimedEventDefinition => ({
  id: 'e1', name: 'E', description: null,
  startsAt: new Date('2026-07-10T00:00:00.000Z'), endsAt: new Date('2026-07-17T00:00:00.000Z'),
  endingSoonMinutes: 1440, multiplier: 2, enabled: true,
  recurrence: 'none', recurrenceEndsAt: null, ...over,
})

// Daily fixture: 2h-duration occurrences every 24h, starting 2026-07-10T00:00Z.
// N0 [07-10T00:00, 07-10T02:00), N1 [07-11T00:00, 07-11T02:00), N2 [07-12T00:00, 07-12T02:00),
// N3 [07-13T00:00, 07-13T02:00), N4 [07-14T00:00, 07-14T02:00)
const dailyEvent = mk({
  recurrence: 'daily',
  startsAt: new Date('2026-07-10T00:00:00.000Z'),
  endsAt: new Date('2026-07-10T02:00:00.000Z'),
  recurrenceEndsAt: null,
})

describe('occurrenceWindow', () => {
  describe('non-recurring', () => {
    const e = mk({})
    it('before start -> the single window', () => {
      const w = occurrenceWindow(e, new Date('2026-07-09T00:00:00.000Z'))
      expect(w).toEqual({ index: 0, startsAt: e.startsAt, endsAt: e.endsAt, key: '' })
    })
    it('inside -> the single window', () => {
      const w = occurrenceWindow(e, new Date('2026-07-12T00:00:00.000Z'))
      expect(w).toEqual({ index: 0, startsAt: e.startsAt, endsAt: e.endsAt, key: '' })
    })
    it('after (endsAt, exclusive) -> null', () => {
      expect(occurrenceWindow(e, e.endsAt)).toBeNull()
    })
  })

  describe('daily containment', () => {
    it('exact start is inclusive (current occurrence)', () => {
      const w = occurrenceWindow(dailyEvent, new Date('2026-07-11T00:00:00.000Z'))
      expect(w?.index).toBe(1)
      expect(w?.startsAt).toEqual(new Date('2026-07-11T00:00:00.000Z'))
    })
    it('exact end is exclusive -> next occurrence', () => {
      const w = occurrenceWindow(dailyEvent, new Date('2026-07-11T02:00:00.000Z'))
      expect(w?.index).toBe(2)
      expect(w?.startsAt).toEqual(new Date('2026-07-12T00:00:00.000Z'))
    })
    it('between occurrences returns the next one', () => {
      const w = occurrenceWindow(dailyEvent, new Date('2026-07-10T12:00:00.000Z'))
      expect(w?.index).toBe(1)
      expect(w?.startsAt).toEqual(new Date('2026-07-11T00:00:00.000Z'))
    })
    it('key is the ISO of the occurrence start', () => {
      const w = occurrenceWindow(dailyEvent, new Date('2026-07-11T00:30:00.000Z'))
      expect(w?.key).toBe('2026-07-11T00:00:00.000Z')
    })
  })

  describe('recurrenceEndsAt cutoff', () => {
    // 30-min-duration daily occurrences so the gap between an occurrence's end and the next
    // one starting is large and unambiguous.
    const base = { recurrence: 'daily' as const, startsAt: new Date('2026-07-10T00:00:00.000Z'), endsAt: new Date('2026-07-10T00:30:00.000Z') }
    it('occurrence starting AT the cutoff does not exist', () => {
      const e = mk({ ...base, recurrenceEndsAt: new Date('2026-07-11T00:00:00.000Z') })
      expect(occurrenceWindow(e, new Date('2026-07-12T00:00:00.000Z'))).toBeNull()
    })
    it('occurrence starting 1ms before the cutoff exists', () => {
      const e = mk({ ...base, recurrenceEndsAt: new Date('2026-07-11T00:00:00.001Z') })
      const w = occurrenceWindow(e, new Date('2026-07-10T12:00:00.000Z'))
      expect(w?.index).toBe(1)
      expect(w?.startsAt).toEqual(new Date('2026-07-11T00:00:00.000Z'))
    })
  })

  describe('monthly stepping', () => {
    const monthlyEvent = mk({
      recurrence: 'monthly',
      startsAt: new Date('2026-01-31T00:00:00.000Z'),
      endsAt: new Date('2026-01-31T01:00:00.000Z'),
      recurrenceEndsAt: null,
    })
    it('Jan 31 + 1mo clamps to Feb 28 (non-leap year)', () => {
      const w = occurrenceWindow(monthlyEvent, new Date('2026-02-15T00:00:00.000Z'))
      expect(w?.index).toBe(1)
      expect(w?.startsAt).toEqual(new Date('2026-02-28T00:00:00.000Z'))
      expect(w?.endsAt).toEqual(new Date('2026-02-28T01:00:00.000Z'))
    })
    it('continues stepping correctly after a clamp (Feb -> Mar 31)', () => {
      const w = occurrenceWindow(monthlyEvent, new Date('2026-03-15T00:00:00.000Z'))
      expect(w?.index).toBe(2)
      expect(w?.startsAt).toEqual(new Date('2026-03-31T00:00:00.000Z'))
    })
    it('leap year clamps Jan 31 + 1mo to Feb 29', () => {
      const leapEvent = mk({
        recurrence: 'monthly',
        startsAt: new Date('2028-01-31T00:00:00.000Z'),
        endsAt: new Date('2028-01-31T01:00:00.000Z'),
        recurrenceEndsAt: null,
      })
      const w = occurrenceWindow(leapEvent, new Date('2028-02-15T00:00:00.000Z'))
      expect(w?.index).toBe(1)
      expect(w?.startsAt).toEqual(new Date('2028-02-29T00:00:00.000Z'))
    })
  })

  describe('duration = interval (back-to-back occurrences)', () => {
    const e = mk({
      recurrence: 'daily',
      startsAt: new Date('2026-07-10T00:00:00.000Z'),
      endsAt: new Date('2026-07-11T00:00:00.000Z'), // 24h duration == daily interval
      recurrenceEndsAt: null,
    })
    it('end of occurrence N is exactly the start of N+1, unambiguous by end-exclusivity', () => {
      const w = occurrenceWindow(e, new Date('2026-07-11T00:00:00.000Z'))
      expect(w?.index).toBe(1)
      expect(w?.startsAt).toEqual(new Date('2026-07-11T00:00:00.000Z'))
    })
  })
})

describe('transitionOccurrence', () => {
  it('nothing started yet -> null', () => {
    expect(transitionOccurrence(dailyEvent, new Date('2026-07-09T00:00:00.000Z'))).toBeNull()
  })
  it('inside an occurrence -> that occurrence', () => {
    const w = transitionOccurrence(dailyEvent, new Date('2026-07-11T00:30:00.000Z'))
    expect(w?.index).toBe(1)
  })
  it('between occurrences -> the previous (just-elapsed) occurrence', () => {
    const w = transitionOccurrence(dailyEvent, new Date('2026-07-11T12:00:00.000Z'))
    expect(w?.index).toBe(1)
    expect(w?.startsAt).toEqual(new Date('2026-07-11T00:00:00.000Z'))
    // contrast: occurrenceWindow at the same instant points at the next occurrence
    const next = occurrenceWindow(dailyEvent, new Date('2026-07-11T12:00:00.000Z'))
    expect(next?.index).toBe(2)
  })
  it('after the final occurrence (recurrenceEndsAt cutoff) -> the final occurrence, not null', () => {
    const e = mk({
      recurrence: 'daily',
      startsAt: new Date('2026-07-10T00:00:00.000Z'),
      endsAt: new Date('2026-07-10T00:30:00.000Z'),
      recurrenceEndsAt: new Date('2026-07-11T00:00:00.001Z'), // occurrence 1 exists, occurrence 2 does not
    })
    const w = transitionOccurrence(e, new Date('2026-07-20T00:00:00.000Z'))
    expect(w?.index).toBe(1)
    expect(w?.startsAt).toEqual(new Date('2026-07-11T00:00:00.000Z'))
    // occurrenceWindow at the same far-future instant has nothing left to show
    expect(occurrenceWindow(e, new Date('2026-07-20T00:00:00.000Z'))).toBeNull()
  })
  it('monthly: between occurrences returns the previous month, not the next', () => {
    const monthlyEvent = mk({
      recurrence: 'monthly',
      startsAt: new Date('2026-01-31T00:00:00.000Z'),
      endsAt: new Date('2026-01-31T01:00:00.000Z'),
      recurrenceEndsAt: null,
    })
    const w = transitionOccurrence(monthlyEvent, new Date('2026-02-15T00:00:00.000Z'))
    expect(w?.index).toBe(0)
    expect(w?.startsAt).toEqual(new Date('2026-01-31T00:00:00.000Z'))
  })
})

describe('occurrenceFromKey', () => {
  it("'' -> the definition's own window (index 0)", () => {
    const e = mk({})
    expect(occurrenceFromKey(e, '')).toEqual({ index: 0, startsAt: e.startsAt, endsAt: e.endsAt, key: '' })
  })
  it('valid on-grid ISO -> the correct index', () => {
    const w = occurrenceFromKey(dailyEvent, '2026-07-12T00:00:00.000Z')
    expect(w).toEqual({
      index: 2,
      startsAt: new Date('2026-07-12T00:00:00.000Z'),
      endsAt: new Date('2026-07-12T02:00:00.000Z'),
      key: '2026-07-12T00:00:00.000Z',
    })
  })
  it('garbage string -> null', () => {
    expect(occurrenceFromKey(dailyEvent, 'not-a-date')).toBeNull()
  })
  it('off-grid ISO (does not land on an occurrence start) -> null', () => {
    expect(occurrenceFromKey(dailyEvent, '2026-07-11T00:00:01.000Z')).toBeNull()
  })
  it('ISO before the definition startsAt -> null', () => {
    expect(occurrenceFromKey(dailyEvent, '2020-01-01T00:00:00.000Z')).toBeNull()
  })
  it('a non-empty key against a non-recurring event -> null (only "" is valid)', () => {
    const e = mk({})
    expect(occurrenceFromKey(e, e.startsAt.toISOString())).toBeNull()
  })
  it('key beyond recurrenceEndsAt -> null', () => {
    const e = mk({
      recurrence: 'daily',
      startsAt: new Date('2026-07-10T00:00:00.000Z'),
      endsAt: new Date('2026-07-10T00:30:00.000Z'),
      recurrenceEndsAt: new Date('2026-07-11T00:00:00.000Z'), // occurrence 1 starts exactly here -> doesn't exist
    })
    expect(occurrenceFromKey(e, '2026-07-11T00:00:00.000Z')).toBeNull()
  })
  it('key just before recurrenceEndsAt -> resolves', () => {
    const e = mk({
      recurrence: 'daily',
      startsAt: new Date('2026-07-10T00:00:00.000Z'),
      endsAt: new Date('2026-07-10T00:30:00.000Z'),
      recurrenceEndsAt: new Date('2026-07-11T00:00:00.001Z'),
    })
    const w = occurrenceFromKey(e, '2026-07-11T00:00:00.000Z')
    expect(w?.index).toBe(1)
  })
})

describe('occurrenceWindowsInRange', () => {
  it('range spanning 3 occurrences -> 3 windows', () => {
    const from = new Date('2026-07-10T00:00:00.000Z')
    const to = new Date('2026-07-13T00:00:00.000Z') // == N3.startsAt, excluded (end-exclusive on `to`)
    const windows = occurrenceWindowsInRange(dailyEvent, from, to)
    expect(windows).toHaveLength(3)
    expect(windows.map(w => w.startsAt)).toEqual([
      new Date('2026-07-10T00:00:00.000Z'),
      new Date('2026-07-11T00:00:00.000Z'),
      new Date('2026-07-12T00:00:00.000Z'),
    ])
  })
  it('partial overlap at both edges is included', () => {
    const from = new Date('2026-07-10T01:00:00.000Z') // inside N0's window
    const to = new Date('2026-07-12T01:00:00.000Z') // inside N2's window
    const windows = occurrenceWindowsInRange(dailyEvent, from, to)
    expect(windows).toHaveLength(3)
    expect(windows[0].startsAt).toEqual(new Date('2026-07-10T00:00:00.000Z'))
    expect(windows[2].startsAt).toEqual(new Date('2026-07-12T00:00:00.000Z'))
  })
  it('cap keeps the most recent windows, dropping the oldest', () => {
    const from = new Date('2026-07-10T00:00:00.000Z')
    const to = new Date('2026-07-15T00:00:00.000Z') // spans occurrences 0..4 (5 dailies)
    const windows = occurrenceWindowsInRange(dailyEvent, from, to, 3)
    expect(windows).toHaveLength(3)
    expect(windows.map(w => w.startsAt)).toEqual([
      new Date('2026-07-12T00:00:00.000Z'),
      new Date('2026-07-13T00:00:00.000Z'),
      new Date('2026-07-14T00:00:00.000Z'),
    ])
  })
  it('non-recurring event with an overlapping range -> single window', () => {
    const e = mk({})
    const windows = occurrenceWindowsInRange(e, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-20T00:00:00.000Z'))
    expect(windows).toEqual([{ startsAt: e.startsAt, endsAt: e.endsAt }])
  })
})

describe('timedEventState — occurrence-aware', () => {
  const e = mk({
    recurrence: 'daily',
    startsAt: new Date('2026-07-10T00:00:00.000Z'),
    endsAt: new Date('2026-07-10T02:00:00.000Z'),
    endingSoonMinutes: 30,
    recurrenceEndsAt: null,
  })
  it('disabled -> draft', () => {
    expect(timedEventState({ ...e, enabled: false }, new Date('2026-07-11T00:30:00.000Z'))).toBe('draft')
  })
  it('before the first occurrence -> scheduled', () => {
    expect(timedEventState(e, new Date('2026-07-09T00:00:00.000Z'))).toBe('scheduled')
  })
  it('inside an occurrence, plenty of time left -> live', () => {
    expect(timedEventState(e, new Date('2026-07-10T00:30:00.000Z'))).toBe('live')
  })
  it('inside an occurrence, within endingSoonMinutes of its end -> ending_soon', () => {
    expect(timedEventState(e, new Date('2026-07-10T01:45:00.000Z'))).toBe('ending_soon')
  })
  it('between occurrences -> scheduled', () => {
    expect(timedEventState(e, new Date('2026-07-10T12:00:00.000Z'))).toBe('scheduled')
  })
  it('ending_soon inside a LATER occurrence', () => {
    expect(timedEventState(e, new Date('2026-07-11T01:45:00.000Z'))).toBe('ending_soon')
  })
  it('no occurrence left (past recurrenceEndsAt) -> ended', () => {
    const capped = mk({
      recurrence: 'daily',
      startsAt: new Date('2026-07-10T00:00:00.000Z'),
      endsAt: new Date('2026-07-10T00:30:00.000Z'),
      recurrenceEndsAt: new Date('2026-07-11T00:00:00.000Z'),
    })
    expect(timedEventState(capped, new Date('2026-07-15T00:00:00.000Z'))).toBe('ended')
  })
})

describe('activeMultiplier / activeEventIds — occurrence-aware', () => {
  const e = mk({
    recurrence: 'daily',
    startsAt: new Date('2026-07-10T00:00:00.000Z'),
    endsAt: new Date('2026-07-10T02:00:00.000Z'),
    endingSoonMinutes: 30,
    multiplier: 3,
    recurrenceEndsAt: null,
  })
  it('active inside occurrence 2 of a recurring event', () => {
    const now = new Date('2026-07-12T00:30:00.000Z')
    expect(activeMultiplier([e], now)).toBe(3)
    expect(activeEventIds([e], now)).toEqual(new Set(['e1']))
  })
  it('inactive between occurrences', () => {
    const now = new Date('2026-07-11T12:00:00.000Z')
    expect(activeMultiplier([e], now)).toBe(1)
    expect(activeEventIds([e], now)).toEqual(new Set())
  })
})
