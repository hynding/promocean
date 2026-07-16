import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the two command modules so run()'s dispatch/routing/exit-code logic can be
// tested in isolation (no fetch, no filesystem) — this is the previously-untested
// unit.
vi.mock('../src/commands/export.js', () => ({ runExport: vi.fn() }))
vi.mock('../src/commands/import.js', () => ({ runImport: vi.fn() }))

import { run } from '../src/cli.js'
import { runExport } from '../src/commands/export.js'
import { runImport } from '../src/commands/import.js'

let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.clearAllMocks()
  logSpy.mockRestore()
  errSpy.mockRestore()
})

describe('run() dispatcher', () => {
  it('no args -> usage error on stderr, exit 1', async () => {
    const code = await run([])
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalled()
    expect(String(errSpy.mock.calls[0][0])).toContain('Usage')
    expect(logSpy).not.toHaveBeenCalled()
    expect(runExport).not.toHaveBeenCalled()
    expect(runImport).not.toHaveBeenCalled()
  })

  it('a successful export dispatches to runExport, prints to stdout, exits 0', async () => {
    vi.mocked(runExport).mockResolvedValue({ exitCode: 0, output: 'EXPORT_OK' })
    const code = await run(['export', '--url', 'http://x/', '--project', 'p1'])
    expect(code).toBe(0)
    expect(runExport).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://x', project: 'p1' }))
    expect(logSpy).toHaveBeenCalledWith('EXPORT_OK')
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('a dry-run with changes exits 2 and still routes output to stdout', async () => {
    vi.mocked(runImport).mockResolvedValue({ exitCode: 2, output: 'PLAN_WITH_CHANGES' })
    const code = await run(['import', '--url', 'http://x', '--project', 'p1', '--file', 'f.json', '--dry-run'])
    expect(code).toBe(2)
    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, file: 'f.json' }))
    expect(logSpy).toHaveBeenCalledWith('PLAN_WITH_CHANGES')
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('an exit-1 command result routes output to stderr', async () => {
    vi.mocked(runImport).mockResolvedValue({ exitCode: 1, output: 'BOOM' })
    const code = await run(['import', '--url', 'http://x', '--project', 'p1', '--file', 'f.json'])
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalledWith('BOOM')
    expect(logSpy).not.toHaveBeenCalled()
  })
})
