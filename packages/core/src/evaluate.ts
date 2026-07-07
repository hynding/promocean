import type { AchievementDefinition, EvaluationResult, TrackedEvent } from './types.js'

export function evaluateEvent(
  event: TrackedEvent,
  definitions: AchievementDefinition[],
  currentCounts: Map<string, number>,
  multiplier = 1,
): EvaluationResult {
  const progressUpdates: EvaluationResult['progressUpdates'] = []
  const unlocks: EvaluationResult['unlocks'] = []
  for (const def of definitions) {
    if (def.eventType !== event.type) continue
    const prev = currentCounts.get(def.id) ?? 0
    if (prev >= def.targetCount) continue
    const current = Math.min(prev + 1 * multiplier, def.targetCount)
    progressUpdates.push({ achievementId: def.id, current, target: def.targetCount })
    if (current >= def.targetCount) unlocks.push({ achievementId: def.id, name: def.name })
  }
  return { progressUpdates, unlocks }
}
