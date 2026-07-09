import { Hono } from 'hono'
import { claimRewardRequestSchema, type ClaimRewardResponse, type RewardsResponse } from '@promocean/contracts'
import type { ClaimRejection, RewardDefinition, Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

function isWithinWindow(reward: RewardDefinition, now: Date): boolean {
  if (reward.startsAt !== null && now < reward.startsAt) return false
  if (reward.endsAt !== null && now > reward.endsAt) return false
  return true
}

const claimRejectionMessages: Record<ClaimRejection, string> = {
  reward_unavailable: 'This reward is not currently available.',
  claim_limit_reached: 'You have reached the claim limit for this reward.',
  insufficient_points: 'Insufficient points balance to claim this reward.',
}

/**
 * Reward catalog and claim endpoints. GET / filters to enabled + in-window rewards and never
 * surfaces staticCode (the contract schema itself omits the field). POST /:slug/claim only
 * pre-checks config-derived eligibility (existence, enabled, window) — everything
 * count/balance-dependent (inventory cap, per-user limit, points balance) is decided solely by
 * RewardStore.claimCoupon, which re-runs the same decision under locks. No fast-path duplicate
 * of that logic lives here.
 */
export function rewardsRoute(deps: AppDeps) {
  const app = new Hono()

  app.get('/', async (c) => {
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const now = new Date()
    const rewards = (await deps.configStore.getRewards(scope.projectId)).filter((r) => r.enabled)
    const visible = rewards.filter((r) => isWithinWindow(r, now))
    const counts = await deps.rewardStore.getClaimCounts(scope, visible.map((r) => r.id))
    return c.json({
      rewards: visible.map((r) => ({
        slug: r.slug,
        name: r.name,
        description: r.description,
        codeType: r.codeType,
        pointsPrice: r.pointsPrice,
        startsAt: r.startsAt ? r.startsAt.toISOString() : null,
        endsAt: r.endsAt ? r.endsAt.toISOString() : null,
        perUserLimit: r.perUserLimit,
        inventory: r.inventory,
        remaining: r.inventory === null ? null : Math.max(0, r.inventory - (counts.get(r.id) ?? 0)),
      })),
    } satisfies RewardsResponse)
  })

  app.post('/:slug/claim', async (c) => {
    const parsed = claimRewardRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid claim payload.', details: parsed.error.issues } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const slug = c.req.param('slug')
    const rewards = await deps.configStore.getRewards(scope.projectId)
    const reward = rewards.find((r) => r.slug === slug)
    if (!reward) {
      return c.json({ error: { code: 'not_found', message: 'Unknown reward.' } }, 404)
    }
    const now = new Date()
    if (!reward.enabled || !isWithinWindow(reward, now)) {
      return c.json({ error: { code: 'reward_unavailable', message: claimRejectionMessages.reward_unavailable } }, 409)
    }
    const result = await deps.rewardStore.claimCoupon(scope, parsed.data.userId, reward, now)
    if (!result.ok) {
      return c.json({ error: { code: result.reason, message: claimRejectionMessages[result.reason] } }, 409)
    }
    return c.json({
      code: result.code,
      rewardSlug: slug,
      claimedAt: result.claimedAt.toISOString(),
      pointsSpent: result.pointsSpent,
    } satisfies ClaimRewardResponse)
  })

  return app
}
