#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs, UsageError } from './args.js'
import { runExport } from './commands/export.js'
import { runImport } from './commands/import.js'

/**
 * Runs the CLI end-to-end and returns the process exit code. Never calls
 * process.exit itself, so it stays testable in-process.
 */
export async function run(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message)
      return 1
    }
    throw err
  }

  const result =
    parsed.command === 'export'
      ? await runExport({ url: parsed.url, project: parsed.project, out: parsed.out })
      : await runImport({
          url: parsed.url,
          project: parsed.project,
          file: parsed.file as string,
          prune: parsed.prune,
          dryRun: parsed.dryRun,
        })

  if (result.exitCode === 1) console.error(result.output)
  else console.log(result.output)

  return result.exitCode
}

// Node realpath-resolves the ESM main module before setting import.meta.url, but
// leaves process.argv[1] as the invoked path (an npm bin symlink, or a path with
// spaces that a raw `file://` concat would leave un-percent-encoded). Resolve
// argv[1] the same way — realpath then pathToFileURL — so both sides match under
// npm-installed bin symlinks and space-bearing paths alike.
const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    },
  )
}
