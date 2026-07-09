import { describe, expect, it } from 'vitest'
import { evaluateEvent, type AchievementDefinition } from '../src/index.js'

const defs: AchievementDefinition[] = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1, pointsValue: 0 },
  { id: 'a2', name: 'Getting Started', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 10, pointsValue: 0 },
  { id: 'a3', name: 'Profiled', description: null, artworkUrl: null, eventType: 'profile_completed', targetCount: 1, pointsValue: 0 },
]
const event = { userId: 'u1', type: 'lesson_completed', occurredAt: new Date('2026-07-06T00:00:00Z') }

describe('evaluateEvent', () => {
  it('returns an increment for each matching-type achievement, ignoring non-matching types', () => {
    const plan = evaluateEvent(event, defs)
    expect(plan.increments).toEqual([
      { achievementId: 'a1', name: 'First Lesson', delta: 1, target: 1 },
      { achievementId: 'a2', name: 'Getting Started', delta: 1, target: 10 },
    ])
  })
  it('ignores non-matching event types', () => {
    const plan = evaluateEvent({ ...event, type: 'signup' }, defs)
    expect(plan.increments).toEqual([])
  })
  it('includes an increment even for an achievement that is already at (or past) target — no skip logic', () => {
    // The store is responsible for clamping at-target increments to no-ops; evaluate never
    // looks at current progress, so an at-target achievement still produces a delta here.
    const plan = evaluateEvent(event, defs)
    const a1 = plan.increments.find((i) => i.achievementId === 'a1')
    expect(a1).toEqual({ achievementId: 'a1', name: 'First Lesson', delta: 1, target: 1 })
  })
  it('honors a multiplier of 1 (default)', () => {
    const plan = evaluateEvent(event, defs, 1)
    expect(plan.increments).toContainEqual({ achievementId: 'a2', name: 'Getting Started', delta: 1, target: 10 })
  })
  it('honors a multiplier of 2', () => {
    const plan = evaluateEvent(event, defs, 2)
    expect(plan.increments).toContainEqual({ achievementId: 'a2', name: 'Getting Started', delta: 2, target: 10 })
  })
  it('rounds a fractional multiplier (1.5 -> 2)', () => {
    const plan = evaluateEvent(event, defs, 1.5)
    expect(plan.increments).toContainEqual({ achievementId: 'a2', name: 'Getting Started', delta: 2, target: 10 })
  })
})
