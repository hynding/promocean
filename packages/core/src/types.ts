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
  pointsValue: number
}

export interface TrackedEvent {
  userId: string
  type: string
  occurredAt: Date
}

export interface EvaluationPlan {
  increments: { achievementId: string; name: string; delta: number; target: number }[]
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

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly'

export interface TimedEventDefinition {
  id: string
  name: string
  description: string | null
  startsAt: Date
  endsAt: Date
  endingSoonMinutes: number
  multiplier: number
  enabled: boolean
  recurrence: Recurrence
  /** Occurrences stop once an occurrence's startsAt would no longer be strictly before this
   * instant; null means the recurrence never ends. Ignored when recurrence === 'none'. */
  recurrenceEndsAt: Date | null
}

export interface WebhookEndpointDefinition {
  id: string
  url: string
  secret: string
  enabled: boolean
}

export type PointRules = Record<string, number> // eventType -> points

export interface RewardDefinition {
  id: string
  slug: string
  name: string
  description: string | null
  codeType: 'generated' | 'static'
  staticCode: string | null // populated iff codeType === 'static'
  codePrefix: string | null // generated codes only
  pointsPrice: number // 0 = free
  startsAt: Date | null
  endsAt: Date | null
  perUserLimit: number
  inventory: number | null // null = uncapped
  enabled: boolean
}
