/**
 * Pure plan computation for the config-plane import endpoint (Sprint 11 Task 4).
 *
 * Keeps the controller thin: given the parsed config file, the current
 * project state mapped into the same file shape, the project's slug, and the
 * prune flag, produce the slug-keyed plan (creates/updates/deletes/unchanged)
 * the response reports. Cross-reference resolution (offers -> placement /
 * timedEvent by slug) also lives here so the handler can reject unknown refs
 * BEFORE any write.
 *
 * Everything here is a pure function of its inputs — no strapi, no I/O — so the
 * exact same computation drives (a) the dry-run response, (b) the applied
 * plan, and (c) the RECOMPUTED plan after a mid-run lifecycle rejection
 * (re-run against the re-queried DB state; see the controller). Determinism
 * matters: the dry-run plan must deep-equal the subsequent apply's plan, so
 * every bucket is built in a fixed order (file order for creates/updates,
 * current order for deletes).
 */

import type { ConfigFile, ImportResponse } from '@promocean/contracts'

export type TypePlan = ImportResponse['plan']['placements']
export type Plan = ImportResponse['plan']

/**
 * The current project state, mapped into the same shape the file uses (the
 * export handler's output shape, minus formatVersion). Diffs compare file
 * definitions against this.
 */
export type CurrentState = {
  project: ConfigFile['project']
  placements: ConfigFile['placements']
  achievements: ConfigFile['achievements']
  timedEvents: ConfigFile['timedEvents']
  offers: ConfigFile['offers']
  rewards: ConfigFile['rewards']
}

export type UnknownRef = { offer: string; ref: string; type: 'placement' | 'timedEvent' }

// --- normalization ---------------------------------------------------------

// Datetimes cross the boundary as ISO strings on both sides (the file carries
// z.iso.datetime() strings; strapi.documents() returns ISO strings), but their
// precision/offset spelling can differ (e.g. a trailing ".000", a "+00:00" vs
// "Z"). Normalize both through Date.toISOString() before comparing so an
// idempotent re-import is seen as unchanged.
function normDate(v: string | null | undefined): string | null {
  if (v == null) return null
  return new Date(v).toISOString()
}

// Unify explicit null and undefined (a field the mapper left off) to null, so
// they never register as a spurious diff.
function nullish<T>(v: T | null | undefined): T | null {
  return v == null ? null : v
}

function recordEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false
  }
  return true
}

// registeredEventTypes is compared as a SET — order-insensitive, per the plan.
function setEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}

// allowedOrigins is an ordered list-or-null; both-null is equal, otherwise
// element-wise (order preserved by round-trip).
function arrayOrNullEqual(a: string[] | null, b: string[] | null): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// --- per-type diff ---------------------------------------------------------

function diffType<F extends { slug: string }, C extends { slug: string }>(
  fileItems: F[],
  currentItems: C[],
  prune: boolean,
  differs: (f: F, c: C) => boolean,
): TypePlan {
  const currentBySlug = new Map(currentItems.map((c) => [c.slug, c]))
  const fileSlugs = new Set(fileItems.map((f) => f.slug))
  const creates: string[] = []
  const updates: string[] = []
  let unchanged = 0
  for (const f of fileItems) {
    const c = currentBySlug.get(f.slug)
    if (!c) {
      creates.push(f.slug)
      continue
    }
    if (differs(f, c)) updates.push(f.slug)
    else unchanged++
  }
  const deletes = prune ? currentItems.filter((c) => !fileSlugs.has(c.slug)).map((c) => c.slug) : []
  return { creates, updates, deletes, unchanged }
}

// Project settings are a singleton: update-or-unchanged, its creates/deletes
// buckets always empty. The updates bucket names the project's own slug when
// any of the three settings fields diverge.
function projectPlan(
  file: ConfigFile['project'],
  current: ConfigFile['project'],
  projectSlug: string,
): TypePlan {
  const differs =
    !recordEqual(file.pointRules, current.pointRules) ||
    !setEqual(file.registeredEventTypes, current.registeredEventTypes) ||
    !arrayOrNullEqual(file.allowedOrigins, current.allowedOrigins)
  return {
    creates: [],
    updates: differs ? [projectSlug] : [],
    deletes: [],
    unchanged: differs ? 0 : 1,
  }
}

export function computePlan(
  file: ConfigFile,
  current: CurrentState,
  projectSlug: string,
  prune: boolean,
): Plan {
  return {
    project: projectPlan(file.project, current.project, projectSlug),
    placements: diffType(file.placements, current.placements, prune, (f, c) => f.name !== c.name),
    achievements: diffType(
      file.achievements,
      current.achievements,
      prune,
      (f, c) =>
        f.name !== c.name ||
        nullish(f.description) !== nullish(c.description) ||
        nullish(f.artworkUrl) !== nullish(c.artworkUrl) ||
        f.eventType !== c.eventType ||
        f.targetCount !== c.targetCount ||
        f.pointsValue !== c.pointsValue,
    ),
    timedEvents: diffType(
      file.timedEvents,
      current.timedEvents,
      prune,
      (f, c) =>
        f.name !== c.name ||
        nullish(f.description) !== nullish(c.description) ||
        normDate(f.startsAt) !== normDate(c.startsAt) ||
        normDate(f.endsAt) !== normDate(c.endsAt) ||
        f.endingSoonMinutes !== c.endingSoonMinutes ||
        f.multiplier !== c.multiplier ||
        f.recurrence !== c.recurrence ||
        normDate(f.recurrenceEndsAt) !== normDate(c.recurrenceEndsAt) ||
        f.enabled !== c.enabled,
    ),
    offers: diffType(
      file.offers,
      current.offers,
      prune,
      (f, c) =>
        f.name !== c.name ||
        f.headline !== c.headline ||
        nullish(f.body) !== nullish(c.body) ||
        nullish(f.imageUrl) !== nullish(c.imageUrl) ||
        nullish(f.ctaText) !== nullish(c.ctaText) ||
        nullish(f.ctaUrl) !== nullish(c.ctaUrl) ||
        normDate(f.startsAt) !== normDate(c.startsAt) ||
        normDate(f.endsAt) !== normDate(c.endsAt) ||
        f.priority !== c.priority ||
        f.placement !== c.placement ||
        nullish(f.timedEvent) !== nullish(c.timedEvent),
    ),
    rewards: diffType(
      file.rewards,
      current.rewards,
      prune,
      (f, c) =>
        f.name !== c.name ||
        nullish(f.description) !== nullish(c.description) ||
        f.codeType !== c.codeType ||
        nullish(f.staticCode) !== nullish(c.staticCode) ||
        nullish(f.codePrefix) !== nullish(c.codePrefix) ||
        f.pointsPrice !== c.pointsPrice ||
        normDate(f.startsAt) !== normDate(c.startsAt) ||
        normDate(f.endsAt) !== normDate(c.endsAt) ||
        f.perUserLimit !== c.perUserLimit ||
        nullish(f.inventory) !== nullish(c.inventory) ||
        f.enabled !== c.enabled,
    ),
  }
}

// Every offer.placement must resolve against (existing ∪ file-created)
// placement slugs, and every non-null offer.timedEvent against (existing ∪
// file-created) timed-event slugs. Anything unresolved is a hard 400 BEFORE any
// write. Collect every violation (not fail-fast) so an operator sees them all.
export function findUnknownRefs(file: ConfigFile, current: CurrentState): UnknownRef[] {
  const placementSlugs = new Set<string>([
    ...current.placements.map((p) => p.slug),
    ...file.placements.map((p) => p.slug),
  ])
  const timedEventSlugs = new Set<string>([
    ...current.timedEvents.map((t) => t.slug),
    ...file.timedEvents.map((t) => t.slug),
  ])
  const out: UnknownRef[] = []
  for (const o of file.offers) {
    if (!placementSlugs.has(o.placement)) {
      out.push({ offer: o.slug, ref: o.placement, type: 'placement' })
    }
    if (o.timedEvent != null && !timedEventSlugs.has(o.timedEvent)) {
      out.push({ offer: o.slug, ref: o.timedEvent, type: 'timedEvent' })
    }
  }
  return out
}
