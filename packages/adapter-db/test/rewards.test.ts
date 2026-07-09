import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgRewardStore, type Db } from '../src/index.js'
import type { RewardDefinition, Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
const scope: Scope = { projectId: 'p1', environment: 'test' }
const otherScope: Scope = { projectId: 'p2', environment: 'test' }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

// ---- helpers ----

let seq = 0
const uniqueId = (p: string) => `${p}-${++seq}`

function reward(overrides: Partial<RewardDefinition> = {}): RewardDefinition {
  return {
    id: uniqueId('rw'),
    slug: 'rw',
    name: 'RW',
    description: null,
    codeType: 'generated',
    staticCode: null,
    codePrefix: 'DEMO-',
    pointsPrice: 0,
    startsAt: null,
    endsAt: null,
    perUserLimit: 1,
    inventory: null,
    enabled: true,
    ...overrides,
  }
}

const couponRows = async (s: Scope, rewardId: string) => {
  const { rows } = await db.$client.query(
    `select id, user_id as "userId", code, code_shared as "codeShared", status,
            claimed_at as "claimedAt", redeemed_at as "redeemedAt"
       from runtime.coupons
      where project_id=$1 and environment=$2 and reward_id=$3
      order by claimed_at asc, id asc`,
    [s.projectId, s.environment, rewardId],
  )
  return rows as Array<{
    id: string; userId: string; code: string; codeShared: boolean; status: string
    claimedAt: Date; redeemedAt: Date | null
  }>
}

const ledgerRows = async (s: Scope, userId: string) => {
  const { rows } = await db.$client.query(
    `select delta, source, source_ref as "sourceRef"
       from runtime.points_ledger
      where project_id=$1 and environment=$2 and user_id=$3
      order by created_at asc`,
    [s.projectId, s.environment, userId],
  )
  return rows as Array<{ delta: number; source: string; sourceRef: string }>
}

const walletBalance = async (s: Scope, userId: string) => {
  const { rows } = await db.$client.query(
    `select coalesce(sum(delta),0)::int as n from runtime.points_ledger
      where project_id=$1 and environment=$2 and user_id=$3`,
    [s.projectId, s.environment, userId],
  )
  return rows[0].n as number
}

const seedBalance = async (s: Scope, userId: string, delta: number) => {
  await db.$client.query(
    `insert into runtime.points_ledger (project_id, environment, user_id, delta, source, source_ref)
     values ($1,$2,$3,$4,'event',$5)`,
    [s.projectId, s.environment, userId, delta, uniqueId('seed')],
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- getClaimCounts ----

describe('PgRewardStore.getClaimCounts', () => {
  it('returns an empty Map without querying for empty input', async () => {
    const store = new PgRewardStore(db)
    const counts = await store.getClaimCounts(scope, [])
    expect(counts.size).toBe(0)
  })

  it('groups claim counts by reward, omitting absent ids', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ perUserLimit: 5, inventory: null })
    await store.claimCoupon(scope, 'gc-a', rw, new Date())
    await store.claimCoupon(scope, 'gc-b', rw, new Date())
    const counts = await store.getClaimCounts(scope, [rw.id, 'never-claimed'])
    expect(counts.get(rw.id)).toBe(2)
    expect(counts.has('never-claimed')).toBe(false)
  })
})

// ---- claim: free static ----

describe('PgRewardStore.claimCoupon — free static', () => {
  it('writes a shared coupon row with the static code and no ledger row', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'static', staticCode: 'FREESHIP', codePrefix: null, pointsPrice: 0 })
    const res = await store.claimCoupon(scope, 'static-u1', rw, new Date())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.pointsSpent).toBe(0)
    expect(res.code).toBe('FREESHIP')

    const rows = await couponRows(scope, rw.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].code).toBe('FREESHIP')
    expect(rows[0].codeShared).toBe(true)
    expect(rows[0].status).toBe('claimed')
    expect(res.couponId).toBe(rows[0].id)

    expect(await ledgerRows(scope, 'static-u1')).toHaveLength(0)
  })
})

describe('PgRewardStore.claimCoupon — misconfigured static reward', () => {
  it('rejects with a descriptive error and writes no coupon row when staticCode is null', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'static', staticCode: null, codePrefix: null, pointsPrice: 0 })
    await expect(store.claimCoupon(scope, 'misconfig-u1', rw, new Date()))
      .rejects.toThrow(`static reward ${rw.id} has no staticCode configured`)
    expect(await couponRows(scope, rw.id)).toHaveLength(0)
  })
})

// ---- claim: priced generated ----

describe('PgRewardStore.claimCoupon — priced generated', () => {
  it('inserts a debit ledger row (sourceRef = coupon id), drops the wallet, and shapes the code', async () => {
    const store = new PgRewardStore(db)
    const userId = 'priced-u1'
    await seedBalance(scope, userId, 250)
    const rw = reward({ codeType: 'generated', codePrefix: 'DEMO-', pointsPrice: 100 })

    const res = await store.claimCoupon(scope, userId, rw, new Date())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.pointsSpent).toBe(100)
    expect(res.code).toMatch(/^DEMO-[A-Z2-9]{10}$/)

    const rows = await couponRows(scope, rw.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].codeShared).toBe(false)
    expect(rows[0].code).toBe(res.code)

    const ledger = await ledgerRows(scope, userId)
    const debit = ledger.find((l) => l.source === 'redemption')
    expect(debit).toBeDefined()
    expect(debit!.delta).toBe(-100)
    expect(debit!.sourceRef).toBe(res.couponId)
    expect(await walletBalance(scope, userId)).toBe(150)
  })
})

// ---- rejection paths write nothing ----

describe('PgRewardStore.claimCoupon — rejections write nothing', () => {
  it('inventory-full writes no coupon and no ledger row', async () => {
    const store = new PgRewardStore(db)
    const userId = 'rej-inv'
    await seedBalance(scope, userId, 1000)
    const rw = reward({ inventory: 0, pointsPrice: 50 })
    const res = await store.claimCoupon(scope, userId, rw, new Date())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('reward_unavailable')
    expect(await couponRows(scope, rw.id)).toHaveLength(0)
    expect(await ledgerRows(scope, userId).then((r) => r.filter((x) => x.source === 'redemption'))).toHaveLength(0)
  })

  it('per-user-limit reached writes no coupon and no ledger row', async () => {
    const store = new PgRewardStore(db)
    const userId = 'rej-lim'
    await seedBalance(scope, userId, 1000)
    const rw = reward({ perUserLimit: 0, pointsPrice: 50 })
    const res = await store.claimCoupon(scope, userId, rw, new Date())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('claim_limit_reached')
    expect(await couponRows(scope, rw.id)).toHaveLength(0)
    expect(await ledgerRows(scope, userId).then((r) => r.filter((x) => x.source === 'redemption'))).toHaveLength(0)
  })

  it('insufficient balance writes no coupon and no ledger row', async () => {
    const store = new PgRewardStore(db)
    const userId = 'rej-bal'
    const rw = reward({ pointsPrice: 100 })
    const res = await store.claimCoupon(scope, userId, rw, new Date())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('insufficient_points')
    expect(await couponRows(scope, rw.id)).toHaveLength(0)
    expect(await ledgerRows(scope, userId)).toHaveLength(0)
  })
})

// ---- concurrency: inventory boundary ----

describe('PgRewardStore.claimCoupon — inventory boundary race', () => {
  it('8 parallel claims against inventory 3 yield exactly 3 rows and 5 reward_unavailable', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ inventory: 3, perUserLimit: 1, pointsPrice: 0 })
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.claimCoupon(scope, `inv-user-${i}`, rw, new Date())),
    )
    const ok = results.filter((r) => r.ok)
    const rejected = results.filter((r) => !r.ok)
    expect(ok).toHaveLength(3)
    expect(rejected).toHaveLength(5)
    expect(rejected.every((r) => !r.ok && r.reason === 'reward_unavailable')).toBe(true)
    expect(await couponRows(scope, rw.id)).toHaveLength(3)
  })
})

// ---- concurrency: balance boundary across two rewards ----

describe('PgRewardStore.claimCoupon — balance boundary race', () => {
  it('4 parallel claims across TWO priced rewards for one user yield exactly one success, wallet >= 0', async () => {
    const store = new PgRewardStore(db)
    const userId = 'bal-race-user'
    await seedBalance(scope, userId, 100)
    const rwA = reward({ codeType: 'generated', codePrefix: 'A-', pointsPrice: 100, perUserLimit: 5 })
    const rwB = reward({ codeType: 'generated', codePrefix: 'B-', pointsPrice: 100, perUserLimit: 5 })

    const results = await Promise.all([
      store.claimCoupon(scope, userId, rwA, new Date()),
      store.claimCoupon(scope, userId, rwA, new Date()),
      store.claimCoupon(scope, userId, rwB, new Date()),
      store.claimCoupon(scope, userId, rwB, new Date()),
    ])
    const ok = results.filter((r) => r.ok)
    expect(ok).toHaveLength(1)
    const balance = await walletBalance(scope, userId)
    expect(balance).toBe(0)
    expect(balance).toBeGreaterThanOrEqual(0)
    const totalCoupons = (await couponRows(scope, rwA.id)).length + (await couponRows(scope, rwB.id)).length
    expect(totalCoupons).toBe(1)
  })
})

// ---- concurrency: per-user-limit ----

describe('PgRewardStore.claimCoupon — per-user-limit race', () => {
  it('4 parallel same-user claims against limit 1 yield exactly one row', async () => {
    const store = new PgRewardStore(db)
    const userId = 'lim-race-user'
    const rw = reward({ perUserLimit: 1, inventory: null, pointsPrice: 0 })
    const results = await Promise.all(
      Array.from({ length: 4 }, () => store.claimCoupon(scope, userId, rw, new Date())),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.reason === 'claim_limit_reached')).toHaveLength(3)
    expect(await couponRows(scope, rw.id)).toHaveLength(1)
  })
})

// ---- generated code uniqueness ----

describe('PgRewardStore.claimCoupon — generated code uniqueness', () => {
  it('generates distinct codes across many claims of the same reward', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'generated', codePrefix: 'UNIQ-', pointsPrice: 0, perUserLimit: 1, inventory: null })
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.claimCoupon(scope, `uniq-user-${i}`, rw, new Date())))
    const rows = await couponRows(scope, rw.id)
    expect(rows).toHaveLength(12)
    const codes = new Set(rows.map((r) => r.code))
    expect(codes.size).toBe(12)
  })
})

// ---- static shared code: N rows for N users ----

describe('PgRewardStore.claimCoupon — static shared code', () => {
  it('inserts N rows sharing one code for N users', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'static', staticCode: 'SHARED10', codePrefix: null, pointsPrice: 0, perUserLimit: 1 })
    await Promise.all(['s1', 's2', 's3'].map((u) => store.claimCoupon(scope, u, rw, new Date())))
    const rows = await couponRows(scope, rw.id)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.code === 'SHARED10')).toBe(true)
    expect(rows.every((r) => r.codeShared === true)).toBe(true)
    expect(new Set(rows.map((r) => r.userId)).size).toBe(3)
  })
})

// ---- validate ----

describe('PgRewardStore.validateCoupon', () => {
  it('returns not found for an unknown code', async () => {
    const store = new PgRewardStore(db)
    expect(await store.validateCoupon(scope, 'NOSUCHCODE')).toEqual({ found: false })
  })

  it('reports a claimed generated coupon as found/claimed', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'generated', codePrefix: 'VAL-', pointsPrice: 0 })
    const res = await store.claimCoupon(scope, 'val-u1', rw, new Date())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(await store.validateCoupon(scope, res.code)).toEqual({ found: true, rewardId: rw.id, status: 'claimed' })
  })

  it('prefers an unredeemed row for a shared code even when another is redeemed', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'static', staticCode: 'VALSHARED', codePrefix: null, pointsPrice: 0, perUserLimit: 1 })
    await store.claimCoupon(scope, 'valshare-a', rw, new Date())
    await sleep(10)
    await store.claimCoupon(scope, 'valshare-b', rw, new Date())
    // redeem one of the two shared claims
    await store.redeemCoupon(scope, 'VALSHARED')
    const v = await store.validateCoupon(scope, 'VALSHARED')
    expect(v).toEqual({ found: true, rewardId: rw.id, status: 'claimed' })
  })
})

// ---- redeem: happy path ----

describe('PgRewardStore.redeemCoupon — happy path', () => {
  it('flips a claimed coupon to redeemed and returns rewardId', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'generated', codePrefix: 'RED-', pointsPrice: 0 })
    const claim = await store.claimCoupon(scope, 'red-u1', rw, new Date())
    expect(claim.ok).toBe(true)
    if (!claim.ok) return
    const res = await store.redeemCoupon(scope, claim.code)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rewardId).toBe(rw.id)
    expect(res.redeemedAt).toBeInstanceOf(Date)

    const rows = await couponRows(scope, rw.id)
    expect(rows[0].status).toBe('redeemed')
    expect(rows[0].redeemedAt).not.toBeNull()

    // redeeming again is already_redeemed
    const again = await store.redeemCoupon(scope, claim.code)
    expect(again).toEqual({ ok: false, reason: 'already_redeemed' })
  })

  it('returns not_found for an unknown code', async () => {
    const store = new PgRewardStore(db)
    expect(await store.redeemCoupon(scope, 'GHOSTCODE')).toEqual({ ok: false, reason: 'not_found' })
  })
})

// ---- redeem: parallel single generated code ----

describe('PgRewardStore.redeemCoupon — parallel single code', () => {
  it('parallel redeems of one generated code yield exactly one success and one already_redeemed', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'generated', codePrefix: 'PAR-', pointsPrice: 0 })
    const claim = await store.claimCoupon(scope, 'par-u1', rw, new Date())
    expect(claim.ok).toBe(true)
    if (!claim.ok) return
    const [a, b] = await Promise.all([
      store.redeemCoupon(scope, claim.code),
      store.redeemCoupon(scope, claim.code),
    ])
    const oks = [a, b].filter((r) => r.ok)
    const already = [a, b].filter((r) => !r.ok && r.reason === 'already_redeemed')
    expect(oks).toHaveLength(1)
    expect(already).toHaveLength(1)
  })
})

// ---- redeem: two users, one static code, SKIP LOCKED ----

describe('PgRewardStore.redeemCoupon — shared code SKIP LOCKED', () => {
  it('parallel redeems of one shared code consume distinct claims and both succeed', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'static', staticCode: 'SKIPLOCK', codePrefix: null, pointsPrice: 0, perUserLimit: 1 })
    await store.claimCoupon(scope, 'skip-a', rw, new Date())
    await sleep(10)
    await store.claimCoupon(scope, 'skip-b', rw, new Date())
    const [a, b] = await Promise.all([
      store.redeemCoupon(scope, 'SKIPLOCK'),
      store.redeemCoupon(scope, 'SKIPLOCK'),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const rows = await couponRows(scope, rw.id)
    expect(rows.filter((r) => r.status === 'redeemed')).toHaveLength(2)
  })
})

// ---- redeem: oldest-first consumption ----

describe('PgRewardStore.redeemCoupon — oldest-first', () => {
  it('redeeming a shared code once flips the earlier-claimed row', async () => {
    const store = new PgRewardStore(db)
    const rw = reward({ codeType: 'static', staticCode: 'OLDEST1', codePrefix: null, pointsPrice: 0, perUserLimit: 1 })
    await store.claimCoupon(scope, 'old-a', rw, new Date())
    await sleep(15)
    await store.claimCoupon(scope, 'old-b', rw, new Date())
    await store.redeemCoupon(scope, 'OLDEST1')
    const rows = await couponRows(scope, rw.id) // ordered by claimed_at asc
    expect(rows).toHaveLength(2)
    expect(rows[0].status).toBe('redeemed') // earliest claimed
    expect(rows[1].status).toBe('claimed')
  })
})

// ---- cross-tenant isolation ----

describe('PgRewardStore — cross-tenant isolation', () => {
  it('the same code text in two scopes is isolated for validate and redeem', async () => {
    const store = new PgRewardStore(db)
    const rwP1 = reward({ codeType: 'static', staticCode: 'XTEN', codePrefix: null, pointsPrice: 0 })
    const rwP2 = reward({ codeType: 'static', staticCode: 'XTEN', codePrefix: null, pointsPrice: 0 })
    await store.claimCoupon(scope, 'xt-1', rwP1, new Date())
    await store.claimCoupon(otherScope, 'xt-2', rwP2, new Date())

    // redeem in p1 does not affect p2
    await store.redeemCoupon(scope, 'XTEN')
    expect(await store.validateCoupon(scope, 'XTEN')).toEqual({ found: true, rewardId: rwP1.id, status: 'redeemed' })
    expect(await store.validateCoupon(otherScope, 'XTEN')).toEqual({ found: true, rewardId: rwP2.id, status: 'claimed' })
  })
})
