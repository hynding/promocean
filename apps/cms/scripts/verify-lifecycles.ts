/**
 * Durable, checked-in verification script for the reward/timed-event lifecycle
 * hooks and the config-plane recurring-exemption filter (closes #20, #24).
 *
 * Boots a standalone Strapi instance the same way `strapi console` does
 * (compileStrapi -> createStrapi(...).load()) against the configured
 * DATABASE_URL — resolved the same way Strapi itself resolves it (env var, or
 * apps/cms/.env; dev Postgres on 5433 by default). There is no hardcoded
 * fallback: if DATABASE_URL can't be resolved at all, the script refuses to
 * run rather than guess. Every probe writes fixture rows, and `--fix` mutates
 * real rows, so the script also refuses to run against a DATABASE_URL whose
 * host isn't localhost/127.0.0.1 unless `--allow-remote` is passed. Also
 * brings the HTTP server up (on VERIFY_PORT, default 18337, to avoid
 * colliding with a dev `strapi develop` already listening on 1337) so probe 3
 * can hit the real config-plane controller rather than a reimplementation of
 * its filter.
 *
 * Three probes:
 *   1. Admin-session relation shapes (#20.1) — creates+updates a reward and a
 *      timed-event via strapi.documents() using the relation payload shapes
 *      resolveProjectId (reward lifecycle) claims to handle: a numeric id, an
 *      `{ id }` object, a `{ connect: [...] }` descriptor, and a
 *      `{ set: [...] }` descriptor. For each shape, asserts the entity's own
 *      update-path validation actually FIRES (reward: slug + staticCode
 *      uniqueness; timed-event: endsAt > startsAt) rather than silently
 *      no-oping because the project relation failed to resolve. The update is
 *      expected to throw the lifecycle's own typed `errors.ValidationError`
 *      (from `@strapi/utils`) specifically — any other error type is its own
 *      distinct finding, since a bare "it threw" can't distinguish the check
 *      firing from something upstream (e.g. resolveProjectId) crashing.
 *   2. Duplicate staticCode scan (#20.2) — read-only: groups static rewards
 *      by (project, staticCode) across the whole target DB; any duplicate
 *      group is a finding. No auto-fix — operator decides. Pages explicitly
 *      (rather than relying on `limit: -1`, whose unbounded-ness isn't
 *      guaranteed at the DB layer) to make sure every row is scanned.
 *   3. Legacy-NULL recurrence probe (#24) — raw-SQL-inserts a NULL-recurrence
 *      timed-event row (simulating pre-migration data the application layer
 *      can never produce itself, since the schema requires `recurrence`), and
 *      compares its /timed-events/all inclusion against an otherwise-identical
 *      control row with recurrence explicitly 'none'. A third, positive-
 *      inclusion control (an active event) asserts the endpoint is seen to
 *      include fixture rows at all — without it, endpoint drift that made it
 *      return nothing could make every `included=false` assertion vacuously
 *      pass. Also scans the target DB for other pre-existing legacy NULL
 *      rows. `--fix` backfills `recurrence = 'none' WHERE recurrence IS NULL`
 *      (globally, on the target DB) and re-probes clean. All fixture rows are
 *      cleaned up in a `finally`, so a mid-probe throw can't leak them.
 *
 * Usage:
 *   pnpm --filter cms verify:lifecycles
 *   pnpm --filter cms verify:lifecycles --fix
 *   DATABASE_URL=postgres://... pnpm --filter cms verify:lifecycles
 *   DATABASE_URL=postgres://...@some-remote-host/... pnpm --filter cms verify:lifecycles --allow-remote
 *
 * Exit code is non-zero if any probe reports a finding.
 */

import path from 'node:path'
import { Client } from 'pg'
import { errors } from '@strapi/utils'

const FIX = process.argv.includes('--fix')
const ALLOW_REMOTE = process.argv.includes('--allow-remote')
const VERIFY_PORT = process.env.VERIFY_PORT ?? '18337'
process.env.PORT = VERIFY_PORT
// This script manages its own fixtures; demo seeding would just be noise (and
// on a fresh disposable DB would create an unrelated project we don't need).
process.env.SEED_DEMO = 'false'

const PROJECT_SLUG = 'verify-lifecycles-probe'

type Finding = { probe: string; message: string }
const findings: Finding[] = []

function finding(probe: string, message: string) {
  findings.push({ probe, message })
  console.log(`[verify-lifecycles] FINDING (${probe}): ${message}`)
}

function ok(message: string) {
  console.log(`[verify-lifecycles] ok: ${message}`)
}

function randomDocumentId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 24; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

// --- blast-radius guard ------------------------------------------------------

// All 3 probes write fixture rows to the target DB, and --fix mutates real
// rows (a global UPDATE). Refuse to run against anything that isn't plainly a
// local/disposable database unless the caller explicitly overrides — a typo'd
// or inherited DATABASE_URL pointed at a shared/remote host should not
// silently get probed and (with --fix) mutated.
function assertLocalDatabase(databaseUrl: string) {
  let host: string
  try {
    host = new URL(databaseUrl).hostname
  } catch (e: any) {
    console.error(`[verify-lifecycles] refusing to run: DATABASE_URL is not a parseable URL (${e.message})`)
    process.exit(1)
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (isLocal || ALLOW_REMOTE) return
  console.error(
    `[verify-lifecycles] refusing to run: DATABASE_URL host "${host}" is not localhost/127.0.0.1. ` +
      'This script writes fixture rows to the target database, and --fix mutates real rows there ' +
      '(a global UPDATE). Re-run against a local/disposable database, or pass --allow-remote if you ' +
      'really intend to target this host.',
  )
  process.exit(1)
}

// --- probe 1 helper: assert a lifecycle's own validation actually fires -----

function isValidationError(e: unknown): boolean {
  return e instanceof errors.ValidationError || (e as any)?.name === 'ValidationError'
}

// A bare `catch { threw = true }` proves only that *something* threw — if
// resolveProjectId (or anything else on the update path) crashed on a shape,
// that would look identical to the validation firing correctly and the probe
// would report a false pass. Distinguish the lifecycle's own typed
// ValidationError (the thing this probe exists to observe) from any other
// error, which is itself a distinct finding.
async function assertValidationErrorFires(probe: string, shapeName: string, label: string, action: () => Promise<unknown>) {
  try {
    await action()
  } catch (e: any) {
    if (isValidationError(e)) {
      ok(`${label} fired on update (shape: ${shapeName})`)
      return
    }
    finding(probe, `shape "${shapeName}": ${label} update threw a non-validation error: ${e?.message ?? String(e)}`)
    return
  }
  finding(probe, `${label} did NOT fire on update with project shape "${shapeName}" — silently skipped`)
}

// --- fixture project -------------------------------------------------------

async function cleanupLeftoverProject(app: any) {
  const existing = await app.documents('api::project.project').findMany({ filters: { slug: PROJECT_SLUG }, limit: 1 })
  if (existing.length === 0) return
  const project = existing[0]
  console.log(`[verify-lifecycles] found leftover project from a prior run (documentId=${project.documentId}); cleaning up`)
  const rewards = await app.documents('api::reward.reward').findMany({ filters: { project: { documentId: project.documentId } } })
  for (const r of rewards) await app.documents('api::reward.reward').delete({ documentId: r.documentId })
  const events = await app.documents('api::timed-event.timed-event').findMany({ filters: { project: { documentId: project.documentId } } })
  for (const e of events) await app.documents('api::timed-event.timed-event').delete({ documentId: e.documentId })
  await app.documents('api::project.project').delete({ documentId: project.documentId })
}

// --- probe 1: admin-session relation shapes --------------------------------

async function probe1(app: any, project: any) {
  console.log('\n[verify-lifecycles] === Probe 1: admin-session relation shapes (#20.1) ===')
  const projectId = project.id
  const shapes: Record<string, unknown> = {
    'numeric-id': projectId,
    'id-object': { id: projectId },
    connect: { connect: [{ id: projectId }] },
    set: { set: [{ id: projectId }] },
  }

  const createdRewardIds: string[] = []
  const createdEventIds: string[] = []

  for (const [shapeName, shapeVal] of Object.entries(shapes)) {
    // --- reward: slug + staticCode uniqueness must fire on update ---
    try {
      const a = await app.documents('api::reward.reward').create({
        data: {
          name: `Verify A ${shapeName}`,
          slug: `verify-a-${shapeName}`,
          codeType: 'static',
          staticCode: `VERIFY-A-${shapeName}`.toUpperCase(),
          pointsPrice: 0,
          perUserLimit: 1,
          project: shapeVal,
        },
      })
      const b = await app.documents('api::reward.reward').create({
        data: {
          name: `Verify B ${shapeName}`,
          slug: `verify-b-${shapeName}`,
          codeType: 'static',
          staticCode: `VERIFY-B-${shapeName}`.toUpperCase(),
          pointsPrice: 0,
          perUserLimit: 1,
          project: shapeVal,
        },
      })
      createdRewardIds.push(a.documentId, b.documentId)

      await assertValidationErrorFires('probe1-reward-slug', shapeName, 'reward slug uniqueness check', () =>
        app.documents('api::reward.reward').update({
          documentId: b.documentId,
          data: { slug: a.slug, project: shapeVal },
        }),
      )

      await assertValidationErrorFires('probe1-reward-staticcode', shapeName, 'reward staticCode uniqueness check', () =>
        app.documents('api::reward.reward').update({
          documentId: b.documentId,
          data: { staticCode: a.staticCode, project: shapeVal },
        }),
      )
    } catch (e: any) {
      finding('probe1-reward-setup', `setup failed for shape "${shapeName}": ${e.message}`)
    }

    // --- timed-event: endsAt > startsAt must fire on update ---
    try {
      const startsAt = new Date()
      const endsAt = new Date(startsAt.getTime() + 3600_000)
      const te = await app.documents('api::timed-event.timed-event').create({
        data: {
          name: `Verify TE ${shapeName}`,
          startsAt,
          endsAt,
          project: shapeVal,
        },
      })
      createdEventIds.push(te.documentId)

      await assertValidationErrorFires('probe1-timedevent-dates', shapeName, 'timed-event endsAt>startsAt validation', () =>
        app.documents('api::timed-event.timed-event').update({
          documentId: te.documentId,
          data: { endsAt: new Date(startsAt.getTime() - 3600_000), project: shapeVal },
        }),
      )
    } catch (e: any) {
      finding('probe1-timedevent-setup', `setup failed for shape "${shapeName}": ${e.message}`)
    }
  }

  for (const documentId of createdRewardIds) {
    await app.documents('api::reward.reward').delete({ documentId }).catch(() => {})
  }
  for (const documentId of createdEventIds) {
    await app.documents('api::timed-event.timed-event').delete({ documentId }).catch(() => {})
  }
}

// --- probe 2: duplicate staticCode scan -------------------------------------

// `limit: -1` is accepted by the Documents API's pagination validation (it
// explicitly allows -1 alongside `>= 1`), but nothing in Strapi 5's docs
// guarantees it compiles to an unbounded query at the DB layer rather than,
// say, a literal (and dialect-dependent) `LIMIT -1` — so don't rely on it for
// a scan that needs to see every row. Page explicitly instead.
const PAGE_SIZE = 500

async function fetchAllStaticRewards(app: any): Promise<any[]> {
  const rows: any[] = []
  let start = 0
  for (;;) {
    const page = await app.documents('api::reward.reward').findMany({
      filters: { codeType: 'static' },
      populate: ['project'],
      start,
      limit: PAGE_SIZE,
    })
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    start += PAGE_SIZE
  }
  return rows
}

async function probe2(app: any) {
  console.log('\n[verify-lifecycles] === Probe 2: duplicate staticCode scan (#20.2) ===')
  const rows = await fetchAllStaticRewards(app)
  const groups = new Map<string, { projectId: string; staticCode: string; rewards: string[] }>()
  for (const r of rows) {
    const staticCode = r.staticCode
    const projectDocId = r.project?.documentId
    if (!staticCode || !projectDocId) continue
    const key = `${projectDocId}::${staticCode}`
    const group = groups.get(key) ?? { projectId: projectDocId, staticCode, rewards: [] as string[] }
    group.rewards.push(r.documentId)
    groups.set(key, group)
  }
  let dupeCount = 0
  for (const group of groups.values()) {
    if (group.rewards.length > 1) {
      dupeCount++
      finding(
        'probe2-duplicate-staticcode',
        `project ${group.projectId}: staticCode "${group.staticCode}" duplicated across rewards [${group.rewards.join(', ')}]`,
      )
    }
  }
  if (dupeCount === 0) ok(`no duplicate staticCodes found (scanned ${rows.length} static rewards, ${groups.size} project/code groups)`)
}

// --- probe 3: legacy-NULL recurrence -----------------------------------------

async function countNullRecurrence(pg: Client): Promise<number> {
  const res = await pg.query('SELECT count(*)::int AS n FROM timed_events WHERE recurrence IS NULL')
  return res.rows[0].n
}

async function queryTimedEventsAll(secret: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${VERIFY_PORT}/api/config-plane/timed-events/all?endedWithinMinutes=60`, {
    headers: { 'x-config-secret': secret },
  })
  if (!res.ok) throw new Error(`timed-events/all responded ${res.status}`)
  return res.json()
}

async function probe3(app: any, project: any, pg: Client) {
  console.log('\n[verify-lifecycles] === Probe 3: legacy-NULL recurrence (#24) ===')
  const secret = process.env.CONFIG_PLANE_SECRET
  if (!secret) {
    finding('probe3-config', 'CONFIG_PLANE_SECRET is not set in the environment — cannot exercise the real endpoint')
    return
  }

  const preExisting = await countNullRecurrence(pg)
  if (preExisting > 0) {
    // Not recorded as a finding yet: if --fix is set, the backfill below
    // resolves this in the same run and the final remaining-count check
    // decides whether it's actually a finding. Without --fix, it's flagged
    // below once we know no backfill was attempted.
    console.log(`[verify-lifecycles] ${preExisting} pre-existing NULL-recurrence timed-event row(s) found in the target DB`)
  } else {
    ok('no pre-existing NULL-recurrence rows in the target DB')
  }

  // Old, ended, non-recurring dates for both the control and the synthetic row.
  const startsAt = new Date(Date.now() - 9 * 24 * 3600_000)
  const endsAt = new Date(Date.now() - 9 * 24 * 3600_000 + 3600_000) // ended ~9 days ago

  const control = await app.documents('api::timed-event.timed-event').create({
    data: {
      name: 'Verify Probe3 Control (recurrence=none)',
      startsAt,
      endsAt,
      recurrence: 'none',
      project: project.id,
    },
  })

  // Positive-inclusion control: every other assertion in this probe checks
  // `included=false` cases. Without at least one fixture the endpoint is
  // expected to include, drift that made the endpoint return nothing at all
  // (wrong secret plumbing, wrong project scoping, endpoint 500ing into an
  // empty body, etc.) would go unnoticed — every assertion would vacuously
  // "pass" by both sides being false. A currently-active event (endsAt in the
  // future) must always be included regardless of the endedWithinMinutes
  // filter.
  const positiveControl = await app.documents('api::timed-event.timed-event').create({
    data: {
      name: 'Verify Probe3 Positive Control (active)',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600_000),
      recurrence: 'none',
      project: project.id,
    },
  })

  let syntheticId: number | undefined
  try {
    const syntheticDocId = randomDocumentId()
    const insertRes = await pg.query(
      `INSERT INTO timed_events
         (document_id, name, starts_at, ends_at, ending_soon_minutes, multiplier, enabled, recurrence, recurrence_ends_at, created_at, updated_at, published_at)
       VALUES ($1, $2, $3, $4, 1440, 1, true, NULL, NULL, now(), now(), now())
       RETURNING id`,
      [syntheticDocId, 'Verify Probe3 Legacy NULL Recurrence', startsAt.toISOString(), endsAt.toISOString()],
    )
    syntheticId = insertRes.rows[0].id
    await pg.query('INSERT INTO timed_events_project_lnk (timed_event_id, project_id) VALUES ($1, $2)', [syntheticId, project.id])

    async function isIncluded(documentId: string): Promise<boolean> {
      const body = await queryTimedEventsAll(secret!)
      return body.events.some((e: any) => e.id === documentId)
    }

    const positiveControlIncluded = await isIncluded(positiveControl.documentId)
    if (positiveControlIncluded) {
      ok('positive control (active event) is included — endpoint does see fixture rows')
    } else {
      finding(
        'probe3-positive-control',
        'positive control (an active event, endsAt in the future) was NOT included by /timed-events/all — the endpoint may not be seeing fixture rows at all, which would make every other assertion in this probe vacuously pass',
      )
    }

    const controlIncluded = await isIncluded(control.documentId)
    const syntheticIncluded = await isIncluded(syntheticDocId)
    console.log(`[verify-lifecycles] control (recurrence='none') included=${controlIncluded}; synthetic (recurrence=NULL) included=${syntheticIncluded}`)

    if (controlIncluded === syntheticIncluded) {
      ok(`NULL recurrence behaves identically to explicit 'none' (both included=${controlIncluded})`)
    } else {
      finding(
        'probe3-null-divergence',
        `NULL-recurrence row diverges from an equivalent explicit-'none' row: control included=${controlIncluded}, synthetic (NULL) included=${syntheticIncluded}`,
      )
    }

    if (FIX) {
      const res = await pg.query("UPDATE timed_events SET recurrence = 'none' WHERE recurrence IS NULL")
      console.log(`[verify-lifecycles] --fix: backfilled ${res.rowCount} row(s) to recurrence='none'`)
      const remaining = await countNullRecurrence(pg)
      if (remaining > 0) {
        finding('probe3-fix', `${remaining} NULL-recurrence row(s) remain after backfill`)
      } else {
        const reIncluded = await isIncluded(syntheticDocId)
        if (reIncluded === controlIncluded) {
          ok(`re-probe clean after --fix: backfilled row now behaves identically to control (included=${reIncluded})`)
        } else {
          finding('probe3-fix', `after --fix, backfilled row (included=${reIncluded}) still diverges from control (included=${controlIncluded})`)
        }
      }
    } else if (preExisting > 0) {
      finding('probe3-legacy-debt', `${preExisting} pre-existing NULL-recurrence timed-event row(s) found in the target DB (run with --fix to backfill)`)
    }
  } finally {
    // Cleanup regardless of pass/fail/--fix/thrown-mid-probe — a throw between
    // the synthetic row's INSERT and this point must not leak it into the
    // target DB.
    if (syntheticId !== undefined) {
      await pg.query('DELETE FROM timed_events WHERE id = $1', [syntheticId]).catch(() => {})
    }
    await app.documents('api::timed-event.timed-event').delete({ documentId: control.documentId }).catch(() => {})
    await app.documents('api::timed-event.timed-event').delete({ documentId: positiveControl.documentId }).catch(() => {})
  }
}

// --- main --------------------------------------------------------------

async function main() {
  const appDir = path.resolve(__dirname, '..')

  // Requiring '@strapi/strapi' triggers @strapi/core's configuration module,
  // which synchronously dotenv-loads apps/cms/.env (without clobbering
  // already-set env vars — so an external DATABASE_URL override still wins).
  // Read process.env.DATABASE_URL only *after* this require, so our own pg
  // client below targets the exact same database Strapi itself resolves —
  // reading it before this point would silently fall back to a hardcoded
  // guess whenever the caller relies on .env instead of an override.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { compileStrapi, createStrapi } = require('@strapi/strapi')

  // No hardcoded fallback: guessing dev credentials here would silently probe
  // (and, with --fix, mutate) whatever database that guess happens to resolve
  // to on a given machine. If DATABASE_URL isn't resolvable from the
  // environment or apps/cms/.env, that's a setup problem — fail loudly rather
  // than pick a database for the caller.
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(
      '[verify-lifecycles] refusing to run: DATABASE_URL could not be resolved (not set in the environment, and not present in apps/cms/.env). Set DATABASE_URL explicitly.',
    )
    process.exit(1)
  }
  console.log(`[verify-lifecycles] target DB: ${databaseUrl.replace(/:[^:@/]*@/, ':***@')}`)

  // Blast-radius guard: every probe writes fixture rows, and --fix mutates
  // real rows — refuse before connecting to (or even compiling/loading
  // against) anything that isn't plainly local/disposable.
  assertLocalDatabase(databaseUrl)

  console.log('[verify-lifecycles] compiling cms...')

  const appContext = await compileStrapi({ appDir })
  const app = await createStrapi(appContext).load()
  await app.listen()
  console.log(`[verify-lifecycles] strapi loaded and listening on :${VERIFY_PORT}`)

  const pg = new Client({ connectionString: databaseUrl })
  await pg.connect()

  let exitCode = 0
  try {
    await cleanupLeftoverProject(app)
    const project = await app.documents('api::project.project').create({
      data: { name: 'Verify Lifecycles Probe', slug: PROJECT_SLUG },
    })

    await probe2(app) // read-only; run first so it reflects pre-existing state
    await probe1(app, project)
    await probe3(app, project, pg)

    // Final cleanup of the fixture project.
    await app.documents('api::project.project').delete({ documentId: project.documentId })
  } catch (e: any) {
    console.error('[verify-lifecycles] unexpected error:', e)
    exitCode = 1
  } finally {
    await pg.end().catch(() => {})
    await app.destroy().catch(() => {})
  }

  console.log(`\n[verify-lifecycles] ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  - [${f.probe}] ${f.message}`)

  process.exit(exitCode || (findings.length > 0 ? 1 : 0))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
