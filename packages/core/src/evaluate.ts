import type { AchievementDefinition, EvaluationPlan, TrackedEvent } from './types.js'

/**
 * Computes the set of progress deltas a tracked event should apply, without deciding
 * outcomes (unlocks, clamped progress). Those decisions belong to the store, which applies
 * the deltas atomically and returns the resulting truth (see IngestionStore.ingestEvent).
 *
 * For every achievement definition whose eventType matches the event, an increment is
 * produced — including achievements already at or past target. This is intentional: the
 * caller no longer has (or needs) current-progress state, and an at-target increment is a
 * no-op once the store clamps it, avoiding a read-modify-write race.
 */
export function evaluateEvent(event: TrackedEvent, definitions: AchievementDefinition[], multiplier = 1): EvaluationPlan {
  const increments: EvaluationPlan['increments'] = []
  for (const def of definitions) {
    if (def.eventType !== event.type) continue
    // Math.round(1 * multiplier): non-integer multipliers were never truly supported (delta is an integer column).
    increments.push({ achievementId: def.id, name: def.name, delta: Math.round(1 * multiplier), target: def.targetCount })
  }
  return { increments }
}
