import { describe, expect, it } from 'vitest'
import type { AuthContext, RewardDefinition } from '@promocean/core'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }

function pkAuth(): AuthContext { return { projectId: 'p1', environment: 'test', keyType: 'publishable', allowedOrigins: null } }
function skAuth(): AuthContext { return { projectId: 'p1', environment: 'test', keyType: 'secret', allowedOrigins: null } }

function reward(overrides: Partial<RewardDefinition> = {}): RewardDefinition {
  return {
    id: 'r1', slug: 'sticker-pack', name: 'Sticker Pack', description: 'A pack of stickers.',
    codeType: 'static', staticCode: 'TOP-SECRET-STATIC-CODE', codePrefix: null, pointsPrice: 100,
    startsAt: null, endsAt: null, perUserLimit: 1, inventory: 10, enabled: true,
    ...overrides,
  }
}

function setup(auth: AuthContext, rewards: RewardDefinition[] = []) {
  const fakes = makeFakes([], auth, [], [], [], {}, rewards)
  return { app: createApp(fakes, { rateLimitPerMinute: 0 }), fakes }
}

describe('GET /v1/rewards', () => {
  it('returns catalog shape with remaining math (capped) and null-inventory passthrough (uncapped)', async () => {
    const capped = reward({ id: 'r1', slug: 'capped', inventory: 10 })
    const uncapped = reward({ id: 'r2', slug: 'uncapped', inventory: null })
    const { app, fakes } = setup(pkAuth(), [capped, uncapped])
    fakes.setClaimCounts(new Map([['r1', 3]]))
    const res = await app.request('/v1/rewards', { headers })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.rewards).toHaveLength(2)
    const cappedOut = json.rewards.find((r: { slug: string }) => r.slug === 'capped')
    const uncappedOut = json.rewards.find((r: { slug: string }) => r.slug === 'uncapped')
    expect(cappedOut.remaining).toBe(7)
    expect(cappedOut.inventory).toBe(10)
    expect(uncappedOut.remaining).toBeNull()
    expect(uncappedOut.inventory).toBeNull()
  })

  it('never includes staticCode on any catalog entry', async () => {
    const r = reward({ codeType: 'static', staticCode: 'TOP-SECRET-STATIC-CODE' })
    const { app } = setup(pkAuth(), [r])
    const res = await app.request('/v1/rewards', { headers })
    const json = await res.json()
    for (const entry of json.rewards) {
      expect(entry).not.toHaveProperty('staticCode')
    }
    expect(JSON.stringify(json)).not.toContain('TOP-SECRET-STATIC-CODE')
  })

  it('filters out disabled rewards', async () => {
    const disabled = reward({ slug: 'disabled-reward', enabled: false })
    const { app } = setup(pkAuth(), [disabled])
    const res = await app.request('/v1/rewards', { headers })
    const json = await res.json()
    expect(json.rewards).toEqual([])
  })

  it('filters out rewards outside their claim window (future start, past end)', async () => {
    const future = reward({ slug: 'future-reward', startsAt: new Date(Date.now() + 60_000) })
    const past = reward({ slug: 'past-reward', endsAt: new Date(Date.now() - 60_000) })
    const { app } = setup(pkAuth(), [future, past])
    const res = await app.request('/v1/rewards', { headers })
    const json = await res.json()
    expect(json.rewards).toEqual([])
  })
})

describe('POST /v1/rewards/:slug/claim', () => {
  it('happy path maps the store result to ClaimRewardResponse', async () => {
    const r = reward({ slug: 'sticker-pack' })
    const { app, fakes } = setup(pkAuth(), [r])
    const claimedAt = new Date('2026-01-01T00:00:00.000Z')
    fakes.setClaimResult({ ok: true, couponId: 'c1', code: 'ABC123XYZ0', claimedAt, pointsSpent: 100 })
    const res = await app.request('/v1/rewards/sticker-pack/claim', {
      method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ code: 'ABC123XYZ0', rewardSlug: 'sticker-pack', claimedAt: claimedAt.toISOString(), pointsSpent: 100 })
    expect(fakes.claimCalls).toHaveLength(1)
    expect(fakes.claimCalls[0]!.userId).toBe('u1')
    expect(fakes.claimCalls[0]!.reward.slug).toBe('sticker-pack')
  })

  for (const reason of ['reward_unavailable', 'claim_limit_reached', 'insufficient_points'] as const) {
    it(`maps store rejection reason "${reason}" to 409 with matching error code`, async () => {
      const r = reward({ slug: 'sticker-pack' })
      const { app, fakes } = setup(pkAuth(), [r])
      fakes.setClaimResult({ ok: false, reason })
      const res = await app.request('/v1/rewards/sticker-pack/claim', {
        method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }),
      })
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe(reason)
    })
  }

  it('rejects an oversized userId (400 invalid_payload)', async () => {
    const r = reward({ slug: 'sticker-pack' })
    const { app } = setup(pkAuth(), [r])
    const res = await app.request('/v1/rewards/sticker-pack/claim', {
      method: 'POST', headers, body: JSON.stringify({ userId: 'x'.repeat(129) }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('rejects an empty userId (400 invalid_payload)', async () => {
    const r = reward({ slug: 'sticker-pack' })
    const { app } = setup(pkAuth(), [r])
    const res = await app.request('/v1/rewards/sticker-pack/claim', {
      method: 'POST', headers, body: JSON.stringify({ userId: '' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })

  it('unknown slug -> 404 not_found', async () => {
    const { app } = setup(pkAuth(), [])
    const res = await app.request('/v1/rewards/ghost-slug/claim', {
      method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  it('disabled reward -> 409 reward_unavailable without calling the store', async () => {
    const r = reward({ slug: 'sticker-pack', enabled: false })
    const { app, fakes } = setup(pkAuth(), [r])
    const res = await app.request('/v1/rewards/sticker-pack/claim', {
      method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('reward_unavailable')
    expect(fakes.claimCalls).toEqual([])
  })

  it('out-of-window reward -> 409 reward_unavailable without calling the store', async () => {
    const r = reward({ slug: 'sticker-pack', endsAt: new Date(Date.now() - 60_000) })
    const { app, fakes } = setup(pkAuth(), [r])
    const res = await app.request('/v1/rewards/sticker-pack/claim', {
      method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('reward_unavailable')
    expect(fakes.claimCalls).toEqual([])
  })
})

describe('POST /v1/coupons/validate', () => {
  it('publishable key -> 403 forbidden', async () => {
    const { app } = setup(pkAuth())
    const res = await app.request('/v1/coupons/validate', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  it('unknown code -> 200 { valid: false, reason: "not_found" }', async () => {
    const { app, fakes } = setup(skAuth())
    fakes.setValidateResult({ found: false })
    const res = await app.request('/v1/coupons/validate', {
      method: 'POST', headers, body: JSON.stringify({ code: 'GHOST00000' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: false, reason: 'not_found' })
  })

  it('valid unredeemed coupon -> 200 { valid: true, status: "claimed" }', async () => {
    const r = reward({ id: 'r1', slug: 'sticker-pack' })
    const { app, fakes } = setup(skAuth(), [r])
    fakes.setValidateResult({ found: true, rewardId: 'r1', status: 'claimed' })
    const res = await app.request('/v1/coupons/validate', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: true, rewardSlug: 'sticker-pack', status: 'claimed' })
  })

  it('already-redeemed coupon -> 200 { valid: false, reason: "already_redeemed" }', async () => {
    const r = reward({ id: 'r1', slug: 'sticker-pack' })
    const { app, fakes } = setup(skAuth(), [r])
    fakes.setValidateResult({ found: true, rewardId: 'r1', status: 'redeemed' })
    const res = await app.request('/v1/coupons/validate', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: false, rewardSlug: 'sticker-pack', status: 'redeemed', reason: 'already_redeemed' })
  })

  it('expired via past endsAt -> 200 { valid: false, reason: "expired" } with rewardSlug present', async () => {
    const r = reward({ id: 'r1', slug: 'sticker-pack', endsAt: new Date(Date.now() - 60_000) })
    const { app, fakes } = setup(skAuth(), [r])
    fakes.setValidateResult({ found: true, rewardId: 'r1', status: 'claimed' })
    const res = await app.request('/v1/coupons/validate', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: false, rewardSlug: 'sticker-pack', reason: 'expired' })
  })

  it('expired via reward missing from config -> 200 { valid: false, reason: "expired" } without rewardSlug', async () => {
    const { app, fakes } = setup(skAuth(), [])
    fakes.setValidateResult({ found: true, rewardId: 'ghost-reward-id', status: 'claimed' })
    const res = await app.request('/v1/coupons/validate', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: false, reason: 'expired' })
  })

  it('rejects an oversized code (400 invalid_payload)', async () => {
    const { app } = setup(skAuth())
    const res = await app.request('/v1/coupons/validate', {
      method: 'POST', headers, body: JSON.stringify({ code: 'x'.repeat(65) }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })
})

describe('POST /v1/coupons/redeem', () => {
  it('publishable key -> 403 forbidden', async () => {
    const { app } = setup(pkAuth())
    const res = await app.request('/v1/coupons/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  it('unknown code -> 404 not_found', async () => {
    const { app, fakes } = setup(skAuth())
    fakes.setValidateResult({ found: false })
    const res = await app.request('/v1/coupons/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'GHOST00000' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  it('reward missing from config -> 409 reward_unavailable', async () => {
    const { app, fakes } = setup(skAuth(), [])
    fakes.setValidateResult({ found: true, rewardId: 'ghost-reward-id', status: 'claimed' })
    const res = await app.request('/v1/coupons/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('reward_unavailable')
  })

  it('expired via past endsAt -> 409 reward_unavailable', async () => {
    const r = reward({ id: 'r1', slug: 'sticker-pack', endsAt: new Date(Date.now() - 60_000) })
    const { app, fakes } = setup(skAuth(), [r])
    fakes.setValidateResult({ found: true, rewardId: 'r1', status: 'claimed' })
    const res = await app.request('/v1/coupons/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('reward_unavailable')
  })

  it('happy path -> 200 { redeemed: true }', async () => {
    const r = reward({ id: 'r1', slug: 'sticker-pack' })
    const { app, fakes } = setup(skAuth(), [r])
    fakes.setValidateResult({ found: true, rewardId: 'r1', status: 'claimed' })
    const redeemedAt = new Date('2026-01-01T00:00:00.000Z')
    fakes.setRedeemResult({ ok: true, rewardId: 'r1', redeemedAt })
    const res = await app.request('/v1/coupons/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ redeemed: true, rewardSlug: 'sticker-pack', redeemedAt: redeemedAt.toISOString() })
  })

  it('store reports already_redeemed -> 409 already_redeemed', async () => {
    const r = reward({ id: 'r1', slug: 'sticker-pack' })
    const { app, fakes } = setup(skAuth(), [r])
    fakes.setValidateResult({ found: true, rewardId: 'r1', status: 'claimed' })
    fakes.setRedeemResult({ ok: false, reason: 'already_redeemed' })
    const res = await app.request('/v1/coupons/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('already_redeemed')
  })

  it('store reports not_found (race-shaped: lost a race with erasure) -> 404 not_found', async () => {
    const r = reward({ id: 'r1', slug: 'sticker-pack' })
    const { app, fakes } = setup(skAuth(), [r])
    fakes.setValidateResult({ found: true, rewardId: 'r1', status: 'claimed' })
    fakes.setRedeemResult({ ok: false, reason: 'not_found' })
    const res = await app.request('/v1/coupons/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'ABC123XYZ0' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  it('rejects an oversized code (400 invalid_payload)', async () => {
    const { app } = setup(skAuth())
    const res = await app.request('/v1/coupons/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'x'.repeat(65) }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })
})
