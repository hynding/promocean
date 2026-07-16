export interface ParsedArgs {
  command: 'export' | 'import'
  url: string
  project: string
  out?: string
  file?: string
  prune: boolean
  dryRun: boolean
}

const USAGE =
  'Usage: promocean <export|import> --url <url> --project <project> [--out <path>] [--file <path>] [--prune] [--dry-run]'

export class UsageError extends Error {}

/**
 * Hand-rolled arg parser. Throws UsageError naming the missing flag or the
 * unrecognized command/flag; never guesses defaults for required values.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv

  if (command !== 'export' && command !== 'import') {
    throw new UsageError(`Unknown command "${command ?? ''}". ${USAGE}`)
  }

  let url: string | undefined
  let project: string | undefined
  let out: string | undefined
  let file: string | undefined
  let prune = false
  let dryRun = false

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    switch (flag) {
      case '--url':
        url = rest[++i]
        break
      case '--project':
        project = rest[++i]
        break
      case '--out':
        out = rest[++i]
        break
      case '--file':
        file = rest[++i]
        break
      case '--prune':
        prune = true
        break
      case '--dry-run':
        dryRun = true
        break
      default:
        throw new UsageError(`Unknown flag "${flag}". ${USAGE}`)
    }
  }

  if (!url) throw new UsageError(`Missing required flag --url. ${USAGE}`)
  if (!project) throw new UsageError(`Missing required flag --project. ${USAGE}`)
  if (command === 'import' && !file) throw new UsageError(`Missing required flag --file. ${USAGE}`)

  // Trim trailing slash(es) so `--url http://host/` and `--url http://host` both
  // build `${url}/api/...` without a doubled slash the router would 404 on.
  url = url.replace(/\/+$/, '')

  return { command, url, project, out, file, prune, dryRun }
}
