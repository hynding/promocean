import { describe, expect, it } from 'vitest'
import { PLANS, evaluateUsage } from '../src/plans.js'

describe('evaluateUsage', () => {
  it('null plan (self-hosted) is unmetered: no cap, never over limit', () => {
    expect(evaluateUsage(null, 0)).toEqual({ mauIncluded: null, percentUsed: null, overLimit: false })
    expect(evaluateUsage(null, 10_000_000)).toEqual({ mauIncluded: null, percentUsed: null, overLimit: false })
  })

  it('an undefined plan behaves exactly like null (pre-plan AuthContext safety)', () => {
    expect(evaluateUsage(undefined as unknown as null, 5_000)).toEqual({ mauIncluded: null, percentUsed: null, overLimit: false })
  })

  it('enterprise has no fixed cap', () => {
    expect(evaluateUsage('enterprise', 1_000_000)).toEqual({ mauIncluded: null, percentUsed: null, overLimit: false })
  })

  it('reports usage under the cap without flagging', () => {
    expect(evaluateUsage('free', 500)).toEqual({ mauIncluded: 1_000, percentUsed: 50, overLimit: false })
  })

  it('exactly at the cap is NOT over limit (the included MAU are included)', () => {
    expect(evaluateUsage('free', 1_000)).toEqual({ mauIncluded: 1_000, percentUsed: 100, overLimit: false })
  })

  it('one past the cap is over limit', () => {
    expect(evaluateUsage('free', 1_001)).toEqual({ mauIncluded: 1_000, percentUsed: 100, overLimit: true })
  })

  it('rounds percentUsed to an integer', () => {
    expect(evaluateUsage('growth', 3_333).percentUsed).toBe(33)
    expect(evaluateUsage('growth', 3_350).percentUsed).toBe(34)
  })

  it('plan table matches the published pricing tiers', () => {
    expect(PLANS.free.mauIncluded).toBe(1_000)
    expect(PLANS.growth.mauIncluded).toBe(10_000)
    expect(PLANS.scale.mauIncluded).toBe(50_000)
    expect(PLANS.enterprise.mauIncluded).toBeNull()
  })
})
