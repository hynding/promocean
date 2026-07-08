/** Classic O(n*m) Levenshtein edit distance, small DP matrix (rows reused). */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/**
 * Suggests the closest registered event type for an unregistered one, to help API callers
 * fix typos. Returns null if the registered list is empty or the best distance exceeds 2.
 * Ties (equal distance) are broken by registered-list order — the earliest entry wins.
 */
export function suggestEventType(input: string, registered: string[]): string | null {
  let best: string | null = null
  let bestDistance = Infinity
  for (const candidate of registered) {
    const distance = levenshtein(input, candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return bestDistance <= 2 ? best : null
}
