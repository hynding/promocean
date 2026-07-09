import type { RewardDefinition } from './types.js'

/** 32-character alphabet for generated coupon codes — excludes 0/O and 1/I to avoid ambiguity. */
export const COUPON_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Maps 10 random bytes to a 10-character coupon code by taking `alphabet[byte % 32]` per byte,
 * with an optional prefix prepended verbatim (`prefix ?? ''`). Sourcing the random bytes is an
 * adapter concern (node:crypto or similar) — this function is pure and deterministic for a
 * fixed byte sequence, which is what makes it independently testable. Throws if `bytes` is not
 * exactly 10 bytes long, since a caller supplying the wrong amount of entropy would silently
 * truncate or waste randomness.
 */
export function couponCodeFromBytes(bytes: Uint8Array, prefix: string | null): string {
  if (bytes.length !== 10) {
    throw new Error(`couponCodeFromBytes requires exactly 10 bytes, got ${bytes.length}`)
  }
  let code = ''
  for (const byte of bytes) code += COUPON_ALPHABET[byte % COUPON_ALPHABET.length]
  return (prefix ?? '') + code
}

export type ClaimRejection = 'reward_unavailable' | 'claim_limit_reached' | 'insufficient_points'

/**
 * Pure claim-eligibility decision for a reward at instant `now`, given pre-fetched counts and
 * balance. This function does not read any store itself — callers (typically inside a locked
 * transaction) are responsible for supplying counts/balance that are consistent with `now`.
 *
 * Checks run in a fixed precedence order and the first failure wins:
 *   1. disabled, or outside the [startsAt, endsAt] window (both bounds inclusive; a null bound
 *      means that side of the window is unconstrained) -> 'reward_unavailable'
 *   2. inventory cap reached (`claimedCount >= inventory`; null inventory is uncapped) ->
 *      'reward_unavailable'
 *   3. per-user limit reached (`userClaimedCount >= perUserLimit`) -> 'claim_limit_reached'
 *   4. insufficient balance (`pointsPrice > balance`) -> 'insufficient_points'
 * A free reward (pointsPrice 0) always clears check 4 regardless of balance. On success,
 * `debit` equals `pointsPrice` (0 for free rewards).
 */
export function decideClaim(input: {
  reward: RewardDefinition
  now: Date
  claimedCount: number
  userClaimedCount: number
  balance: number
}): { ok: true; debit: number } | { ok: false; reason: ClaimRejection } {
  const { reward, now, claimedCount, userClaimedCount, balance } = input

  const beforeStart = reward.startsAt !== null && now < reward.startsAt
  const afterEnd = reward.endsAt !== null && now > reward.endsAt
  if (!reward.enabled || beforeStart || afterEnd) {
    return { ok: false, reason: 'reward_unavailable' }
  }

  if (reward.inventory !== null && claimedCount >= reward.inventory) {
    return { ok: false, reason: 'reward_unavailable' }
  }

  if (userClaimedCount >= reward.perUserLimit) {
    return { ok: false, reason: 'claim_limit_reached' }
  }

  if (reward.pointsPrice > balance) {
    return { ok: false, reason: 'insufficient_points' }
  }

  return { ok: true, debit: reward.pointsPrice }
}
