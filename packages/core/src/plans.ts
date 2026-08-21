export type PlanId = 'free' | 'growth' | 'scale' | 'enterprise'

/**
 * Live-MAU included per plan. `null` = no fixed cap (enterprise is custom-contract).
 * Only the `live` environment counts toward a plan's cap — test-environment MAU is
 * always free (the "test/live modes free" DX stance from the design spec).
 */
export const PLANS: Record<PlanId, { mauIncluded: number | null }> = {
  free: { mauIncluded: 1_000 },
  growth: { mauIncluded: 10_000 },
  scale: { mauIncluded: 50_000 },
  enterprise: { mauIncluded: null },
}

export interface UsageEvaluation {
  mauIncluded: number | null
  percentUsed: number | null
  overLimit: boolean
}

/**
 * Pure usage-vs-plan evaluation. `plan === null` means self-hosted/unmetered:
 * no cap, never over limit — enforcement is opt-in by setting a plan, mirroring
 * the registeredEventTypes pattern.
 */
export function evaluateUsage(plan: PlanId | null, liveMau: number): UsageEvaluation {
  // `== null` deliberately: an undefined plan (e.g. an AuthContext built before this field
  // existed) must behave exactly like null — unmetered — not crash the lookup below.
  if (plan == null) return { mauIncluded: null, percentUsed: null, overLimit: false }
  const { mauIncluded } = PLANS[plan]
  if (mauIncluded === null) return { mauIncluded: null, percentUsed: null, overLimit: false }
  return {
    mauIncluded,
    percentUsed: Math.round((liveMau / mauIncluded) * 100),
    overLimit: liveMau > mauIncluded,
  }
}
