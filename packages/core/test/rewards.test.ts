import { describe, expect, it } from 'vitest'
import { COUPON_ALPHABET, couponCodeFromBytes, decideClaim, type RewardDefinition } from '../src/index.js'

describe('couponCodeFromBytes', () => {
  it('is deterministic for a fixed byte sequence', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(couponCodeFromBytes(bytes, null)).toBe('ABCDEFGHJK')
  })

  it('maps each byte via alphabet[byte % 32], wrapping for bytes >= 32', () => {
    // 255 % 32 === 31 === 31 % 32, so both bytes must map to the same character ('9', index 31)
    const bytes = new Uint8Array([255, 31, 32, 0, 0, 0, 0, 0, 0, 0])
    const code = couponCodeFromBytes(bytes, null)
    expect(code[0]).toBe('9')
    expect(code[1]).toBe('9')
    expect(code[2]).toBe('A') // 32 % 32 === 0
    expect(code[3]).toBe('A')
  })

  it('produces a 10-character code with no prefix', () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(couponCodeFromBytes(bytes, null)).toHaveLength(10)
  })

  it('prepends the prefix verbatim ahead of the 10-character code', () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    const code = couponCodeFromBytes(bytes, 'SUMMER-')
    expect(code.startsWith('SUMMER-')).toBe(true)
    expect(code).toHaveLength('SUMMER-'.length + 10)
  })

  it('treats null prefix as empty string', () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(couponCodeFromBytes(bytes, null)).toBe(couponCodeFromBytes(bytes, ''))
  })

  it('every character of the generated code (minus prefix) is a member of COUPON_ALPHABET', () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, i) => (i * 37 + 13) % 256)
    const code = couponCodeFromBytes(bytes, 'PFX-')
    const generated = code.slice('PFX-'.length)
    expect(generated).toHaveLength(10)
    for (const char of generated) expect(COUPON_ALPHABET.includes(char)).toBe(true)
  })

  it('COUPON_ALPHABET is exactly 32 characters with no 0/O/1/I', () => {
    expect(COUPON_ALPHABET).toHaveLength(32)
    expect(COUPON_ALPHABET).not.toMatch(/[0O1I]/)
  })

  it('throws when given fewer than 10 bytes', () => {
    expect(() => couponCodeFromBytes(new Uint8Array(9), null)).toThrow()
  })

  it('throws when given more than 10 bytes', () => {
    expect(() => couponCodeFromBytes(new Uint8Array(11), null)).toThrow()
  })
})

describe('decideClaim', () => {
  const baseReward: RewardDefinition = {
    id: 'reward-1',
    slug: 'summer-tee',
    name: 'Summer Tee',
    description: null,
    codeType: 'generated',
    staticCode: null,
    codePrefix: null,
    pointsPrice: 100,
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    endsAt: new Date('2026-12-31T23:59:59.000Z'),
    perUserLimit: 2,
    inventory: 10,
    enabled: true,
  }

  const baseInput = {
    reward: baseReward,
    now: new Date('2026-06-01T00:00:00.000Z'),
    claimedCount: 0,
    userClaimedCount: 0,
    balance: 100,
  }

  it('succeeds with debit === pointsPrice when every check passes', () => {
    expect(decideClaim(baseInput)).toEqual({ ok: true, debit: 100 })
  })

  it('rejects reward_unavailable when disabled', () => {
    const result = decideClaim({ ...baseInput, reward: { ...baseReward, enabled: false } })
    expect(result).toEqual({ ok: false, reason: 'reward_unavailable' })
  })

  it('rejects reward_unavailable before startsAt', () => {
    const result = decideClaim({ ...baseInput, now: new Date('2025-12-31T23:59:59.999Z') })
    expect(result).toEqual({ ok: false, reason: 'reward_unavailable' })
  })

  it('accepts at the exact startsAt boundary instant (inclusive)', () => {
    const result = decideClaim({ ...baseInput, now: baseReward.startsAt as Date })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('rejects reward_unavailable after endsAt', () => {
    const result = decideClaim({ ...baseInput, now: new Date('2027-01-01T00:00:00.000Z') })
    expect(result).toEqual({ ok: false, reason: 'reward_unavailable' })
  })

  it('accepts at the exact endsAt boundary instant (inclusive)', () => {
    const result = decideClaim({ ...baseInput, now: baseReward.endsAt as Date })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('rejects reward_unavailable when claimedCount is exactly at inventory', () => {
    const result = decideClaim({ ...baseInput, claimedCount: 10 })
    expect(result).toEqual({ ok: false, reason: 'reward_unavailable' })
  })

  it('accepts when claimedCount is one under inventory', () => {
    const result = decideClaim({ ...baseInput, claimedCount: 9 })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('skips the inventory check entirely when inventory is null (uncapped)', () => {
    const result = decideClaim({ ...baseInput, reward: { ...baseReward, inventory: null }, claimedCount: 1_000_000 })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('rejects claim_limit_reached when userClaimedCount is exactly at perUserLimit', () => {
    const result = decideClaim({ ...baseInput, userClaimedCount: 2 })
    expect(result).toEqual({ ok: false, reason: 'claim_limit_reached' })
  })

  it('accepts when userClaimedCount is one under perUserLimit', () => {
    const result = decideClaim({ ...baseInput, userClaimedCount: 1 })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('accepts when balance is exactly equal to pointsPrice', () => {
    const result = decideClaim({ ...baseInput, balance: 100 })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('rejects insufficient_points when balance is one short of pointsPrice', () => {
    const result = decideClaim({ ...baseInput, balance: 99 })
    expect(result).toEqual({ ok: false, reason: 'insufficient_points' })
  })

  it('accepts a free reward (pointsPrice 0) with balance 0', () => {
    const result = decideClaim({ ...baseInput, reward: { ...baseReward, pointsPrice: 0 }, balance: 0 })
    expect(result).toEqual({ ok: true, debit: 0 })
  })

  it('skips the window check entirely when startsAt and endsAt are both null', () => {
    const result = decideClaim({
      ...baseInput,
      reward: { ...baseReward, startsAt: null, endsAt: null },
      now: new Date('1990-01-01T00:00:00.000Z'),
    })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('skips only the startsAt check when startsAt is null but endsAt is set', () => {
    const result = decideClaim({
      ...baseInput,
      reward: { ...baseReward, startsAt: null },
      now: new Date('1990-01-01T00:00:00.000Z'),
    })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('skips only the endsAt check when endsAt is null but startsAt is set', () => {
    const result = decideClaim({
      ...baseInput,
      reward: { ...baseReward, endsAt: null },
      now: new Date('2099-01-01T00:00:00.000Z'),
    })
    expect(result).toEqual({ ok: true, debit: 100 })
  })

  it('check-order precedence: disabled + out-of-window -> reward_unavailable (not masked by later checks)', () => {
    const result = decideClaim({
      ...baseInput,
      reward: { ...baseReward, enabled: false },
      now: new Date('2027-01-01T00:00:00.000Z'),
      claimedCount: 10,
      userClaimedCount: 2,
      balance: 0,
    })
    expect(result).toEqual({ ok: false, reason: 'reward_unavailable' })
  })

  it('check-order precedence: inventory cap reached wins over claim_limit_reached and insufficient_points', () => {
    const result = decideClaim({
      ...baseInput,
      claimedCount: 10,
      userClaimedCount: 2,
      balance: 0,
    })
    expect(result).toEqual({ ok: false, reason: 'reward_unavailable' })
  })

  it('check-order precedence: claim_limit_reached wins over insufficient_points', () => {
    const result = decideClaim({
      ...baseInput,
      userClaimedCount: 2,
      balance: 0,
    })
    expect(result).toEqual({ ok: false, reason: 'claim_limit_reached' })
  })
})
