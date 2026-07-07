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
  allowedOrigins: string[] | null
}

export type OfferAudience = { kind: 'everyone' }

export interface OfferDefinition {
  id: string
  placementSlug: string
  headline: string
  body: string | null
  imageUrl: string | null
  ctaText: string | null
  ctaUrl: string | null
  startsAt: Date | null
  endsAt: Date | null
  priority: number
  audience: OfferAudience
  timedEventId: string | null
}

export type TimedEventState = 'draft' | 'scheduled' | 'live' | 'ending_soon' | 'ended'
export type TimedEventTransition = 'live' | 'ending_soon' | 'ended'

export interface TimedEventDefinition {
  id: string
  name: string
  description: string | null
  startsAt: Date
  endsAt: Date
  endingSoonMinutes: number
  multiplier: number
  enabled: boolean
}

export interface WebhookEndpointDefinition {
  id: string
  url: string
  secret: string
  enabled: boolean
}
