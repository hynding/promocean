import { Hono } from 'hono'
import {
  redeemCouponRequestSchema, validateCouponRequestSchema,
  type RedeemCouponResponse, type ValidateCouponResponse,
} from '@promocean/contracts'
import type { RewardDefinition, Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

async function resolveReward(deps: AppDeps, projectId: string, rewardId: string): Promise<RewardDefinition | undefined> {
  const rewards = await deps.configStore.getRewards(projectId)
  return rewards.find((r) => r.id === rewardId)
}

// Type-predicate form so callers get `reward` narrowed to defined in the else branch, not just
// a boolean back — a plain `isExpired(reward, now): boolean` helper can't propagate that.
function isLive(reward: RewardDefinition | undefined, now: Date): reward is RewardDefinition {
  return reward !== undefined && (reward.endsAt === null || now <= reward.endsAt)
}

/**
 * Coupon validate (read-only) and redeem (mutating) endpoints. Both require a secret key —
 * these expose whether/how a code resolves, which a browser-exposed publishable key must not.
 * Expiry (endsAt) is evaluated at request time; a rewardId no longer present in config counts
 * as expired too. Only startsAt gates claiming — redemption never checks it.
 */
export function couponsRoute(deps: AppDeps) {
  const app = new Hono()

  app.post('/validate', async (c) => {
    const auth = c.get('auth')
    if (auth.keyType !== 'secret') {
      return c.json({ error: { code: 'forbidden', message: 'Secret key required.' } }, 403)
    }
    const parsed = validateCouponRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid validate payload.', details: parsed.error.issues } }, 400)
    }
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const hit = await deps.rewardStore.validateCoupon(scope, parsed.data.code)
    if (!hit.found) {
      return c.json({ valid: false, reason: 'not_found' } satisfies ValidateCouponResponse)
    }
    const reward = await resolveReward(deps, scope.projectId, hit.rewardId)
    const rewardSlugIfKnown = reward?.slug
    const now = new Date()
    if (!isLive(reward, now)) {
      return c.json({
        valid: false,
        ...(rewardSlugIfKnown !== undefined ? { rewardSlug: rewardSlugIfKnown } : {}),
        reason: 'expired',
      } satisfies ValidateCouponResponse)
    }
    if (hit.status === 'redeemed') {
      return c.json({
        valid: false, rewardSlug: reward.slug, status: 'redeemed', reason: 'already_redeemed',
      } satisfies ValidateCouponResponse)
    }
    return c.json({ valid: true, rewardSlug: reward.slug, status: 'claimed' } satisfies ValidateCouponResponse)
  })

  app.post('/redeem', async (c) => {
    const auth = c.get('auth')
    if (auth.keyType !== 'secret') {
      return c.json({ error: { code: 'forbidden', message: 'Secret key required.' } }, 403)
    }
    const parsed = redeemCouponRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid redeem payload.', details: parsed.error.issues } }, 400)
    }
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const hit = await deps.rewardStore.validateCoupon(scope, parsed.data.code)
    if (!hit.found) {
      return c.json({ error: { code: 'not_found', message: 'Unknown coupon code.' } }, 404)
    }
    const reward = await resolveReward(deps, scope.projectId, hit.rewardId)
    const now = new Date()
    if (!isLive(reward, now)) {
      return c.json({ error: { code: 'reward_unavailable', message: 'This reward has expired.' } }, 409)
    }
    const result = await deps.rewardStore.redeemCoupon(scope, parsed.data.code)
    if (!result.ok) {
      if (result.reason === 'already_redeemed') {
        return c.json({ error: { code: 'already_redeemed', message: 'This coupon has already been redeemed.' } }, 409)
      }
      // Lost a race with erasure between validateCoupon and redeemCoupon.
      return c.json({ error: { code: 'not_found', message: 'Unknown coupon code.' } }, 404)
    }
    // With shared code text possible across rewards (see the per-project staticCode-uniqueness
    // lifecycle guard), the claim consumed by redeemCoupon can belong to a DIFFERENT reward than
    // the one validateCoupon above happened to resolve for the same code text — so the response's
    // rewardSlug must come from the consumed claim's rewardId, not the pre-resolved `reward`.
    // Fall back to the pre-resolved slug if that id isn't in config (keeps the response schema
    // satisfied; should only happen in the same benign race the 404 branch above already covers).
    const redeemedReward = await resolveReward(deps, scope.projectId, result.rewardId)
    return c.json({
      redeemed: true,
      rewardSlug: redeemedReward?.slug ?? reward.slug,
      redeemedAt: result.redeemedAt.toISOString(),
    } satisfies RedeemCouponResponse)
  })

  return app
}
