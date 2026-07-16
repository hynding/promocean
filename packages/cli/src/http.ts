/**
 * Response-body helpers shared by both commands.
 *
 * A body can only be consumed once, so read it as text and attempt a JSON parse
 * in a single pass: success paths validate `json` against a schema; error paths
 * render `text`/status so a non-JSON error body (an HTML 502, an empty 401)
 * shows its real content instead of the literal "null" a bare `.json().catch(()
 * => null)` would print.
 */
export async function readBody(res: Response): Promise<{ json: unknown; text: string }> {
  const text = await res.text()
  try {
    return { json: JSON.parse(text) as unknown, text }
  } catch {
    return { json: null, text }
  }
}

/**
 * Render an HTTP error body: the parsed JSON when present, else the raw non-empty
 * text, else a placeholder — never the literal "null".
 */
export function renderErrorBody(json: unknown, text: string): string {
  if (json != null) return JSON.stringify(json)
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : '(empty response body)'
}
