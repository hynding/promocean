export type Environment = 'test' | 'live'

export interface Scope {
  projectId: string
  environment: Environment
}

export interface AchievementDefinition {
  id: string
  name: string
  description: string | null
  artworkUrl: string | null
  eventType: string
  targetCount: number
}

export interface TrackedEvent {
  userId: string
  type: string
  occurredAt: Date
}

export interface EvaluationResult {
  progressUpdates: { achievementId: string; current: number; target: number }[]
  unlocks: { achievementId: string; name: string }[]
}

export interface AuthContext {
  projectId: string
  environment: Environment
  keyType: 'publishable' | 'secret'
}
