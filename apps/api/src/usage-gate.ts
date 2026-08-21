import { evaluateUsage, type AuthContext, type UsageStore } from '@promocean/core'
import { logger } from './logger.js'

export type UsageEnforcementMode = 'off' | 'warn' | 'block'

export type UsageGateResult =
  | { blocked: false; warning: string | null }
  | { blocked: true; mau: number; mauIncluded: number }

/**
 * Pre-ingest plan-limit gate. Deliberately gentle, per the monetization design:
 * - plan unset (self-hosted), test environment, or mode 'off' → zero queries, always passes.
 * - 'warn': over-limit ingests pass but carry an `x-promocean-usage` warning header.
 * - 'block': over-limit ingests are rejected 402 ONLY for users not already active this
 *   month — existing active users are never locked out mid-month.
 * - Any store failure fails open (ingestion availability over enforcement, matching the
 *   config-plane fail-open pattern in the events route).
 */
export async function checkUsageGate(
  usageStore: UsageStore,
  auth: AuthContext,
  userId: string,
  mode: UsageEnforcementMode,
  requestId: string,
): Promise<UsageGateResult> {
  if (mode === 'off' || auth.plan == null || auth.environment !== 'live') {
    return { blocked: false, warning: null }
  }
  try {
    const month = new Date().toISOString().slice(0, 7)
    const scope = { projectId: auth.projectId, environment: auth.environment }
    const { mau } = await usageStore.getUsage(scope, month)
    const evaluated = evaluateUsage(auth.plan, mau)
    if (!evaluated.overLimit || evaluated.mauIncluded === null) {
      return { blocked: false, warning: null }
    }
    if (mode === 'block' && !(await usageStore.isUserActive(scope, month, userId))) {
      return { blocked: true, mau, mauIncluded: evaluated.mauIncluded }
    }
    return { blocked: false, warning: `over-limit; mau=${mau}; included=${evaluated.mauIncluded}` }
  } catch (err) {
    logger.child({ requestId }).warn({ err }, 'usage gate check failed; failing open (no enforcement for this request)')
    return { blocked: false, warning: null }
  }
}
