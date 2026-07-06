import { describe, expect, it } from 'vitest'
import { evaluateEvent, type AchievementDefinition } from '../src/index.js'

const defs: AchievementDefinition[] = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 },
  { id: 'a2', name: 'Getting Started', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 10 },
  { id: 'a3', name: 'Profiled', description: null, artworkUrl: null, eventType: 'profile_completed', targetCount: 1 },
]
const event = { userId: 'u1', type: 'lesson_completed', occurredAt: new Date('2026-07-06T00:00:00Z') }

describe('evaluateEvent', () => {
  it('increments matching achievements and unlocks at target', () => {
    const r = evaluateEvent(event, defs, new Map())
    expect(r.progressUpdates).toEqual([
      { achievementId: 'a1', current: 1, target: 1 },
      { achievementId: 'a2', current: 1, target: 10 },
    ])
    expect(r.unlocks).toEqual([{ achievementId: 'a1', name: 'First Lesson' }])
  })
  it('ignores non-matching event types', () => {
    const r = evaluateEvent({ ...event, type: 'signup' }, defs, new Map())
    expect(r.progressUpdates).toEqual([])
    expect(r.unlocks).toEqual([])
  })
  it('never advances past target and never re-unlocks', () => {
    const r = evaluateEvent(event, defs, new Map([['a1', 1], ['a2', 3]]))
    expect(r.progressUpdates).toEqual([{ achievementId: 'a2', current: 4, target: 10 }])
    expect(r.unlocks).toEqual([])
  })
  it('applies a multiplier and clamps to target', () => {
    const r = evaluateEvent(event, defs, new Map([['a1', 0], ['a2', 9]]), 2)
    expect(r.progressUpdates).toContainEqual({ achievementId: 'a2', current: 10, target: 10 })
    expect(r.unlocks).toContainEqual({ achievementId: 'a2', name: 'Getting Started' })
  })
})
