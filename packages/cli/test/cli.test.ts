import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, UsageError } from '../src/args.js'
import { runExport } from '../src/commands/export.js'
import { runImport } from '../src/commands/import.js'

const minimalFile = {
  formatVersion: 1 as const,
  project: { pointRules: {}, registeredEventTypes: [], allowedOrigins: null },
  placements: [],
  achievements: [],
  timedEvents: [],
  offers: [],
  rewards: [],
}

const emptyBucket = { creates: [], updates: [], deletes: [], unchanged: 0 }
const emptyPlan = {
  project: emptyBucket,
  placements: emptyBucket,
  achievements: emptyBucket,
  timedEvents: emptyBucket,
  offers: emptyBucket,
  rewards: emptyBucket,
}

const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

let tmpDir: string
let ENV_BACKUP: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'promocean-cli-test-'))
  ENV_BACKUP = process.env.PROMOCEAN_CONFIG_SECRET
  process.env.PROMOCEAN_CONFIG_SECRET = 'sekret'
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
  if (ENV_BACKUP === undefined) delete process.env.PROMOCEAN_CONFIG_SECRET
  else process.env.PROMOCEAN_CONFIG_SECRET = ENV_BACKUP
})

describe('parseArgs', () => {
  it('throws naming --url when missing', () => {
    expect(() => parseArgs(['export', '--project', 'p1'])).toThrow(/--url/)
  })
  it('throws naming --project when missing', () => {
    expect(() => parseArgs(['export', '--url', 'http://x'])).toThrow(/--project/)
  })
  it('throws naming --file when missing on import', () => {
    expect(() => parseArgs(['import', '--url', 'http://x', '--project', 'p1'])).toThrow(/--file/)
  })
  it('does not require --file on export', () => {
    expect(() => parseArgs(['export', '--url', 'http://x', '--project', 'p1'])).not.toThrow()
  })
  it('throws a usage error naming the unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(UsageError)
    expect(() => parseArgs(['frobnicate'])).toThrow(/Unknown command "frobnicate"/)
  })
  it('parses prune and dry-run flags', () => {
    const parsed = parseArgs(['import', '--url', 'http://x', '--project', 'p1', '--file', 'f.json', '--prune', '--dry-run'])
    expect(parsed).toMatchObject({ prune: true, dryRun: true, file: 'f.json' })
  })
  it('trims trailing slash(es) from --url so request paths do not double up', () => {
    expect(parseArgs(['export', '--url', 'http://x/', '--project', 'p1']).url).toBe('http://x')
    expect(parseArgs(['export', '--url', 'http://x///', '--project', 'p1']).url).toBe('http://x')
    expect(parseArgs(['export', '--url', 'http://x', '--project', 'p1']).url).toBe('http://x')
  })
})

describe('export command', () => {
  it('exits 1 naming PROMOCEAN_CONFIG_SECRET when the env var is missing', async () => {
    delete process.env.PROMOCEAN_CONFIG_SECRET
    const result = await runExport({ url: 'http://api.test', project: 'p1', fetchImpl: vi.fn() })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('PROMOCEAN_CONFIG_SECRET')
  })

  it('happy path: validates and writes pretty JSON to --out', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(minimalFile))
    const out = join(tmpDir, 'export.json')
    const result = await runExport({ url: 'http://api.test', project: 'p1', out, fetchImpl })

    expect(result.exitCode).toBe(0)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/api/config-plane/projects/p1/export')
    expect((init as RequestInit).headers).toMatchObject({ 'x-config-secret': 'sekret' })

    const written = await readFile(out, 'utf8')
    expect(JSON.parse(written)).toEqual(minimalFile)
    expect(written).toBe(`${JSON.stringify(minimalFile, null, 2)}\n`)
  })

  it('happy path without --out prints pretty JSON to output', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(minimalFile))
    const result = await runExport({ url: 'http://api.test', project: 'p1', fetchImpl })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output)).toEqual(minimalFile)
  })

  it('server-drift: an invalid response body exits 1 listing zod issue paths', async () => {
    const drifted = { ...minimalFile, project: { ...minimalFile.project, pointRules: 'not-an-object' } }
    const fetchImpl = vi.fn().mockImplementation(() => ok(drifted))
    const result = await runExport({ url: 'http://api.test', project: 'p1', fetchImpl })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('project.pointRules')
  })

  it('HTTP error responses exit 1 with the envelope', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok({ error: { message: 'nope' } }, 401))
    const result = await runExport({ url: 'http://api.test', project: 'p1', fetchImpl })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('401')
    expect(result.output).toContain('nope')
  })

  it('renders a non-JSON error body as its raw text (not the literal "null")', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('502 Bad Gateway', { status: 502 })))
    const result = await runExport({ url: 'http://api.test', project: 'p1', fetchImpl })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('502')
    expect(result.output).toContain('Bad Gateway')
    expect(result.output).not.toContain('null')
  })
})

describe('import command', () => {
  async function writeConfigFile(contents: unknown): Promise<string> {
    const file = join(tmpDir, 'config.json')
    await writeFile(file, JSON.stringify(contents), 'utf8')
    return file
  }

  it('exits 1 naming PROMOCEAN_CONFIG_SECRET when the env var is missing', async () => {
    delete process.env.PROMOCEAN_CONFIG_SECRET
    const file = await writeConfigFile(minimalFile)
    const result = await runImport({ url: 'http://api.test', project: 'p1', file, prune: false, dryRun: false, fetchImpl: vi.fn() })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('PROMOCEAN_CONFIG_SECRET')
  })

  it('client-side validates the file before upload and lists zod issue paths on failure', async () => {
    const file = await writeConfigFile({ ...minimalFile, formatVersion: 2 })
    const fetchImpl = vi.fn()
    const result = await runImport({ url: 'http://api.test', project: 'p1', file, prune: false, dryRun: false, fetchImpl })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('formatVersion')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('dry-run with no changes exits 0', async () => {
    const file = await writeConfigFile(minimalFile)
    const fetchImpl = vi.fn().mockImplementation(() => ok({ applied: false, plan: emptyPlan }))
    const result = await runImport({ url: 'http://api.test', project: 'p1', file, prune: false, dryRun: true, fetchImpl })
    expect(result.exitCode).toBe(0)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/api/config-plane/projects/p1/import')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toEqual({ file: minimalFile, prune: false, dryRun: true })
  })

  it('dry-run with one create exits 2 and the table shows it', async () => {
    const file = await writeConfigFile(minimalFile)
    const planWithCreate = { ...emptyPlan, placements: { creates: ['homepage-banner'], updates: [], deletes: [], unchanged: 0 } }
    const fetchImpl = vi.fn().mockImplementation(() => ok({ applied: false, plan: planWithCreate }))
    const result = await runImport({ url: 'http://api.test', project: 'p1', file, prune: false, dryRun: true, fetchImpl })
    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('homepage-banner')
  })

  it('apply success exits 0', async () => {
    const file = await writeConfigFile(minimalFile)
    const fetchImpl = vi.fn().mockImplementation(() => ok({ applied: true, plan: emptyPlan }))
    const result = await runImport({ url: 'http://api.test', project: 'p1', file, prune: false, dryRun: false, fetchImpl })
    expect(result.exitCode).toBe(0)
  })

  it('422 partial apply exits 1 and renders stage, message, and the applied plan', async () => {
    const file = await writeConfigFile(minimalFile)
    const planAfterFailure = { ...emptyPlan, rewards: { creates: ['free-month'], updates: [], deletes: [], unchanged: 0 } }
    const body = {
      applied: true,
      plan: planAfterFailure,
      error: { stage: 'rewards/free-month', message: 'duplicate slug' },
    }
    const fetchImpl = vi.fn().mockImplementation(() => ok(body, 422))
    const result = await runImport({ url: 'http://api.test', project: 'p1', file, prune: false, dryRun: false, fetchImpl })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('rewards/free-month')
    expect(result.output).toContain('duplicate slug')
    expect(result.output).toContain('Applied plan')
    expect(result.output).toContain('free-month')
  })

  it('HTTP 401 exits 1 with the envelope', async () => {
    const file = await writeConfigFile(minimalFile)
    const fetchImpl = vi.fn().mockImplementation(() => ok({ error: { message: 'Unauthorized' } }, 401))
    const result = await runImport({ url: 'http://api.test', project: 'p1', file, prune: false, dryRun: false, fetchImpl })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('401')
    expect(result.output).toContain('Unauthorized')
  })

  it('renders a non-JSON error body as its raw text (not the literal "null")', async () => {
    const file = await writeConfigFile(minimalFile)
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('<html>500</html>', { status: 500 })))
    const result = await runImport({ url: 'http://api.test', project: 'p1', file, prune: false, dryRun: false, fetchImpl })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('500')
    expect(result.output).toContain('<html>500</html>')
    expect(result.output).not.toContain('null')
  })
})
