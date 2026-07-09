import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgBackfillStore, PgEngagementStore, PgIngestionStore, type Db } from '../src/index.js'
import type { AchievementDefinition, EngagementWrite, Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
let backfill: PgBackfillStore
let ingest: PgIngestionStore

const scope: Scope = { projectId: 'p1', environment: 'test' }
const noEngagement: EngagementWrite = { localDay: '2026-07-01', eventPoints: null, unlockPoints: {} }

const makeDef = (over: Partial<AchievementDefinition> & Pick<AchievementDefinition, 'id' | 'eventType'>): AchievementDefinition => ({
  name: over.id,
  description: null,
  artworkUrl: null,
  targetCount: 3,
  pointsValue: 0,
  ...over,
})

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
  backfill = new PgBackfillStore(db)
  ingest = new PgIngestionStore(db)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

// Ingest n events of `type` for `userId` with NO matching increment — the definition "doesn't
// exist yet", so events land but no progress/unlock/ledger row is written.
async function ingestBareEvents(s: Scope, userId: string, type: string, n: number, keyPrefix: string) {
  for (let i = 0; i < n; i++) {
    await ingest.ingestEvent(s, { userId, type, idempotencyKey: `${keyPrefix}-${i}`, occurredAt: new Date() }, [], '2026-07', noEngagement)
  }
}

const progressCurrent = async (s: Scope, userId: string, achievementId: string) => {
  const { rows } = await db.$client.query(
    `select current from runtime.achievement_progress where project_id=$1 and environment=$2 and user_id=$3 and achievement_id=$4`,
    [s.projectId, s.environment, userId, achievementId],
  )
  return rows[0]?.current as number | undefined
}
const unlockCount = async (s: Scope, userId: string, achievementId: string) => {
  const { rows } = await db.$client.query(
    `select count(*)::int as n from runtime.unlocks where project_id=$1 and environment=$2 and user_id=$3 and achievement_id=$4`,
    [s.projectId, s.environment, userId, achievementId],
  )
  return rows[0].n as number
}
const bonusLedgerCount = async (s: Scope, userId: string, sourceRef: string) => {
  const { rows } = await db.$client.query(
    `select count(*)::int as n from runtime.points_ledger where project_id=$1 and environment=$2 and user_id=$3 and source='unlock' and source_ref=$4`,
    [s.projectId, s.environment, userId, sourceRef],
  )
  return rows[0].n as number
}
const totalLedgerRows = async (s: Scope) => {
  const { rows } = await db.$client.query(
    `select count(*)::int as n from runtime.points_ledger where project_id=$1 and environment=$2`,
    [s.projectId, s.environment],
  )
  return rows[0].n as number
}

describe('PgBackfillStore.backfillAchievement', () => {
  it('true retroactivity: events stored before the definition existed count toward it', async () => {
    // userA: 4 stored events -> crosses target 3 -> unlock + bonus. userB: 2 -> progress only.
    await ingestBareEvents(scope, 'ret-A', 'ret_lesson', 4, 'retA')
    await ingestBareEvents(scope, 'ret-B', 'ret_lesson', 2, 'retB')
    const def = makeDef({ id: 'ret-ach', eventType: 'ret_lesson', targetCount: 3, pointsValue: 50 })

    const summary = await backfill.backfillAchievement(scope, def)
    expect(summary).toEqual({ usersEvaluated: 2, progressRaised: 2, unlocksGranted: 1, pointsAwarded: 50 })

    expect(await progressCurrent(scope, 'ret-A', 'ret-ach')).toBe(3) // clamped at target
    expect(await progressCurrent(scope, 'ret-B', 'ret-ach')).toBe(2)
    expect(await unlockCount(scope, 'ret-A', 'ret-ach')).toBe(1)
    expect(await unlockCount(scope, 'ret-B', 'ret-ach')).toBe(0)
    expect(await bonusLedgerCount(scope, 'ret-A', 'ret-ach')).toBe(1)

    // Wallet SUM reflects the retroactive bonus.
    const wallet = await new PgEngagementStore(db).getWallet(scope, 'ret-A')
    expect(wallet.balance).toBe(50)
  })

  it('idempotent re-run: zero deltas and the ledger row count is unchanged', async () => {
    const def = makeDef({ id: 'ret-ach', eventType: 'ret_lesson', targetCount: 3, pointsValue: 50 })
    const ledgerBefore = await totalLedgerRows(scope)

    const summary = await backfill.backfillAchievement(scope, def)
    // usersEvaluated still reflects the population; every DELTA is zero.
    expect(summary.progressRaised).toBe(0)
    expect(summary.unlocksGranted).toBe(0)
    expect(summary.pointsAwarded).toBe(0)

    expect(await totalLedgerRows(scope)).toBe(ledgerBefore) // no second bonus
    expect(await unlockCount(scope, 'ret-A', 'ret-ach')).toBe(1)
  })

  it('GREATEST never lowers pre-existing (multiplier-inflated) progress', async () => {
    // Live progress is 8 (inflated by a multiplier) but only 3 raw events are stored; target 10.
    await ingestBareEvents(scope, 'gr-U', 'gr_type', 3, 'grU')
    await db.$client.query(
      `insert into runtime.achievement_progress (project_id, environment, user_id, achievement_id, current) values ($1,$2,'gr-U','gr-ach',8)`,
      [scope.projectId, scope.environment],
    )
    const def = makeDef({ id: 'gr-ach', eventType: 'gr_type', targetCount: 10, pointsValue: 100 })

    const summary = await backfill.backfillAchievement(scope, def)
    expect(summary.progressRaised).toBe(0)
    expect(summary.unlocksGranted).toBe(0)
    expect(await progressCurrent(scope, 'gr-U', 'gr-ach')).toBe(8) // stays 8, not lowered to 3
  })

  it('bonus gating: an already-live-unlocked user gets no second unlock or bonus', async () => {
    await ingestBareEvents(scope, 'bg-U', 'bg_type', 5, 'bgU')
    const def = makeDef({ id: 'bg-ach', eventType: 'bg_type', targetCount: 3, pointsValue: 40 })
    // Simulate the live-ingest path having already unlocked + awarded the bonus.
    await db.$client.query(
      `insert into runtime.achievement_progress (project_id, environment, user_id, achievement_id, current) values ($1,$2,'bg-U','bg-ach',3)`,
      [scope.projectId, scope.environment],
    )
    await db.$client.query(
      `insert into runtime.unlocks (project_id, environment, user_id, achievement_id, unlocked_at) values ($1,$2,'bg-U','bg-ach',now())`,
      [scope.projectId, scope.environment],
    )
    await db.$client.query(
      `insert into runtime.points_ledger (project_id, environment, user_id, delta, source, source_ref) values ($1,$2,'bg-U',40,'unlock','bg-ach')`,
      [scope.projectId, scope.environment],
    )

    const summary = await backfill.backfillAchievement(scope, def)
    expect(summary.progressRaised).toBe(0)
    expect(summary.unlocksGranted).toBe(0)
    expect(summary.pointsAwarded).toBe(0)
    expect(await unlockCount(scope, 'bg-U', 'bg-ach')).toBe(1) // still exactly one
    expect(await bonusLedgerCount(scope, 'bg-U', 'bg-ach')).toBe(1) // no second bonus
  })

  it('live-ingest race: concurrent backfill + crossing ingest yield exactly one unlock and one bonus', async () => {
    // userR sits at progress 2 (target 3) from 2 stored events; a live ingest crosses to 3 at the
    // same moment a backfill runs. Only one of them may insert the unlock / write the bonus.
    await ingestBareEvents(scope, 'race-U', 'race_type', 2, 'raceU')
    await db.$client.query(
      `insert into runtime.achievement_progress (project_id, environment, user_id, achievement_id, current) values ($1,$2,'race-U','race-ach',2)`,
      [scope.projectId, scope.environment],
    )
    const def = makeDef({ id: 'race-ach', eventType: 'race_type', targetCount: 3, pointsValue: 70 })

    await Promise.all([
      backfill.backfillAchievement(scope, def),
      ingest.ingestEvent(
        scope,
        { userId: 'race-U', type: 'race_type', idempotencyKey: 'race-cross', occurredAt: new Date() },
        [{ achievementId: 'race-ach', delta: 1, target: 3 }],
        '2026-07',
        { localDay: '2026-07-01', eventPoints: null, unlockPoints: { 'race-ach': 70 } },
      ),
    ])

    expect(await unlockCount(scope, 'race-U', 'race-ach')).toBe(1)
    expect(await bonusLedgerCount(scope, 'race-U', 'race-ach')).toBe(1)
    expect(await progressCurrent(scope, 'race-U', 'race-ach')).toBe(3)
  })

  it('zero-event type: all-zero summary with no writes', async () => {
    const def = makeDef({ id: 'ze-ach', eventType: 'no_such_type', targetCount: 3, pointsValue: 10 })
    const summary = await backfill.backfillAchievement(scope, def)
    expect(summary).toEqual({ usersEvaluated: 0, progressRaised: 0, unlocksGranted: 0, pointsAwarded: 0 })
    const { rows } = await db.$client.query(
      `select count(*)::int as n from runtime.achievement_progress where project_id=$1 and environment=$2 and achievement_id='ze-ach'`,
      [scope.projectId, scope.environment],
    )
    expect(rows[0].n).toBe(0)
  })

  it('pointsValue 0: unlocks granted but no ledger rows written', async () => {
    await ingestBareEvents(scope, 'zp-U', 'zp_type', 3, 'zpU')
    const def = makeDef({ id: 'zp-ach', eventType: 'zp_type', targetCount: 3, pointsValue: 0 })

    const summary = await backfill.backfillAchievement(scope, def)
    expect(summary.unlocksGranted).toBe(1)
    expect(summary.pointsAwarded).toBe(0)
    expect(await unlockCount(scope, 'zp-U', 'zp-ach')).toBe(1)
    expect(await bonusLedgerCount(scope, 'zp-U', 'zp-ach')).toBe(0)
  })

  it('cross-tenant isolation: a backfill sees only its own tenant\'s events', async () => {
    const p2: Scope = { projectId: 'p2-iso', environment: 'test' }
    // Events for this type exist only under `scope` (p1), not p2.
    await ingestBareEvents(scope, 'iso-U', 'iso_type', 4, 'isoU')
    const def = makeDef({ id: 'iso-ach', eventType: 'iso_type', targetCount: 3, pointsValue: 25 })

    const p2Summary = await backfill.backfillAchievement(p2, def)
    expect(p2Summary).toEqual({ usersEvaluated: 0, progressRaised: 0, unlocksGranted: 0, pointsAwarded: 0 })
    expect(await unlockCount(p2, 'iso-U', 'iso-ach')).toBe(0)

    // p1's own backfill still works and is unaffected by the p2 run.
    const p1Summary = await backfill.backfillAchievement(scope, def)
    expect(p1Summary).toEqual({ usersEvaluated: 1, progressRaised: 1, unlocksGranted: 1, pointsAwarded: 25 })
  })
})
