import { readFile } from 'node:fs/promises'
import { configFileSchema, importResponseSchema } from '@promocean/contracts'
import { readBody, renderErrorBody } from '../http.js'
import { planHasChanges, renderPlan } from '../render.js'
import type { CommandResult } from '../types.js'

export interface ImportOptions {
  url: string
  project: string
  file: string
  prune: boolean
  dryRun: boolean
  fetchImpl?: typeof fetch
}

const ENV_VAR = 'PROMOCEAN_CONFIG_SECRET'

export async function runImport(opts: ImportOptions): Promise<CommandResult> {
  const secret = process.env[ENV_VAR]
  if (!secret) {
    return { exitCode: 1, output: `Error: the ${ENV_VAR} environment variable is required.` }
  }

  let raw: string
  try {
    raw = await readFile(opts.file, 'utf8')
  } catch (err) {
    return { exitCode: 1, output: `Error: could not read file "${opts.file}": ${(err as Error).message}` }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { exitCode: 1, output: `Error: "${opts.file}" is not valid JSON: ${(err as Error).message}` }
  }

  // Validate the file client-side BEFORE upload — fail fast, list zod issue paths.
  const parsedFile = configFileSchema.safeParse(json)
  if (!parsedFile.success) {
    const issues = parsedFile.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
    return { exitCode: 1, output: `Error: "${opts.file}" failed configFileSchema validation:\n${issues}` }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${opts.url}/api/config-plane/projects/${encodeURIComponent(opts.project)}/import`
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'x-config-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify({ file: parsedFile.data, prune: opts.prune, dryRun: opts.dryRun }),
  })
  const { json: body, text } = await readBody(res)

  // 422: partial apply. Still an ImportResponse shape — render the (applied) plan
  // with error.stage/message prominent, but this is always a failure exit.
  if (res.status === 422) {
    const parsed = importResponseSchema.safeParse(body)
    if (!parsed.success) {
      return { exitCode: 1, output: `Error: import failed (HTTP 422) with an unparseable response: ${renderErrorBody(body, text)}` }
    }
    return { exitCode: 1, output: renderPlan(parsed.data) }
  }

  if (!res.ok) {
    return { exitCode: 1, output: `Error: import request failed (HTTP ${res.status}): ${renderErrorBody(body, text)}` }
  }

  const parsed = importResponseSchema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
    return { exitCode: 1, output: `Error: server import response failed importResponseSchema validation:\n${issues}` }
  }

  const output = renderPlan(parsed.data)
  if (opts.dryRun) {
    return { exitCode: planHasChanges(parsed.data.plan) ? 2 : 0, output }
  }
  return { exitCode: 0, output }
}
