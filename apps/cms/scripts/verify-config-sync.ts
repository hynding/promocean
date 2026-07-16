/**
 * Durable, checked-in verification script for the config-plane import endpoint
 * and its plan/prune/dry-run/recompute semantics (Sprint 11 Task 4).
 *
 * Boots a standalone Strapi instance the same way `strapi console` does
 * (compileStrapi -> createStrapi(...).load()) against the configured
 * DATABASE_URL — resolved the same way Strapi itself resolves it (env var, or
 * apps/cms/.env; dev Postgres on 5433 by default). There is no hardcoded
 * fallback: if DATABASE_URL can't be resolved at all, the script refuses to
 * run rather than guess. Every scenario writes disposable fixture rows (a
 * throwaway project per scenario, cleaned up in a finally), so the script
 * refuses to run against a DATABASE_URL whose host isn't localhost/127.0.0.1
 * unless `--allow-remote` is passed. Also brings the HTTP server up (on
 * VERIFY_PORT, default 18338, to avoid colliding with a dev `strapi develop`
 * on 1337 or verify-lifecycles on 18337) so scenarios hit the REAL controller
 * (export + import) over HTTP rather than a reimplementation.
 *
 * Eight named scenarios (each a hard finding + non-zero exit on failure):
 *   1. round-trip invariant — populate a project, export it, re-import: every
 *      plan bucket empty except unchanged.
 *   2. create+update+unchanged — one file mixes all three; assert exact slug
 *      lists (+ a positive control so the diff can't vacuously pass).
 *   3. registeredEventTypes order-insensitivity — a reordered array is
 *      unchanged; a genuinely different set is a positive-control update.
 *   4. prune only-with-flag AND only-covered-types — an absent slug survives
 *      without prune, is deleted with it; a seeded webhook endpoint (uncovered
 *      type) survives a prune.
 *   5. dry-run plan deep-equals the subsequent apply's plan, and dry-run
 *      writes NOTHING (row counts before == after).
 *   6. unknown-ref 400 before any write — offer references a ghost placement;
 *      400 with the right details, and row counts are unchanged.
 *   7. mid-run 422 — a static reward with staticCode:null trips the S8
 *      lifecycle; assert 422, stage rewards/<slug>, earlier types genuinely
 *      applied, later types absent, and the RECOMPUTED plan matches DB state.
 *   8. update-in-place preserves documentId (capture before/after).
 *
 * Usage:
 *   pnpm --filter cms verify:config-sync
 *   DATABASE_URL=postgres://... pnpm --filter cms verify:config-sync
 *
 * Exit code is non-zero if any scenario reports a finding.
 */

import path from 'node:path'
import assert from 'node:assert'

const ALLOW_REMOTE = process.argv.includes('--allow-remote')
const VERIFY_PORT = process.env.VERIFY_PORT ?? '18338'
process.env.PORT = VERIFY_PORT
// This script manages its own fixtures; demo seeding would just be noise.
process.env.SEED_DEMO = 'false'

type Finding = { scenario: string; message: string }
const findings: Finding[] = []

function finding(scenario: string, message: string) {
  findings.push({ scenario, message })
  console.log(`[verify-config-sync] FINDING (${scenario}): ${message}`)
}
function ok(message: string) {
  console.log(`[verify-config-sync] ok: ${message}`)
}
function truthy(scenario: string, cond: boolean, label: string) {
  if (cond) ok(label)
  else finding(scenario, label)
}
function eq(scenario: string, actual: unknown, expected: unknown, label: string) {
  try {
    assert.deepStrictEqual(actual, expected)
    ok(label)
  } catch {
    finding(scenario, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// --- blast-radius guard ------------------------------------------------------

function assertLocalDatabase(databaseUrl: string) {
  let host: string
  try {
    host = new URL(databaseUrl).hostname
  } catch (e: any) {
    console.error(`[verify-config-sync] refusing to run: DATABASE_URL is not a parseable URL (${e.message})`)
    process.exit(1)
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (isLocal || ALLOW_REMOTE) return
  console.error(
    `[verify-config-sync] refusing to run: DATABASE_URL host "${host}" is not localhost/127.0.0.1. ` +
      'This script writes disposable fixture rows to the target database. Re-run against a ' +
      'local/disposable database, or pass --allow-remote if you really intend to target this host.',
  )
  process.exit(1)
}

// --- HTTP helpers ------------------------------------------------------------

let SECRET = ''

async function importFile(
  projectId: string,
  file: any,
  opts: { prune?: boolean; dryRun?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${VERIFY_PORT}/api/config-plane/projects/${projectId}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-config-secret': SECRET },
    body: JSON.stringify({ file, prune: opts.prune ?? false, dryRun: opts.dryRun ?? false }),
  })
  return { status: res.status, body: await res.json() }
}

async function exportFile(projectId: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${VERIFY_PORT}/api/config-plane/projects/${projectId}/export`, {
    headers: { 'x-config-secret': SECRET },
  })
  if (!res.ok) throw new Error(`export responded ${res.status}`)
  return res.json()
}

// --- file builders -----------------------------------------------------------

const T_START = '2026-08-01T00:00:00.000Z'
const T_END = '2026-08-02T00:00:00.000Z'

function buildFile(overrides: Record<string, any> = {}): any {
  return {
    formatVersion: 1,
    project: { pointRules: {}, registeredEventTypes: [], allowedOrigins: null },
    placements: [],
    achievements: [],
    timedEvents: [],
    offers: [],
    rewards: [],
    ...overrides,
  }
}
function fPlacement(slug: string, name: string) {
  return { slug, name }
}
function fAchievement(slug: string, name: string, over: Record<string, any> = {}) {
  return { slug, name, description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1, pointsValue: 0, ...over }
}
function fTimedEvent(slug: string, name: string, over: Record<string, any> = {}) {
  return {
    slug,
    name,
    description: null,
    startsAt: T_START,
    endsAt: T_END,
    endingSoonMinutes: 1440,
    multiplier: 1,
    recurrence: 'none',
    recurrenceEndsAt: null,
    enabled: true,
    ...over,
  }
}
function fOffer(slug: string, name: string, placement: string, over: Record<string, any> = {}) {
  return {
    slug,
    name,
    headline: name,
    body: null,
    imageUrl: null,
    ctaText: null,
    ctaUrl: null,
    startsAt: null,
    endsAt: null,
    priority: 0,
    placement,
    timedEvent: null,
    ...over,
  }
}
function fReward(slug: string, name: string, over: Record<string, any> = {}) {
  return {
    slug,
    name,
    description: null,
    codeType: 'generated',
    staticCode: null,
    codePrefix: null,
    pointsPrice: 0,
    startsAt: null,
    endsAt: null,
    perUserLimit: 1,
    inventory: null,
    enabled: true,
    ...over,
  }
}

// --- fixture project lifecycle ----------------------------------------------

const createdProjectIds: string[] = []

async function newProject(app: any, name: string, slug: string, settings: Record<string, any> = {}): Promise<string> {
  // Clean up any leftover project with this slug from a prior interrupted run.
  const existing = await app.documents('api::project.project').findMany({ filters: { slug }, limit: 1 })
  if (existing.length > 0) await destroyProject(app, existing[0].documentId)
  const project = await app.documents('api::project.project').create({
    data: { name, slug, pointRules: {}, registeredEventTypes: [], allowedOrigins: null, ...settings },
  })
  createdProjectIds.push(project.documentId)
  return project.documentId
}

async function destroyProject(app: any, projectId: string) {
  for (const uid of [
    'api::offer.offer',
    'api::reward.reward',
    'api::achievement.achievement',
    'api::timed-event.timed-event',
    'api::placement.placement',
    'api::webhook-endpoint.webhook-endpoint',
  ]) {
    const rows = await app.documents(uid).findMany({ filters: { project: { documentId: projectId } } }).catch(() => [])
    for (const r of rows) await app.documents(uid).delete({ documentId: r.documentId }).catch(() => {})
  }
  await app.documents('api::project.project').delete({ documentId: projectId }).catch(() => {})
}

async function findBySlug(app: any, uid: string, projectId: string, slug: string): Promise<any | undefined> {
  const rows = await app.documents(uid).findMany({ filters: { project: { documentId: projectId }, slug } })
  return rows[0]
}
async function countAll(app: any, projectId: string): Promise<number> {
  let total = 0
  for (const uid of [
    'api::placement.placement',
    'api::timed-event.timed-event',
    'api::achievement.achievement',
    'api::reward.reward',
    'api::offer.offer',
  ]) {
    const rows = await app.documents(uid).findMany({ filters: { project: { documentId: projectId } } })
    total += rows.length
  }
  return total
}

// --- scenarios ---------------------------------------------------------------

async function scenario1RoundTrip(app: any) {
  console.log('\n[verify-config-sync] === Scenario 1: round-trip invariant ===')
  const S = 'round-trip'
  const projectId = await newProject(app, 'Round Trip', 'verify-cfgsync-roundtrip', {
    pointRules: { lesson_completed: 10 },
    registeredEventTypes: ['lesson_completed', 'quiz_passed'],
    allowedOrigins: ['https://a.example'],
  })

  const initial = buildFile({
    project: { pointRules: { lesson_completed: 10 }, registeredEventTypes: ['lesson_completed', 'quiz_passed'], allowedOrigins: ['https://a.example'] },
    placements: [fPlacement('p1', 'Placement One'), fPlacement('p2', 'Placement Two')],
    timedEvents: [fTimedEvent('te1', 'Timed One')],
    achievements: [fAchievement('a1', 'Ach One')],
    offers: [fOffer('o1', 'Offer One', 'p1', { timedEvent: 'te1' })],
    rewards: [fReward('r1', 'Reward Gen'), fReward('r2', 'Reward Static', { codeType: 'static', staticCode: 'STATIC-R2' })],
  })
  const seed = await importFile(projectId, initial)
  truthy(S, seed.status === 200 && seed.body.applied === true, `seed import applied (status ${seed.status})`)

  const exported = await exportFile(projectId)
  const reimport = await importFile(projectId, exported)
  truthy(S, reimport.status === 200, `re-import of export succeeded (status ${reimport.status})`)
  const plan = reimport.body.plan
  for (const [type, expectUnchanged] of [
    ['project', 1],
    ['placements', 2],
    ['achievements', 1],
    ['timedEvents', 1],
    ['offers', 1],
    ['rewards', 2],
  ] as const) {
    const b = plan[type]
    truthy(
      S,
      b.creates.length === 0 && b.updates.length === 0 && b.deletes.length === 0 && b.unchanged === expectUnchanged,
      `${type}: all-unchanged (creates=${b.creates.length} updates=${b.updates.length} deletes=${b.deletes.length} unchanged=${b.unchanged}, expected unchanged=${expectUnchanged})`,
    )
  }
}

async function scenario2CreateUpdateUnchanged(app: any) {
  console.log('\n[verify-config-sync] === Scenario 2: create+update+unchanged exact slug lists ===')
  const S = 'create-update-unchanged'
  const projectId = await newProject(app, 'CUU', 'verify-cfgsync-cuu')
  await app.documents('api::placement.placement').create({ data: { slug: 'p-keep', name: 'Keep', project: projectId } })
  await app.documents('api::placement.placement').create({ data: { slug: 'p-change', name: 'Old Name', project: projectId } })

  const file = buildFile({
    placements: [fPlacement('p-keep', 'Keep'), fPlacement('p-change', 'New Name'), fPlacement('p-new', 'Brand New')],
  })
  const res = await importFile(projectId, file)
  truthy(S, res.status === 200, `import applied (status ${res.status})`)
  const b = res.body.plan.placements
  eq(S, b.creates, ['p-new'], 'placements.creates == [p-new]')
  eq(S, b.updates, ['p-change'], 'placements.updates == [p-change]')
  eq(S, b.unchanged, 1, 'placements.unchanged == 1 (p-keep)')
  // positive control: p-change's name really changed in the DB
  const changed = await findBySlug(app, 'api::placement.placement', projectId, 'p-change')
  truthy(S, changed?.name === 'New Name', `p-change name updated to "New Name" (got "${changed?.name}")`)
}

async function scenario3RegisteredEventTypesOrder(app: any) {
  console.log('\n[verify-config-sync] === Scenario 3: registeredEventTypes order-insensitivity ===')
  const S = 'registered-event-types-order'
  const projectId = await newProject(app, 'RET', 'verify-cfgsync-ret', {
    registeredEventTypes: ['login', 'signup', 'purchase'],
  })
  const reordered = buildFile({
    project: { pointRules: {}, registeredEventTypes: ['purchase', 'login', 'signup'], allowedOrigins: null },
  })
  const res = await importFile(projectId, reordered, { dryRun: true })
  eq(S, res.body.plan.project.updates, [], 'reordered set -> project.updates == []')
  eq(S, res.body.plan.project.unchanged, 1, 'reordered set -> project.unchanged == 1')
  // positive control: a genuinely different set must register as an update
  const changed = buildFile({
    project: { pointRules: {}, registeredEventTypes: ['login'], allowedOrigins: null },
  })
  const res2 = await importFile(projectId, changed, { dryRun: true })
  truthy(S, res2.body.plan.project.updates.length === 1, 'different set -> project.updates non-empty (positive control)')
}

async function scenario4Prune(app: any) {
  console.log('\n[verify-config-sync] === Scenario 4: prune only-with-flag and only-covered-types ===')
  const S = 'prune'
  const projectId = await newProject(app, 'Prune', 'verify-cfgsync-prune')
  await app.documents('api::placement.placement').create({ data: { slug: 'p1', name: 'One', project: projectId } })
  await app.documents('api::placement.placement').create({ data: { slug: 'p2', name: 'Two', project: projectId } })
  const webhook = await app.documents('api::webhook-endpoint.webhook-endpoint').create({
    data: { url: 'https://hook.example/verify', secret: 'whsec', enabled: true, project: projectId },
  })

  const file = buildFile({ placements: [fPlacement('p1', 'One')] })

  // without prune: p2 survives
  const noPrune = await importFile(projectId, file, { prune: false })
  eq(S, noPrune.body.plan.placements.deletes, [], 'without prune -> placements.deletes == []')
  const p2AfterNoPrune = await findBySlug(app, 'api::placement.placement', projectId, 'p2')
  truthy(S, !!p2AfterNoPrune, 'without prune -> p2 survives')

  // with prune: p2 deleted, p1 survives
  const withPrune = await importFile(projectId, file, { prune: true })
  eq(S, withPrune.body.plan.placements.deletes, ['p2'], 'with prune -> placements.deletes == [p2]')
  const p2AfterPrune = await findBySlug(app, 'api::placement.placement', projectId, 'p2')
  const p1AfterPrune = await findBySlug(app, 'api::placement.placement', projectId, 'p1')
  truthy(S, !p2AfterPrune, 'with prune -> p2 deleted')
  truthy(S, !!p1AfterPrune, 'with prune -> p1 survives')

  // uncovered type: the webhook endpoint is untouched by prune
  const webhookAfter = await app.documents('api::webhook-endpoint.webhook-endpoint').findOne({ documentId: webhook.documentId })
  truthy(S, !!webhookAfter, 'with prune -> seeded webhook endpoint (uncovered type) survives')
}

async function scenario5DryRunEqualsApply(app: any) {
  console.log('\n[verify-config-sync] === Scenario 5: dry-run plan equals apply plan, zero writes ===')
  const S = 'dry-run'
  const projectId = await newProject(app, 'DryRun', 'verify-cfgsync-dryrun')
  await app.documents('api::placement.placement').create({ data: { slug: 'p-exist', name: 'Old', project: projectId } })

  const file = buildFile({
    placements: [fPlacement('p-exist', 'New'), fPlacement('p-add', 'Added')],
    rewards: [fReward('r-new', 'New Reward')],
  })

  const before = await countAll(app, projectId)
  const dry = await importFile(projectId, file, { dryRun: true })
  truthy(S, dry.status === 200 && dry.body.applied === false, `dry-run -> applied=false (status ${dry.status})`)
  const afterDry = await countAll(app, projectId)
  truthy(S, afterDry === before, `dry-run wrote nothing (rows before=${before}, after=${afterDry})`)

  const applied = await importFile(projectId, file, { dryRun: false })
  truthy(S, applied.body.applied === true, 'apply -> applied=true')
  eq(S, dry.body.plan, applied.body.plan, 'dry-run plan deep-equals apply plan')
  const afterApply = await countAll(app, projectId)
  truthy(S, afterApply === before + 2, `apply wrote the creates (rows before=${before}, after=${afterApply}, expected ${before + 2})`)
}

async function scenario6UnknownRef(app: any) {
  console.log('\n[verify-config-sync] === Scenario 6: unknown-ref 400 before writes ===')
  const S = 'unknown-ref'
  const projectId = await newProject(app, 'UnknownRef', 'verify-cfgsync-unknownref')

  const file = buildFile({
    placements: [fPlacement('p-real', 'Real')],
    rewards: [fReward('r-would-write', 'Would Write')],
    offers: [fOffer('o-bad', 'Bad Offer', 'ghost-placement')],
  })
  const before = await countAll(app, projectId)
  const res = await importFile(projectId, file)
  truthy(S, res.status === 400, `unknown ref -> 400 (status ${res.status})`)
  truthy(S, res.body?.error === 'unknown reference', `body.error == 'unknown reference' (got ${JSON.stringify(res.body?.error)})`)
  const hasDetail = Array.isArray(res.body?.details) && res.body.details.some(
    (d: any) => d.offer === 'o-bad' && d.ref === 'ghost-placement' && d.type === 'placement',
  )
  truthy(S, hasDetail, `details include {offer:o-bad, ref:ghost-placement, type:placement} (got ${JSON.stringify(res.body?.details)})`)
  const after = await countAll(app, projectId)
  truthy(S, after === before, `no writes before the 400 (rows before=${before}, after=${after})`)
}

async function scenario7MidRun422(app: any) {
  console.log('\n[verify-config-sync] === Scenario 7: mid-run 422 with recomputed plan ===')
  const S = 'mid-run-422'
  const projectId = await newProject(app, 'MidRun', 'verify-cfgsync-midrun')

  const file = buildFile({
    placements: [fPlacement('p1', 'One')],
    timedEvents: [fTimedEvent('te1', 'TE One')],
    achievements: [fAchievement('ach1', 'Ach One')],
    // static reward with null staticCode: the S8 reward lifecycle rejects it
    rewards: [fReward('r-bad', 'Bad Reward', { codeType: 'static', staticCode: null })],
    offers: [fOffer('o1', 'Offer One', 'p1')],
  })
  const res = await importFile(projectId, file)
  truthy(S, res.status === 422, `mid-run rejection -> 422 (status ${res.status})`)
  truthy(S, res.body?.applied === true, 'body.applied === true')
  truthy(S, res.body?.error?.stage === 'rewards/r-bad', `error.stage == 'rewards/r-bad' (got ${JSON.stringify(res.body?.error?.stage)})`)

  // earlier types genuinely applied; the failing reward + not-yet-reached offer absent
  const p1 = await findBySlug(app, 'api::placement.placement', projectId, 'p1')
  const te1 = await findBySlug(app, 'api::timed-event.timed-event', projectId, 'te1')
  const ach1 = await findBySlug(app, 'api::achievement.achievement', projectId, 'ach1')
  const rBad = await findBySlug(app, 'api::reward.reward', projectId, 'r-bad')
  const o1 = await findBySlug(app, 'api::offer.offer', projectId, 'o1')
  truthy(S, !!p1 && !!te1 && !!ach1, 'placement/timedEvent/achievement genuinely applied before the failure')
  truthy(S, !rBad, 'failing reward was NOT written')
  truthy(S, !o1, 'offer (after rewards in order) was NOT reached')

  // recomputed plan matches DB state: applied types collapse to unchanged,
  // the failing reward stays a create, the unreached offer stays a create.
  const plan = res.body.plan
  eq(S, plan.placements.creates, [], 'recomputed: placements.creates == [] (applied)')
  eq(S, plan.placements.unchanged, 1, 'recomputed: placements.unchanged == 1')
  eq(S, plan.timedEvents.creates, [], 'recomputed: timedEvents.creates == [] (applied)')
  eq(S, plan.achievements.creates, [], 'recomputed: achievements.creates == [] (applied)')
  eq(S, plan.rewards.creates, ['r-bad'], 'recomputed: rewards.creates == [r-bad] (still pending)')
  eq(S, plan.offers.creates, ['o1'], 'recomputed: offers.creates == [o1] (still pending)')
}

async function scenario8UpdatePreservesDocumentId(app: any) {
  console.log('\n[verify-config-sync] === Scenario 8: update-in-place preserves documentId ===')
  const S = 'update-preserves-id'
  const projectId = await newProject(app, 'UpdateId', 'verify-cfgsync-updateid')
  const created = await app.documents('api::placement.placement').create({ data: { slug: 'p-x', name: 'Before', project: projectId } })
  const beforeId = created.documentId

  const file = buildFile({ placements: [fPlacement('p-x', 'After')] })
  const res = await importFile(projectId, file)
  truthy(S, res.status === 200, `update import applied (status ${res.status})`)
  eq(S, res.body.plan.placements.updates, ['p-x'], 'placements.updates == [p-x]')

  const after = await findBySlug(app, 'api::placement.placement', projectId, 'p-x')
  truthy(S, after?.documentId === beforeId, `documentId preserved across update (before=${beforeId}, after=${after?.documentId})`)
  truthy(S, after?.name === 'After', `name updated to "After" (got "${after?.name}")`)
}

// --- main --------------------------------------------------------------------

async function main() {
  const appDir = path.resolve(__dirname, '..')

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { compileStrapi, createStrapi } = require('@strapi/strapi')

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(
      '[verify-config-sync] refusing to run: DATABASE_URL could not be resolved (not set in the environment, and not present in apps/cms/.env). Set DATABASE_URL explicitly.',
    )
    process.exit(1)
  }
  console.log(`[verify-config-sync] target DB: ${databaseUrl.replace(/:[^:@/]*@/, ':***@')}`)
  assertLocalDatabase(databaseUrl)

  SECRET = process.env.CONFIG_PLANE_SECRET ?? ''
  if (!SECRET) {
    console.error('[verify-config-sync] refusing to run: CONFIG_PLANE_SECRET is not set — cannot exercise the guarded endpoint.')
    process.exit(1)
  }

  console.log('[verify-config-sync] compiling cms...')
  const appContext = await compileStrapi({ appDir })
  const app = await createStrapi(appContext).load()
  await app.listen()
  console.log(`[verify-config-sync] strapi loaded and listening on :${VERIFY_PORT}`)

  let exitCode = 0
  try {
    await scenario1RoundTrip(app)
    await scenario2CreateUpdateUnchanged(app)
    await scenario3RegisteredEventTypesOrder(app)
    await scenario4Prune(app)
    await scenario5DryRunEqualsApply(app)
    await scenario6UnknownRef(app)
    await scenario7MidRun422(app)
    await scenario8UpdatePreservesDocumentId(app)
  } catch (e: any) {
    console.error('[verify-config-sync] unexpected error:', e)
    exitCode = 1
  } finally {
    for (const projectId of createdProjectIds) {
      await destroyProject(app, projectId).catch(() => {})
    }
    await app.destroy().catch(() => {})
  }

  console.log(`\n[verify-config-sync] ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  - [${f.scenario}] ${f.message}`)

  process.exit(exitCode || (findings.length > 0 ? 1 : 0))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
