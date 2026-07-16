import { writeFile } from 'node:fs/promises'
import { configFileSchema } from '@promocean/contracts'
import type { CommandResult } from '../types.js'

export interface ExportOptions {
  url: string
  project: string
  out?: string
  fetchImpl?: typeof fetch
}

const ENV_VAR = 'PROMOCEAN_CONFIG_SECRET'

export async function runExport(opts: ExportOptions): Promise<CommandResult> {
  const secret = process.env[ENV_VAR]
  if (!secret) {
    return { exitCode: 1, output: `Error: the ${ENV_VAR} environment variable is required.` }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${opts.url}/api/config-plane/projects/${encodeURIComponent(opts.project)}/export`
  const res = await fetchImpl(url, { headers: { 'x-config-secret': secret } })
  const body: unknown = await res.json().catch(() => null)

  if (!res.ok) {
    return { exitCode: 1, output: `Error: export request failed (HTTP ${res.status}): ${JSON.stringify(body)}` }
  }

  // Defense against a drifted server: validate the response before writing anything.
  const parsed = configFileSchema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
    return { exitCode: 1, output: `Error: server export response failed configFileSchema validation:\n${issues}` }
  }

  const json = `${JSON.stringify(parsed.data, null, 2)}\n`
  if (opts.out) {
    await writeFile(opts.out, json, 'utf8')
    return { exitCode: 0, output: `Wrote ${opts.out}` }
  }
  return { exitCode: 0, output: json }
}
