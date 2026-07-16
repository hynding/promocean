#!/usr/bin/env node
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

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    },
  )
}
