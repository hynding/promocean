import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Regression coverage for the npm-bin no-op bug: an npm-installed `promocean`
// runs through a bin *symlink*. Node realpath-resolves the ESM main module
// (import.meta.url) but leaves process.argv[1] as the symlink path, so the old
// `import.meta.url === \`file://${process.argv[1]}\`` check was false and the CLI
// silently exited 0 with no output. These tests exercise the REAL built binary as
// a subprocess (never importing its source) — both directly and through a symlink.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(pkgRoot, 'dist', 'cli.js')

let symlinkDir: string

function runNode(binPath: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile('node', [binPath, ...args], (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0
      resolvePromise({ code, stdout, stderr })
    })
  })
}

beforeAll(() => {
  // Build fresh so the subprocess runs the current source (the pre-existing dist/
  // may be stale). `test` only dependsOn `^build` in turbo, not the package's own
  // build, so produce dist/ here.
  execFileSync('pnpm', ['exec', 'tsc'], { cwd: pkgRoot, stdio: 'ignore' })
}, 120_000)

afterAll(async () => {
  if (symlinkDir) await rm(symlinkDir, { recursive: true, force: true })
})

describe('bin entrypoint (real subprocess)', () => {
  it('runs its dispatcher when invoked directly (no args -> usage, exit 1)', async () => {
    const result = await runNode(cliPath, [])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Usage')
  })

  it('runs its dispatcher when invoked through a symlink (npm-bin regression)', async () => {
    symlinkDir = await mkdtemp(join(tmpdir(), 'promocean-cli-bin-'))
    const link = join(symlinkDir, 'promocean')
    await symlink(cliPath, link)

    const result = await runNode(link, [])
    // The pre-fix build would no-op here (exit 0, empty output) because the symlink
    // path never equals the realpath'd import.meta.url.
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Usage')
  })
})
