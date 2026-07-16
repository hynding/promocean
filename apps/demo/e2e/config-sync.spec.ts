import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configFileSchema } from '@promocean/contracts'
import type { ConfigFile } from '@promocean/contracts'

// CMS base + pk/sk match the seeded demo project (apps/cms/src/index.ts) and the
// docker-compose.yml/.env.example defaults — see rewards-loop.spec.ts / campaign-lifecycle.spec.ts
// for the same key constants. CONFIG_SECRET falls back to .env.example's CONFIG_PLANE_SECRET
// default (what a fresh `cp .env.example .env` + `docker compose --profile stack up` produces)
// but honors an actual env var override the same way docker compose itself does.
const CMS_URL = 'http://localhost:1337'
const API_BASE = 'http://localhost:3001'
const PUBLISHABLE_KEY = 'pk_test_demo_1234567890abcdef'
const SECRET_KEY = 'sk_test_demo_1234567890abcdef'
const CONFIG_SECRET = process.env.CONFIG_PLANE_SECRET ?? 'dev-config-secret'

// packages/cli/dist/cli.js relative to this spec file (apps/demo/e2e/) — built by
// `pnpm --filter @promocean/cli build` before this spec runs.
const CLI_PATH = resolve(__dirname, '../../../packages/cli/dist/cli.js')

const SEEDED_ACHIEVEMENT_SLUGS = ['first_lesson', 'getting_started', 'profiled']
const SEEDED_OFFER_SLUGS = ['welcome_offer']
const SEEDED_TIMED_EVENT_SLUGS = ['double_progress_weekend', 'weekly_happy_hour']

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** Drives the CLI as a real subprocess — never imports its source. */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    execFile(
      'node',
      [CLI_PATH, ...args],
      { env: { ...process.env, PROMOCEAN_CONFIG_SECRET: CONFIG_SECRET } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0
        resolvePromise({ code, stdout, stderr })
      },
    )
  })
}

/** Resolves the seeded demo project's documentId via the config-plane's own key-verification
 * endpoint (the same lookup the api itself does), keyed off the seeded secret key's hash —
 * no admin login needed for this (read-only, config-secret-guarded) resolution. */
async function fetchSeededProjectId(): Promise<string> {
  const keyHash = createHash('sha256').update(SECRET_KEY).digest('hex')
  const res = await fetch(`${CMS_URL}/api/config-plane/verify-key`, {
    method: 'POST',
    headers: { 'x-config-secret': CONFIG_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ keyHash }),
  })
  if (!res.ok) throw new Error(`verify-key failed: HTTP ${res.status}`)
  const body = (await res.json()) as { projectId: string }
  return body.projectId
}

async function fetchAchievements(): Promise<Array<{ achievementId: string; name: string; target: number }>> {
  const res = await fetch(`${API_BASE}/v1/users/e2e-cfgsync-probe/achievements`, {
    headers: { authorization: `Bearer ${PUBLISHABLE_KEY}` },
  })
  if (!res.ok) throw new Error(`achievements list failed: HTTP ${res.status}`)
  const body = (await res.json()) as { achievements: Array<{ achievementId: string; name: string; target: number }> }
  return body.achievements
}

/** Tracks one lesson_completed event for a brand-new, disposable user and returns the
 * unlock bonus (wallet ledger delta) it earned for `achievementId` — `undefined` if it
 * didn't unlock at all. A fresh user is required each call: the achievement's own
 * idempotence means an already-unlocked user contributes nothing to re-exercise the
 * *currently cached* pointsValue. */
async function probeUnlockBonus(achievementId: string): Promise<number | undefined> {
  const probeUser = `e2e-cfgsync-points-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const trackRes = await fetch(`${API_BASE}/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${PUBLISHABLE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: probeUser, type: 'lesson_completed', idempotencyKey: `cfgsync-${probeUser}` }),
  })
  if (!trackRes.ok) throw new Error(`track failed: HTTP ${trackRes.status}`)

  const walletRes = await fetch(`${API_BASE}/v1/users/${encodeURIComponent(probeUser)}/wallet`, {
    headers: { authorization: `Bearer ${PUBLISHABLE_KEY}` },
  })
  if (!walletRes.ok) throw new Error(`wallet fetch failed: HTTP ${walletRes.status}`)
  const wallet = (await walletRes.json()) as { recent: Array<{ delta: number; source: string; sourceRef: string }> }
  return wallet.recent.find((r) => r.source === 'unlock' && r.sourceRef === achievementId)?.delta
}

test('export -> scripted edit -> dry-run plan -> import -> api visibility -> re-import all-unchanged', async () => {
  // Two condition-wait polls (forward visibility + post-restore revert visibility) can each
  // legitimately take up to the ~30s config-plane cache TTL, plus the rest of the flow.
  test.setTimeout(150_000)

  const projectId = await fetchSeededProjectId()
  const dir = await mkdtemp(join(tmpdir(), 'promocean-config-sync-'))
  const filePath = join(dir, 'config.json')

  // 1. Export the seeded project; the file parses and contains the six seeded slugs.
  const exportResult = await runCli(['export', '--url', CMS_URL, '--project', projectId, '--out', filePath])
  expect(exportResult.code, `export stderr: ${exportResult.stderr}`).toBe(0)

  const raw = await readFile(filePath, 'utf8')
  const file = configFileSchema.parse(JSON.parse(raw)) as ConfigFile
  // Pristine pre-edit snapshot, restored in the `finally` below — this project's config is
  // shared with every other spec file (e.g. engagement-loop's/rewards-loop's expected point
  // totals assume first_lesson's seeded pointsValue never changes), so this test must leave
  // the server exactly as it found it, pass or fail.
  const original = structuredClone(file)

  const achievementSlugs = file.achievements.map((a) => a.slug)
  const offerSlugs = file.offers.map((o) => o.slug)
  const timedEventSlugs = file.timedEvents.map((t) => t.slug)
  for (const slug of SEEDED_ACHIEVEMENT_SLUGS) expect(achievementSlugs).toContain(slug)
  for (const slug of SEEDED_OFFER_SLUGS) expect(offerSlugs).toContain(slug)
  for (const slug of SEEDED_TIMED_EVENT_SLUGS) expect(timedEventSlugs).toContain(slug)

  try {
    // 2. Scripted edit: bump first_lesson.pointsValue to 60; append a new "bookworm" achievement.
    const firstLesson = file.achievements.find((a) => a.slug === 'first_lesson')
    if (!firstLesson) throw new Error('seeded first_lesson achievement missing from the export')
    firstLesson.pointsValue = 60
    file.achievements.push({
      slug: 'bookworm',
      name: 'Bookworm',
      eventType: 'lesson_completed',
      targetCount: 25,
      pointsValue: 10,
      description: null,
      artworkUrl: null,
    })
    await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')

    // 3. --dry-run exits 2, with the plan showing exactly updates:[first_lesson], creates:[bookworm]
    //    (every other type bucket, and every other achievement, stays unchanged).
    const dryRun = await runCli(['import', '--url', CMS_URL, '--project', projectId, '--file', filePath, '--dry-run'])
    expect(dryRun.code, `dry-run output: ${dryRun.stdout}${dryRun.stderr}`).toBe(2)
    const changeLines = dryRun.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(creates|updates|deletes):/.test(l))
    expect(changeLines).toEqual(['creates: bookworm', 'updates: first_lesson'])

    // 4. Import applies the plan: exits 0.
    const apply = await runCli(['import', '--url', CMS_URL, '--project', projectId, '--file', filePath])
    expect(apply.code, `import output: ${apply.stdout}${apply.stderr}`).toBe(0)

    // 5. api-side visibility: the api caches config-plane achievements per project for up to 30s
    //    (packages/adapter-strapi), so the new achievement and the raised pointsValue may not be
    //    visible immediately after the write above — poll (condition-wait, no sleeps) until they are.
    let firstLessonId = ''
    await expect(async () => {
      const achievements = await fetchAchievements()
      const bookworm = achievements.find((a) => a.name === 'Bookworm')
      expect(bookworm).toBeTruthy()
      expect(bookworm!.target).toBe(25)

      const firstLessonDef = achievements.find((a) => a.name === 'First Lesson')
      expect(firstLessonDef).toBeTruthy()
      firstLessonId = firstLessonDef!.achievementId

      const bonus = await probeUnlockBonus(firstLessonId)
      expect(bonus).toBe(60)
    }).toPass({ timeout: 35_000, intervals: [1000, 2000, 3000, 5000] })

    // 6. Re-import the same (now current) file: a dry-run exits 0 (empty plan — proves
    //    all-unchanged, the exit-0-vs-2 differentiator being the precise signal for "no diff"),
    //    and an actual re-apply also exits 0.
    const reDryRun = await runCli(['import', '--url', CMS_URL, '--project', projectId, '--file', filePath, '--dry-run'])
    expect(reDryRun.code, `re-import dry-run output: ${reDryRun.stdout}${reDryRun.stderr}`).toBe(0)
    const reChangeLines = reDryRun.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(creates|updates|deletes):/.test(l))
    expect(reChangeLines).toEqual([])

    const reImport = await runCli(['import', '--url', CMS_URL, '--project', projectId, '--file', filePath])
    expect(reImport.code, `re-import output: ${reImport.stdout}${reImport.stderr}`).toBe(0)
  } finally {
    // Restore the project to its pristine pre-test state (--prune removes bookworm; the
    // update reverts first_lesson.pointsValue to 50) regardless of pass/fail, so a later
    // suite run against the same stack sees the original seeded values again.
    const restorePath = join(dir, 'restore.json')
    await writeFile(restorePath, `${JSON.stringify(original, null, 2)}\n`, 'utf8')
    const restore = await runCli(['import', '--url', CMS_URL, '--project', projectId, '--file', restorePath, '--prune'])
    if (restore.code !== 0) {
      console.error(`config-sync cleanup: restore import failed (exit ${restore.code}): ${restore.stdout}${restore.stderr}`)
    } else {
      // Close the cache-staleness window itself (not just the DB write): wait until the
      // api's config-plane cache actually reflects the revert too, so a suite re-run
      // started immediately after this one doesn't race a still-stale cache (this is
      // exactly the failure mode a bare DB-level revert doesn't protect against).
      try {
        await expect(async () => {
          const achievements = await fetchAchievements()
          expect(achievements.find((a) => a.name === 'Bookworm')).toBeUndefined()
          const firstLessonDef = achievements.find((a) => a.name === 'First Lesson')
          expect(firstLessonDef).toBeTruthy()
          const bonus = await probeUnlockBonus(firstLessonDef!.achievementId)
          expect(bonus).toBe(50)
        }).toPass({ timeout: 35_000, intervals: [1000, 2000, 3000, 5000] })
      } catch (err) {
        console.error(`config-sync cleanup: cache did not revert within 35s: ${(err as Error).message}`)
      }
    }
  }
})
