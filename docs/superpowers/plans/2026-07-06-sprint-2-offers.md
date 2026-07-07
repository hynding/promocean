# Promocean Sprint 2: First-Party Offers Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the offers vertical slice end-to-end: an offer defined in Strapi (attached to a named placement, with an optional schedule window) renders in the demo app via `<Placement>`, records impressions and clicks, and supports client-side dismissal.

**Architecture:** Extends Sprint 0-1's two-plane architecture. Offer/Placement *definitions* live in Strapi behind a new config-plane endpoint; offer *resolution* is a pure function in `@promocean/core` (schedule computed on read, UTC instants, no cron — same rule as timed events); impressions/clicks are runtime state in Postgres. SDK and widgets talk only to `apps/api`.

**Tech Stack:** unchanged from Sprint 0-1 (Node 22, pnpm/Turborepo, Zod 4, Hono 4, Drizzle, Strapi 5, Next 15, Vitest 3, Playwright).

**Spec:** `docs/superpowers/specs/2026-07-06-promocean-design.md` §4.1 (Offer, Placement), §4.4 (read paths), §5 (widgets fail silent-to-empty, SDK dismissal persistence). Timed-event attachment of offers is Sprint 3 — out of scope here.

## Global Constraints

(All Sprint 0-1 global constraints still bind: licensing split, `"type": "module"`, strict TS, tenancy `projectId`+`environment` on every runtime table enforced in adapter-db, error envelope codes from `contracts`, conventional commits, `workspace:*` internal deps, tsconfig `outDir` override pattern, commit pnpm-lock.yaml with new deps.)

Sprint-2 additions:
- Offer schedule fields are absolute UTC instants, nullable (`null` = unbounded); an offer is active when `(!startsAt || startsAt <= now) && (!endsAt || endsAt > now)`.
- `audience` is fixed to `{ kind: 'everyone' }` in this sprint but flows through the types as a discriminated union so segments can slot in later without schema breaks (spec §4.1).
- Impressions/clicks are append-only inserts — no read-modify-write (issue #3's counter race does not apply here; do not copy the progress-counter pattern).
- Known accepted risk (issue #2): the ingestion path is not yet transactional; offer metric recording failures must not fail the offer response (record, and on error log + continue).
- Dismissal is client-side only in MVP (SDK localStorage; spec §5); server-side frequency caps are v2.
- Placement slugs match `/^[a-z][a-z0-9-]*$/` (kebab-case, distinct from snake_case event types).

---

### Task 1: `@promocean/contracts` — offer schemas

**Files:**
- Create: `packages/contracts/src/offers.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/offers.test.ts`

**Interfaces:**
- Consumes: existing zod/error-envelope patterns in the package.
- Produces (exact exports used by api/sdk/widgets):
  - `PLACEMENT_SLUG_PATTERN` (RegExp `/^[a-z][a-z0-9-]*$/`)
  - `offerCreativeSchema`, type `OfferCreative = { offerId: string; headline: string; body: string | null; imageUrl: string | null; ctaText: string | null; ctaUrl: string | null }`
  - `placementOfferResponseSchema`, type `PlacementOfferResponse = { offer: OfferCreative | null }`
  - `offerClickRequestSchema`, type `OfferClickRequest = { userId?: string }`
  - `offerClickResponseSchema`, type `OfferClickResponse = { recorded: boolean }`

- [ ] **Step 1: Write the failing tests**

`packages/contracts/test/offers.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  offerCreativeSchema,
  placementOfferResponseSchema,
  offerClickRequestSchema,
  PLACEMENT_SLUG_PATTERN,
} from '../src/index.js'

const creative = {
  offerId: 'o1', headline: 'Go Pro', body: null, imageUrl: null, ctaText: 'Upgrade', ctaUrl: 'https://example.com/pro',
}

describe('offer schemas', () => {
  it('round-trips a creative', () => {
    expect(offerCreativeSchema.parse(creative)).toEqual(creative)
  })
  it('placement response allows null offer', () => {
    expect(placementOfferResponseSchema.parse({ offer: null })).toEqual({ offer: null })
    expect(placementOfferResponseSchema.parse({ offer: creative }).offer?.offerId).toBe('o1')
  })
  it('click request userId is optional but non-empty when present', () => {
    expect(offerClickRequestSchema.safeParse({}).success).toBe(true)
    expect(offerClickRequestSchema.safeParse({ userId: 'u1' }).success).toBe(true)
    expect(offerClickRequestSchema.safeParse({ userId: '' }).success).toBe(false)
  })
  it('placement slug pattern is kebab-case', () => {
    expect(PLACEMENT_SLUG_PATTERN.test('homepage-banner')).toBe(true)
    for (const bad of ['Homepage', 'home_page', '9lives', '']) expect(PLACEMENT_SLUG_PATTERN.test(bad)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @promocean/contracts test`
Expected: FAIL — `offerCreativeSchema` not exported.

- [ ] **Step 3: Implement**

`packages/contracts/src/offers.ts`:
```ts
import { z } from 'zod'

export const PLACEMENT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/

export const offerCreativeSchema = z.object({
  offerId: z.string(),
  headline: z.string(),
  body: z.string().nullable(),
  imageUrl: z.string().nullable(),
  ctaText: z.string().nullable(),
  ctaUrl: z.string().nullable(),
})
export type OfferCreative = z.infer<typeof offerCreativeSchema>

export const placementOfferResponseSchema = z.object({
  offer: offerCreativeSchema.nullable(),
})
export type PlacementOfferResponse = z.infer<typeof placementOfferResponseSchema>

export const offerClickRequestSchema = z.object({
  userId: z.string().min(1).max(128).optional(),
})
export type OfferClickRequest = z.infer<typeof offerClickRequestSchema>

export const offerClickResponseSchema = z.object({ recorded: z.boolean() })
export type OfferClickResponse = z.infer<typeof offerClickResponseSchema>
```

Append to `packages/contracts/src/index.ts`:
```ts
export * from './offers.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @promocean/contracts test && pnpm --filter @promocean/contracts build`
Expected: all PASS (existing 6 + new 4).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): offer creative, placement response, and click schemas"
```

---

### Task 2: `@promocean/core` — offer domain + ports

**Files:**
- Create: `packages/core/src/offers.ts`
- Modify: `packages/core/src/types.ts`, `packages/core/src/ports.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/offers.test.ts`

**Interfaces:**
- Consumes: existing `Scope` type.
- Produces (exact signatures downstream tasks rely on):

```ts
// types.ts additions
export type OfferAudience = { kind: 'everyone' }
export interface OfferDefinition {
  id: string
  placementSlug: string
  headline: string
  body: string | null
  imageUrl: string | null
  ctaText: string | null
  ctaUrl: string | null
  startsAt: Date | null
  endsAt: Date | null
  priority: number
  audience: OfferAudience
}

// offers.ts
export function resolveOffer(placementSlug: string, offers: OfferDefinition[], now: Date): OfferDefinition | null

// ports.ts changes
export interface ConfigStore {
  getAchievements(projectId: string): Promise<AchievementDefinition[]>
  getOffers(projectId: string): Promise<OfferDefinition[]>   // NEW method on existing port
}
export interface OfferMetricsStore {                          // NEW port
  recordImpression(scope: Scope, offerId: string, userId: string | null, at: Date): Promise<void>
  recordClick(scope: Scope, offerId: string, userId: string | null, at: Date): Promise<void>
}
```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/offers.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { resolveOffer, type OfferDefinition } from '../src/index.js'

const base = {
  headline: 'x', body: null, imageUrl: null, ctaText: null, ctaUrl: null,
  priority: 0, audience: { kind: 'everyone' as const },
}
const now = new Date('2026-07-15T12:00:00Z')
const offers: OfferDefinition[] = [
  { ...base, id: 'evergreen', placementSlug: 'homepage-banner', startsAt: null, endsAt: null },
  { ...base, id: 'past', placementSlug: 'homepage-banner', startsAt: new Date('2026-06-01T00:00:00Z'), endsAt: new Date('2026-06-30T00:00:00Z') },
  { ...base, id: 'future', placementSlug: 'homepage-banner', startsAt: new Date('2026-08-01T00:00:00Z'), endsAt: null },
  { ...base, id: 'live-priority', placementSlug: 'homepage-banner', startsAt: new Date('2026-07-01T00:00:00Z'), endsAt: new Date('2026-08-01T00:00:00Z'), priority: 10 },
  { ...base, id: 'other-slot', placementSlug: 'sidebar', startsAt: null, endsAt: null },
]

describe('resolveOffer', () => {
  it('returns the highest-priority active offer for the placement', () => {
    expect(resolveOffer('homepage-banner', offers, now)?.id).toBe('live-priority')
  })
  it('excludes past, future, and other-placement offers', () => {
    const active = resolveOffer('sidebar', offers, now)
    expect(active?.id).toBe('other-slot')
    expect(resolveOffer('homepage-banner', offers, new Date('2026-09-01T00:00:00Z'))?.id).toBe('evergreen')
  })
  it('treats endsAt as exclusive and startsAt as inclusive', () => {
    expect(resolveOffer('homepage-banner', [offers[3]], new Date('2026-08-01T00:00:00Z'))).toBeNull()
    expect(resolveOffer('homepage-banner', [offers[3]], new Date('2026-07-01T00:00:00Z'))?.id).toBe('live-priority')
  })
  it('returns null when nothing matches', () => {
    expect(resolveOffer('nonexistent', offers, now)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @promocean/core test`
Expected: FAIL — `resolveOffer` not exported.

- [ ] **Step 3: Implement**

`packages/core/src/offers.ts`:
```ts
import type { OfferDefinition } from './types.js'

export function resolveOffer(
  placementSlug: string,
  offers: OfferDefinition[],
  now: Date,
): OfferDefinition | null {
  let best: OfferDefinition | null = null
  for (const offer of offers) {
    if (offer.placementSlug !== placementSlug) continue
    if (offer.startsAt && offer.startsAt > now) continue
    if (offer.endsAt && offer.endsAt <= now) continue
    if (!best || offer.priority > best.priority) best = offer
  }
  return best
}
```

Add the `OfferAudience`/`OfferDefinition` types to `types.ts`, the `getOffers` method to `ConfigStore` and the `OfferMetricsStore` interface to `ports.ts` (exactly as in the Interfaces block), and `export * from './offers.js'` to `index.ts`.

- [ ] **Step 4: Run tests, then check downstream breakage**

Run: `pnpm --filter @promocean/core test && pnpm turbo run typecheck`
Expected: core tests PASS. **Typecheck FAILS in `@promocean/adapter-strapi` and `apps/api`** (their `ConfigStore` implementations/fakes lack `getOffers`) — this is expected and is fixed in Tasks 5 and 6. Record the exact failures in the report; do NOT patch those packages in this task.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): offer definition, pure resolution, and metrics/config ports"
```

---

### Task 3: `@promocean/adapter-db` — offer metrics store

**Files:**
- Modify: `packages/adapter-db/src/schema.ts`, `packages/adapter-db/src/stores.ts`, `packages/adapter-db/src/index.ts`
- Create (generated): new migration under `packages/adapter-db/migrations/`
- Test: `packages/adapter-db/test/offer-metrics.test.ts`

**Interfaces:**
- Consumes: `OfferMetricsStore`, `Scope` from `@promocean/core` (Task 2); existing `Db`, `runMigrations`, Testcontainers test pattern from `test/stores.test.ts`.
- Produces: `class PgOfferMetricsStore implements OfferMetricsStore` — `new PgOfferMetricsStore(db)`; exported from index. Table `runtime.offer_events`.

- [ ] **Step 1: Schema + migration**

Append to `packages/adapter-db/src/schema.ts`:
```ts
export const offerEvents = runtime.table('offer_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  offerId: text('offer_id').notNull(),
  userId: text('user_id'),
  kind: text('kind').notNull(), // 'impression' | 'click'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
```

Run: `pnpm --filter @promocean/adapter-db db:generate`
Expected: a new migration SQL file creating `runtime.offer_events`.

- [ ] **Step 2: Write the failing test**

`packages/adapter-db/test/offer-metrics.test.ts`:
```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgOfferMetricsStore, type Db } from '../src/index.js'
import type { Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
const scope: Scope = { projectId: 'p1', environment: 'test' }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
})
afterAll(async () => { await db.$client.end(); await container.stop() })

describe('PgOfferMetricsStore', () => {
  it('records impressions and clicks with tenancy and nullable user', async () => {
    const store = new PgOfferMetricsStore(db)
    const at = new Date()
    await store.recordImpression(scope, 'o1', 'u1', at)
    await store.recordImpression(scope, 'o1', null, at)
    await store.recordClick(scope, 'o1', 'u1', at)
    const { rows } = await db.$client.query(
      `select kind, user_id from runtime.offer_events where project_id='p1' and offer_id='o1' order by kind`,
    )
    expect(rows).toEqual([
      { kind: 'click', user_id: 'u1' },
      { kind: 'impression', user_id: 'u1' },
      { kind: 'impression', user_id: null },
    ])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @promocean/adapter-db test`
Expected: FAIL — `PgOfferMetricsStore` not exported (existing 4 store tests still PASS).

- [ ] **Step 4: Implement**

Append to `packages/adapter-db/src/stores.ts`:
```ts
export class PgOfferMetricsStore implements OfferMetricsStore {
  constructor(private db: Db) {}
  async recordImpression(scope: Scope, offerId: string, userId: string | null, at: Date) {
    await this.db.insert(offerEvents).values({ ...scope, offerId, userId, kind: 'impression', createdAt: at })
  }
  async recordClick(scope: Scope, offerId: string, userId: string | null, at: Date) {
    await this.db.insert(offerEvents).values({ ...scope, offerId, userId, kind: 'click', createdAt: at })
  }
}
```
(Import `OfferMetricsStore` from `@promocean/core` and `offerEvents` from `./schema.js`; export the class from `src/index.ts`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @promocean/adapter-db test && pnpm --filter @promocean/adapter-db build`
Expected: 5/5 PASS; build copies migrations.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-db
git commit -m "feat(adapter-db): offer_events table and PgOfferMetricsStore"
```

---

### Task 4: `apps/cms` — Placement/Offer content types, config-plane offers endpoint, seed

**Files:**
- Create: `apps/cms/src/api/placement/content-types/placement/schema.json` (+ default core router/controller/service files)
- Create: `apps/cms/src/api/offer/content-types/offer/schema.json` (+ default core files)
- Modify: `apps/cms/src/api/config-plane/routes/config-plane.ts`, `apps/cms/src/api/config-plane/controllers/config-plane.ts`, `apps/cms/src/index.ts` (seed)

**Interfaces:**
- Consumes: existing `configSecretOk(ctx)` guard, existing seed structure, existing content-type file patterns (copy `achievement`'s router/controller/service factory files).
- Produces (protocol Task 5's client consumes):
  - `GET {STRAPI_URL}/api/config-plane/offers?projectId=<documentId>` + `x-config-secret` → `200 { offers: [{ id, placementSlug, headline, body, imageUrl, ctaText, ctaUrl, startsAt, endsAt, priority }] }` (dates as ISO strings or null); `401` bad secret; `400` missing projectId.
  - Seed additions (same `SEED_DEMO` gate, inside the existing empty-DB block): placement `homepage-banner`; offer "Welcome to Promocean" attached to it — headline `Welcome to Promocean`, body `Track achievements and run promos from one API.`, ctaText `Learn more`, ctaUrl `https://github.com/hynding/promocean`, no schedule, priority 0.

- [ ] **Step 1: Content-type schemas**

`apps/cms/src/api/placement/content-types/placement/schema.json`:
```json
{
  "kind": "collectionType",
  "collectionName": "placements",
  "info": { "singularName": "placement", "pluralName": "placements", "displayName": "Placement" },
  "options": { "draftAndPublish": false },
  "attributes": {
    "name": { "type": "string", "required": true },
    "slug": { "type": "string", "required": true, "regex": "^[a-z][a-z0-9-]*$" },
    "project": { "type": "relation", "relation": "manyToOne", "target": "api::project.project" }
  }
}
```

`apps/cms/src/api/offer/content-types/offer/schema.json`:
```json
{
  "kind": "collectionType",
  "collectionName": "offers",
  "info": { "singularName": "offer", "pluralName": "offers", "displayName": "Offer" },
  "options": { "draftAndPublish": false },
  "attributes": {
    "name": { "type": "string", "required": true },
    "headline": { "type": "string", "required": true },
    "body": { "type": "text" },
    "imageUrl": { "type": "string" },
    "ctaText": { "type": "string" },
    "ctaUrl": { "type": "string" },
    "startsAt": { "type": "datetime" },
    "endsAt": { "type": "datetime" },
    "priority": { "type": "integer", "default": 0, "required": true },
    "placement": { "type": "relation", "relation": "manyToOne", "target": "api::placement.placement" },
    "project": { "type": "relation", "relation": "manyToOne", "target": "api::project.project" }
  }
}
```

For both types create the standard factory files (mirror `apps/cms/src/api/achievement/routes|controllers|services/achievement.ts`, substituting the type uid).

- [ ] **Step 2: Config-plane offers endpoint**

Add to `apps/cms/src/api/config-plane/routes/config-plane.ts` routes array:
```ts
{ method: 'GET', path: '/config-plane/offers', handler: 'config-plane.offers', config: { auth: false } },
```

Add to the controller (reusing `configSecretOk`):
```ts
async offers(ctx: any) {
  if (!configSecretOk(ctx)) return ctx.unauthorized()
  const projectId = String(ctx.query.projectId ?? '')
  if (!projectId) return ctx.badRequest('projectId is required')
  const rows = await strapi.documents('api::offer.offer').findMany({
    filters: { project: { documentId: projectId } },
    populate: ['placement'],
  })
  ctx.body = {
    offers: rows
      .filter((r: any) => r.placement?.slug)
      .map((r: any) => ({
        id: r.documentId,
        placementSlug: r.placement.slug,
        headline: r.headline,
        body: r.body ?? null,
        imageUrl: r.imageUrl ?? null,
        ctaText: r.ctaText ?? null,
        ctaUrl: r.ctaUrl ?? null,
        startsAt: r.startsAt ?? null,
        endsAt: r.endsAt ?? null,
        priority: r.priority ?? 0,
      })),
  }
},
```

- [ ] **Step 3: Extend the seed**

Inside the existing `SEED_DEMO` block in `apps/cms/src/index.ts`, after the achievements loop:
```ts
const placement = await strapi.documents('api::placement.placement').create({
  data: { name: 'Homepage Banner', slug: 'homepage-banner', project: project.documentId },
})
await strapi.documents('api::offer.offer').create({
  data: {
    name: 'Welcome offer',
    headline: 'Welcome to Promocean',
    body: 'Track achievements and run promos from one API.',
    ctaText: 'Learn more',
    ctaUrl: 'https://github.com/hynding/promocean',
    priority: 0,
    placement: placement.documentId,
    project: project.documentId,
  },
})
```

- [ ] **Step 4: Manual verification**

Note: the seed only runs on an empty DB. For verification either use a fresh database (e.g. `docker compose down -v && docker compose up -d postgres`) or create the placement/offer manually via the admin UI, then:

Run: `pnpm --filter cms typecheck && pnpm --filter cms dev`, then
```bash
curl -s -H 'x-config-secret: dev-config-secret' 'http://localhost:1337/api/config-plane/offers?projectId=<PROJECT_ID>'
```
Expected: the seeded offer with `placementSlug: "homepage-banner"`, nulls for imageUrl/schedule; 401 without the header; 400 without projectId. Stop Strapi after. (If the DB was recreated: the admin auto-seed from ADMIN_* runs too — log in once to confirm.)

- [ ] **Step 5: Commit**

```bash
git add apps/cms
git commit -m "feat(cms): placement and offer content types, config-plane offers endpoint, seed"
```

---

### Task 5: `@promocean/adapter-strapi` — getOffers

**Files:**
- Modify: `packages/adapter-strapi/src/index.ts`
- Test: append to `packages/adapter-strapi/test/adapter.test.ts`

**Interfaces:**
- Consumes: `OfferDefinition`, updated `ConfigStore` from `@promocean/core`; the Task 4 endpoint protocol.
- Produces: `StrapiConfigPlane.getOffers(projectId): Promise<OfferDefinition[]>` — same TTL cache + stale-on-error semantics as `getAchievements` (separate cache map); parses `startsAt`/`endsAt` ISO strings to `Date | null`; injects `audience: { kind: 'everyone' }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/adapter-strapi/test/adapter.test.ts`:
```ts
const offersBody = {
  offers: [{
    id: 'o1', placementSlug: 'homepage-banner', headline: 'Welcome to Promocean',
    body: null, imageUrl: null, ctaText: 'Learn more', ctaUrl: 'https://example.com',
    startsAt: '2026-07-01T00:00:00.000Z', endsAt: null, priority: 0,
  }],
}

describe('StrapiConfigPlane.getOffers', () => {
  it('fetches, maps dates to Date|null, and injects audience', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(offersBody))
    const offers = await makePlane(fetchImpl).getOffers('p1')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://cms.test/api/config-plane/offers?projectId=p1')
    expect(offers[0]).toMatchObject({ id: 'o1', placementSlug: 'homepage-banner', endsAt: null, audience: { kind: 'everyone' } })
    expect(offers[0].startsAt).toEqual(new Date('2026-07-01T00:00:00.000Z'))
  })
  it('caches within TTL and serves stale on error', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(offersBody))
      .mockImplementation(() => Promise.reject(new Error('down')))
    const plane = makePlane(fetchImpl, 0)
    await plane.getOffers('p1')
    expect((await plane.getOffers('p1'))[0].id).toBe('o1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @promocean/adapter-strapi test`
Expected: FAIL — `getOffers` missing (also confirms the Task 2 typecheck break: the class no longer satisfies `ConfigStore`).

- [ ] **Step 3: Implement**

Add to `StrapiConfigPlane` (new cache map `offersCache = new Map<string, CacheEntry<OfferDefinition[]>>()`):
```ts
async getOffers(projectId: string): Promise<OfferDefinition[]> {
  const cached = this.offersCache.get(projectId)
  if (cached && cached.expires > Date.now()) return cached.value
  try {
    const res = await this.fetchImpl(
      `${this.opts.baseUrl}/api/config-plane/offers?projectId=${encodeURIComponent(projectId)}`,
      { headers: this.headers() },
    )
    if (!res.ok) throw new Error(`config plane responded ${res.status}`)
    const body = (await res.json()) as { offers: Array<Record<string, unknown>> }
    const offers: OfferDefinition[] = body.offers.map((o) => ({
      id: String(o.id),
      placementSlug: String(o.placementSlug),
      headline: String(o.headline),
      body: (o.body as string | null) ?? null,
      imageUrl: (o.imageUrl as string | null) ?? null,
      ctaText: (o.ctaText as string | null) ?? null,
      ctaUrl: (o.ctaUrl as string | null) ?? null,
      startsAt: o.startsAt ? new Date(String(o.startsAt)) : null,
      endsAt: o.endsAt ? new Date(String(o.endsAt)) : null,
      priority: Number(o.priority ?? 0),
      audience: { kind: 'everyone' },
    }))
    this.offersCache.set(projectId, { value: offers, expires: Date.now() + this.ttl })
    return offers
  } catch (err) {
    if (cached) return cached.value
    throw err
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @promocean/adapter-strapi test && pnpm --filter @promocean/adapter-strapi build`
Expected: 8/8 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): getOffers with TTL cache and stale-on-error"
```

---

### Task 6: `apps/api` — placement resolution + click endpoints

**Files:**
- Create: `apps/api/src/routes/placements.ts`, `apps/api/src/routes/offers.ts`
- Modify: `apps/api/src/app.ts` (mount routes, extend `AppDeps`), `apps/api/src/index.ts` (wire `PgOfferMetricsStore`), `apps/api/test/fakes.ts`
- Test: `apps/api/test/offers.test.ts`

**Interfaces:**
- Consumes: `resolveOffer`, `OfferDefinition`, `OfferMetricsStore` from core; `placementOfferResponseSchema`/`offerClickRequestSchema` shapes from contracts; `PgOfferMetricsStore` from adapter-db.
- Produces HTTP surface (auth: Bearer key, same middleware):
  - `GET /v1/placements/:slug/offer?userId=<optional>` → `200 PlacementOfferResponse`; records an impression when an offer resolves (userId attributed when supplied, else null); **metric-recording failure logs and does not fail the response**; unknown slug → `200 { offer: null }` (not 404 — widgets fail silent-to-empty).
  - `POST /v1/offers/:id/click` body `OfferClickRequest` → `200 { recorded: true }`; invalid body → `400 invalid_payload`.
  - `AppDeps` gains `offerMetricsStore: OfferMetricsStore`; fakes updated (`getOffers` on the config fake, recording arrays on a metrics fake).

- [ ] **Step 1: Update fakes + write the failing tests**

In `apps/api/test/fakes.ts`: `makeFakes` gains a second definitions param `offers: OfferDefinition[] = []`; the `configStore` fake adds `getOffers: async () => offers`; add:
```ts
const metrics: { impressions: Array<{ offerId: string; userId: string | null }>; clicks: Array<{ offerId: string; userId: string | null }> } = { impressions: [], clicks: [] }
const offerMetricsStore: OfferMetricsStore = {
  recordImpression: async (_s, offerId, userId) => { metrics.impressions.push({ offerId, userId }) },
  recordClick: async (_s, offerId, userId) => { metrics.clicks.push({ offerId, userId }) },
}
```
Return `offerMetricsStore` and `metrics` from `makeFakes`.

`apps/api/test/offers.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

const offer = {
  id: 'o1', placementSlug: 'homepage-banner', headline: 'Welcome to Promocean',
  body: null, imageUrl: null, ctaText: 'Learn more', ctaUrl: 'https://example.com',
  startsAt: null, endsAt: null, priority: 0, audience: { kind: 'everyone' as const },
}
const auth = { projectId: 'p1', environment: 'test' as const, keyType: 'publishable' as const }
const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }

function setup() {
  const fakes = makeFakes([], auth, [offer])
  return { app: createApp(fakes), fakes }
}

describe('GET /v1/placements/:slug/offer', () => {
  it('resolves the active offer and records an attributed impression', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/placements/homepage-banner/offer?userId=u1', { headers })
    expect(res.status).toBe(200)
    expect((await res.json()).offer).toMatchObject({ offerId: 'o1', headline: 'Welcome to Promocean' })
    expect(fakes.metrics.impressions).toEqual([{ offerId: 'o1', userId: 'u1' }])
  })
  it('returns null offer for an empty placement and records nothing', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/placements/sidebar/offer', { headers })
    expect((await res.json()).offer).toBeNull()
    expect(fakes.metrics.impressions).toEqual([])
  })
  it('still returns the offer if impression recording throws', async () => {
    const { app, fakes } = setup()
    fakes.offerMetricsStore.recordImpression = async () => { throw new Error('db down') }
    const res = await app.request('/v1/placements/homepage-banner/offer', { headers })
    expect(res.status).toBe(200)
    expect((await res.json()).offer?.offerId).toBe('o1')
  })
})

describe('POST /v1/offers/:id/click', () => {
  it('records a click with optional user attribution', async () => {
    const { app, fakes } = setup()
    const res = await app.request('/v1/offers/o1/click', { method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }) })
    expect((await res.json())).toEqual({ recorded: true })
    expect(fakes.metrics.clicks).toEqual([{ offerId: 'o1', userId: 'u1' }])
  })
  it('rejects an invalid body', async () => {
    const { app } = setup()
    const res = await app.request('/v1/offers/o1/click', { method: 'POST', headers, body: JSON.stringify({ userId: '' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api test`
Expected: new file FAILS (routes missing); existing `app.test.ts` must be updated for the new `makeFakes` signature if needed (the added params have defaults — verify it still passes).

- [ ] **Step 3: Implement**

`apps/api/src/routes/placements.ts`:
```ts
import { Hono } from 'hono'
import type { PlacementOfferResponse } from '@promocean/contracts'
import { resolveOffer, type Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function placementsRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/:slug/offer', async (c) => {
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const slug = c.req.param('slug')
    const userId = c.req.query('userId') ?? null
    const offers = await deps.configStore.getOffers(scope.projectId)
    const offer = resolveOffer(slug, offers, new Date())
    if (offer) {
      try {
        await deps.offerMetricsStore.recordImpression(scope, offer.id, userId, new Date())
      } catch (err) {
        console.error('impression recording failed', err)
      }
    }
    return c.json({
      offer: offer
        ? { offerId: offer.id, headline: offer.headline, body: offer.body, imageUrl: offer.imageUrl, ctaText: offer.ctaText, ctaUrl: offer.ctaUrl }
        : null,
    } satisfies PlacementOfferResponse)
  })
  return app
}
```

`apps/api/src/routes/offers.ts`:
```ts
import { Hono } from 'hono'
import { offerClickRequestSchema, type OfferClickResponse } from '@promocean/contracts'
import type { Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function offersRoute(deps: AppDeps) {
  const app = new Hono()
  app.post('/:id/click', async (c) => {
    const parsed = offerClickRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid click payload.', details: parsed.error.issues } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    await deps.offerMetricsStore.recordClick(scope, c.req.param('id'), parsed.data.userId ?? null, new Date())
    return c.json({ recorded: true } satisfies OfferClickResponse)
  })
  return app
}
```

In `app.ts`: add `offerMetricsStore: OfferMetricsStore` to `AppDeps`; `app.route('/v1/placements', placementsRoute(deps))`; `app.route('/v1/offers', offersRoute(deps))`. In `index.ts`: `offerMetricsStore: new PgOfferMetricsStore(db)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter api test && pnpm turbo run typecheck`
Expected: 11/11 api tests PASS; workspace typecheck GREEN again (Tasks 5+6 close the Task 2 break).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): placement offer resolution with impressions, and click endpoint"
```

---

### Task 7: `@promocean/sdk` — offer methods + dismissal persistence

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Test: append to `packages/sdk/test/sdk.test.ts`

**Interfaces:**
- Consumes: `placementOfferResponseSchema`, `OfferCreative` from contracts; existing `request()` retry helper.
- Produces (widgets rely on these exact signatures):
  - `getPlacementOffer(slug: string): Promise<OfferCreative | null>` — appends `?userId=` when identified; works without identify.
  - `clickOffer(offerId: string): Promise<void>` — POSTs click with userId when identified; errors are swallowed (fire-and-forget; a failed click must never break the host page).
  - `dismissOffer(offerId: string): void` / `isOfferDismissed(offerId: string): boolean` — persisted in `localStorage` key `promocean:dismissed:<offerId>`; falls back to an in-memory `Set` when localStorage is unavailable (SSR/node) — never throws.

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/test/sdk.test.ts`:
```ts
const offerBody = { offer: { offerId: 'o1', headline: 'Welcome', body: null, imageUrl: null, ctaText: null, ctaUrl: null } }

describe('offers', () => {
  it('getPlacementOffer resolves with user attribution', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(offerBody))
    const offer = await client(fetchImpl).getPlacementOffer('homepage-banner')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://api.test/v1/placements/homepage-banner/offer?userId=u1')
    expect(offer?.offerId).toBe('o1')
  })
  it('getPlacementOffer returns null offers as null', async () => {
    const c = client(vi.fn().mockImplementation(() => ok({ offer: null })))
    expect(await c.getPlacementOffer('homepage-banner')).toBeNull()
  })
  it('clickOffer swallows errors', async () => {
    const c = client(vi.fn().mockImplementation(() => Promise.reject(new Error('down'))), { maxRetries: 0 })
    await expect(c.clickOffer('o1')).resolves.toBeUndefined()
  })
  it('dismissal persists in memory when localStorage is unavailable', () => {
    const c = client(vi.fn())
    expect(c.isOfferDismissed('o1')).toBe(false)
    c.dismissOffer('o1')
    expect(c.isOfferDismissed('o1')).toBe(true)
  })
})
```
(Node has no `localStorage`, so this test exercises the in-memory fallback path directly.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @promocean/sdk test`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement**

Add to the `Promocean` class:
```ts
private dismissedFallback = new Set<string>()

async getPlacementOffer(slug: string): Promise<OfferCreative | null> {
  const qs = this.userId ? `?userId=${encodeURIComponent(this.userId)}` : ''
  const res = await this.request(`/v1/placements/${encodeURIComponent(slug)}/offer${qs}`)
  return placementOfferResponseSchema.parse(await res.json()).offer
}

async clickOffer(offerId: string): Promise<void> {
  try {
    await this.request(`/v1/offers/${encodeURIComponent(offerId)}/click`, {
      method: 'POST',
      body: JSON.stringify(this.userId ? { userId: this.userId } : {}),
    })
  } catch {
    // fire-and-forget: a failed click must never break the host page
  }
}

private dismissalKey(offerId: string) { return `promocean:dismissed:${offerId}` }

dismissOffer(offerId: string): void {
  try { globalThis.localStorage.setItem(this.dismissalKey(offerId), '1') }
  catch { this.dismissedFallback.add(offerId) }
}

isOfferDismissed(offerId: string): boolean {
  try { return globalThis.localStorage.getItem(this.dismissalKey(offerId)) === '1' }
  catch { return this.dismissedFallback.has(offerId) }
}
```
(Import `OfferCreative`, `placementOfferResponseSchema` from contracts.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @promocean/sdk test && pnpm --filter @promocean/sdk build`
Expected: 11/11 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): placement offers, fire-and-forget clicks, and dismissal persistence"
```

---

### Task 8: `@promocean/widgets` — `<Placement>` component

**Files:**
- Create: `packages/widgets/src/placement.tsx`
- Modify: `packages/widgets/src/index.ts`
- Test: append to `packages/widgets/test/widgets.test.tsx`

**Interfaces:**
- Consumes: `usePromocean()`, sdk's `getPlacementOffer`/`clickOffer`/`dismissOffer`/`isOfferDismissed`, `OfferCreative` from contracts.
- Produces: `<Placement slug="homepage-banner" />` — fetches on mount; renders nothing while loading, on error, when offer is null, or when dismissed; renders headline/body/image/CTA; CTA anchor (`target="_blank" rel="noopener noreferrer"`) fires `clickOffer`; dismiss button (`aria-label="Dismiss offer"`) hides it and persists via `dismissOffer`. Container carries `data-promocean-placement={slug}`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/widgets/test/widgets.test.tsx` (extend `fakeClient` with `getPlacementOffer: vi.fn().mockResolvedValue(offer)`, `clickOffer: vi.fn().mockResolvedValue(undefined)`, `dismissOffer: vi.fn()`, `isOfferDismissed: vi.fn().mockReturnValue(false)`):
```tsx
const offerCreative = { offerId: 'o1', headline: 'Welcome to Promocean', body: 'Run promos from one API.', imageUrl: null, ctaText: 'Learn more', ctaUrl: 'https://example.com' }

describe('Placement', () => {
  it('renders the resolved offer with CTA and fires clickOffer', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockResolvedValue(offerCreative)
    render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Welcome to Promocean')).toBeDefined())
    const cta = screen.getByRole('link', { name: 'Learn more' })
    expect(cta.getAttribute('href')).toBe('https://example.com')
    cta.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(client.clickOffer).toHaveBeenCalledWith('o1')
  })
  it('renders nothing when no offer resolves or fetch fails', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockRejectedValue(new Error('down'))
    const { container } = render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(client.getPlacementOffer).toHaveBeenCalled())
    expect(container.querySelector('[data-promocean-placement]')).toBeNull()
  })
  it('dismiss hides the offer and persists', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockResolvedValue(offerCreative)
    render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Welcome to Promocean')).toBeDefined())
    screen.getByRole('button', { name: 'Dismiss offer' }).click()
    expect(client.dismissOffer).toHaveBeenCalledWith('o1')
    expect(screen.queryByText('Welcome to Promocean')).toBeNull()
  })
})
```
(Wrap the `.click()` and `dispatchEvent` calls in `act()` as the existing tests do if React warns.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @promocean/widgets test`
Expected: FAIL — `Placement` not exported.

- [ ] **Step 3: Implement**

`packages/widgets/src/placement.tsx`:
```tsx
import { useEffect, useState } from 'react'
import type { OfferCreative } from '@promocean/contracts'
import { usePromocean } from './provider.js'

export function Placement({ slug }: { slug: string }) {
  const client = usePromocean()
  const [offer, setOffer] = useState<OfferCreative | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    client.getPlacementOffer(slug)
      .then((o) => { if (!cancelled) setOffer(o) })
      .catch(() => {}) // fail silent-to-empty
    return () => { cancelled = true }
  }, [client, slug])

  if (!offer || dismissed || client.isOfferDismissed(offer.offerId)) return null

  return (
    <div data-promocean-placement={slug}
         style={{ position: 'relative', border: '1px solid #ddd', borderRadius: 8, padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <button aria-label="Dismiss offer"
              onClick={() => { client.dismissOffer(offer.offerId); setDismissed(true) }}
              style={{ position: 'absolute', top: 8, right: 8, border: 'none', background: 'none', cursor: 'pointer', fontSize: 16 }}>
        ×
      </button>
      {offer.imageUrl ? <img src={offer.imageUrl} alt="" style={{ maxWidth: '100%', borderRadius: 4 }} /> : null}
      <div style={{ fontWeight: 600 }}>{offer.headline}</div>
      {offer.body ? <div style={{ fontSize: 14, color: '#555', marginTop: 4 }}>{offer.body}</div> : null}
      {offer.ctaUrl ? (
        <a href={offer.ctaUrl} target="_blank" rel="noopener noreferrer"
           onClick={() => { void client.clickOffer(offer.offerId) }}
           style={{ display: 'inline-block', marginTop: 8, fontWeight: 600 }}>
          {offer.ctaText ?? 'Learn more'}
        </a>
      ) : null}
    </div>
  )
}
```

Add `export { Placement } from './placement.js'` to `src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @promocean/widgets test && pnpm --filter @promocean/widgets build`
Expected: 6/6 PASS, pristine output.

- [ ] **Step 5: Commit**

```bash
git add packages/widgets
git commit -m "feat(widgets): placement component with click tracking and dismissal"
```

---

### Task 9: `apps/demo` — placement integration + offers e2e

**Files:**
- Modify: `apps/demo/app/promocean.tsx`
- Test: `apps/demo/e2e/offer-loop.spec.ts`

**Interfaces:**
- Consumes: `Placement` from widgets; the seeded `homepage-banner` placement + "Welcome to Promocean" offer (Task 4); running stack (cms + api + demo, DB on 5433).
- Produces: the demo page shows the offer banner above the action buttons; a new e2e proving render → dismiss → stays dismissed after reload. CI needs no changes (the e2e job runs the whole `e2e/` directory). **Note:** the CI database is fresh every run, so the Task 4 seed additions run there automatically.

- [ ] **Step 1: Integrate the placement**

In `apps/demo/app/promocean.tsx`, inside `<main>` directly under the `<p>User: …</p>` line:
```tsx
<Placement slug="homepage-banner" />
```
(add `Placement` to the widgets import).

- [ ] **Step 2: Manual smoke test**

Stack running (`pnpm dev` with local envs; DB has the seeded offer — recreate the DB or add the offer via admin UI if your dev DB predates Task 4's seed): open `http://localhost:3002/?user=manual-2`.
Expected: banner "Welcome to Promocean" with body + "Learn more" CTA; × dismisses it; reload keeps it dismissed (localStorage); a fresh private window shows it again.

- [ ] **Step 3: Write the e2e**

`apps/demo/e2e/offer-loop.spec.ts`:
```ts
import { expect, test } from '@playwright/test'

test('offer renders, dismisses, and stays dismissed across reload', async ({ page }) => {
  const user = `e2e-offer-${Date.now()}`
  await page.goto(`/?user=${user}`)
  const banner = page.locator('[data-promocean-placement="homepage-banner"]')
  await expect(banner.getByText('Welcome to Promocean')).toBeVisible()
  await expect(banner.getByRole('link', { name: 'Learn more' })).toBeVisible()
  await banner.getByRole('button', { name: 'Dismiss offer' }).click()
  await expect(banner).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-promocean-placement="homepage-banner"]')).toHaveCount(0)
})
```

- [ ] **Step 4: Run the e2e**

Run (stack running): `pnpm --filter demo e2e`
Expected: 2 passed (achievement-loop + offer-loop). **This green run is the Sprint 2 definition of done.**

- [ ] **Step 5: Full workspace green + commit**

Run: `pnpm turbo run typecheck build test`
Expected: all green.

```bash
git add apps/demo
git commit -m "feat(demo): homepage placement with offer dismissal e2e"
```

---

## Self-Review Notes

- **Spec coverage (Sprint 2 scope):** Offer + Placement entities ✓ (T4); placement resolution read path with impression recording ✓ (T6); click tracking ✓ (T6/T7); schedule window on read, UTC instants ✓ (T2); audience as extensible union fixed to `everyone` ✓ (T2/T5); SDK dismissal persistence ✓ (T7, spec §5); widgets fail silent-to-empty ✓ (T8); demo + e2e as DoD ✓ (T9). Deferred per spec: offer attachment to timed events (Sprint 3), server-side frequency caps + segmentation (v2), stats endpoint (v1.x, issue backlog).
- **Cross-task break handling:** Task 2 intentionally breaks typecheck in adapter-strapi/api (ConfigStore gains `getOffers`); Tasks 5 and 6 close it. The plan says to record, not patch, in Task 2 — reviewers of Tasks 2–5 should expect a red workspace typecheck between those gates (per-package checks stay green).
- **Type consistency:** `OfferDefinition` fields, `OfferCreative` fields (`offerId` not `id` on the wire — mapped in T6), `getOffers`, `recordImpression/recordClick`, `getPlacementOffer/clickOffer/dismissOffer/isOfferDismissed`, and `data-promocean-placement` verified consistent across Tasks 1–9.
- **Placeholder scan:** clean — every code step contains the actual code.
