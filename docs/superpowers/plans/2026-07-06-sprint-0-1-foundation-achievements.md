# Promocean Sprint 0–1: Foundation + Achievements Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Promocean pnpm/Turborepo monorepo and ship the achievements vertical slice end-to-end: an achievement defined in Strapi unlocks via `sdk.track()` and renders a toast + badge cabinet in the demo app.

**Architecture:** Two planes — Strapi v5 (`apps/cms`) holds definitions, keys, and projects; a Hono runtime API (`apps/api`) owns event ingestion and evaluation. All domain logic is pure TypeScript in `packages/core` behind ports; `adapter-strapi` (config plane, via shared-secret config endpoints) and `adapter-db` (Postgres/Drizzle, `runtime` schema) implement them. SDK and widgets talk only to the runtime API.

**Tech Stack:** Node ≥22, pnpm 10 (corepack), Turborepo 2, TypeScript 5 (strict, ESM), Zod 4, Hono 4 + @hono/node-server, Drizzle ORM + drizzle-kit, Postgres 17 (Docker), Strapi v5 (TS), Next.js 15, Vitest 3, Testcontainers, Playwright, React 19.

**Spec:** `docs/superpowers/specs/2026-07-06-promocean-design.md`. Sprints 2–4 (offers, timed events, polish) get their own plans later.

## Global Constraints

- Node `>=22`, `"type": "module"` everywhere, TypeScript `strict: true`.
- Licensing: `contracts`, `sdk`, `widgets`, `config` are MIT (own LICENSE file); everything else GPL-3.0 (root LICENSE). Every package.json declares `"license"`.
- Every runtime table carries `project_id` and `environment` (`test` | `live`); tenancy filtering happens in `adapter-db` only.
- Event types: free-form, must match `/^[a-z][a-z0-9_]*$/`.
- Error responses always use the envelope `{ error: { code, message, details? } }` with codes from `contracts`.
- Idempotency: unique `(project_id, environment, idempotency_key)`; duplicates are no-ops returning `deduped: true`.
- Secret material: only SHA-256 hex hashes of API keys are stored/transmitted to the config plane; plaintext keys are shown once.
- Package names: `@promocean/<dir-name>`. Internal deps use `workspace:*`.
- Commits: conventional style (`feat:`, `test:`, `chore:`), one commit per task minimum.

---

### Task 1: Monorepo scaffold + shared config package

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.env.example`, `docker-compose.yml`
- Create: `packages/config/package.json`, `packages/config/tsconfig.base.json`, `packages/config/LICENSE` (MIT)
- Modify: `.gitignore` (append), `README.md` (replace)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `@promocean/config` exporting `tsconfig.base.json`; root scripts `pnpm typecheck|test|build|dev`; Postgres on `localhost:5432` (user/pass/db `promocean`).

- [ ] **Step 1: Root workspace files**

`package.json`:
```json
{
  "name": "promocean",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.12.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "dev": "turbo run dev --parallel",
    "db:up": "docker compose up -d postgres"
  },
  "devDependencies": {
    "turbo": "^2.5.4",
    "typescript": "^5.8.3"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

`.nvmrc`:
```
22
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: promocean
      POSTGRES_PASSWORD: promocean
      POSTGRES_DB: promocean
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

`.env.example`:
```
DATABASE_URL=postgres://promocean:promocean@localhost:5432/promocean
CONFIG_PLANE_SECRET=dev-config-secret
STRAPI_URL=http://localhost:1337
API_PORT=3001
SEED_DEMO=true
NEXT_PUBLIC_PROMOCEAN_KEY=pk_test_demo_1234567890abcdef
NEXT_PUBLIC_PROMOCEAN_API=http://localhost:3001
```

Append to `.gitignore`:
```
dist/
.turbo/
.env
*.tsbuildinfo
```

Replace `README.md`:
```markdown
# Promocean

Achievements, offers, and live promotional events for any website or app — one API.

Monorepo: pnpm + Turborepo. See `docs/superpowers/specs/` for the design spec.

## Quickstart (dev)

    corepack enable && pnpm install
    cp .env.example .env
    pnpm db:up
    pnpm dev
```

- [ ] **Step 2: Shared tsconfig package**

`packages/config/package.json`:
```json
{
  "name": "@promocean/config",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "files": ["tsconfig.base.json"],
  "scripts": {
    "typecheck": "echo ok",
    "test": "echo ok",
    "build": "echo ok"
  }
}
```

`packages/config/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "outDir": "dist"
  }
}
```

`packages/config/LICENSE`: MIT license text with `Copyright (c) 2026 Steve Hynding`.

- [ ] **Step 3: Verify the workspace resolves**

Run: `corepack enable && pnpm install && pnpm turbo run typecheck`
Expected: install succeeds; turbo reports 1 successful task (`@promocean/config#typecheck`).

Run: `pnpm db:up && docker compose ps`
Expected: `postgres` service `running`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm/turborepo monorepo with shared tsconfig and postgres compose"
```

---

### Task 2: `@promocean/contracts` — API schemas (MIT)

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/LICENSE` (MIT), `packages/contracts/vitest.config.ts`
- Create: `packages/contracts/src/index.ts`, `packages/contracts/src/errors.ts`, `packages/contracts/src/events.ts`, `packages/contracts/src/achievements.ts`
- Test: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Consumes: nothing internal.
- Produces (exact exports used by api/sdk/widgets):
  - `trackEventRequestSchema`, type `TrackEventRequest = { userId: string; type: string; idempotencyKey: string; occurredAt?: string; meta?: Record<string, unknown> }`
  - `trackEventResponseSchema`, type `TrackEventResponse = { deduped: boolean; unlocks: UnlockPayload[]; progress: { achievementId: string; current: number; target: number }[] }`
  - `unlockPayloadSchema`, type `UnlockPayload = { achievementId: string; name: string; unlockedAt: string }`
  - `userAchievementsResponseSchema`, type `UserAchievementsResponse = { achievements: AchievementStatus[] }`; `AchievementStatus = { achievementId: string; name: string; description: string | null; artworkUrl: string | null; current: number; target: number; unlockedAt: string | null }`
  - `errorEnvelopeSchema`, type `ErrorEnvelope`; `errorCodeSchema` enum: `invalid_api_key | invalid_payload | rate_limited | origin_not_allowed | not_found | internal_error`
  - `EVENT_TYPE_PATTERN` (RegExp)

- [ ] **Step 1: Package skeleton**

`packages/contracts/package.json`:
```json
{
  "name": "@promocean/contracts",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^4.0.5" },
  "devDependencies": {
    "@promocean/config": "workspace:*",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

`packages/contracts/tsconfig.json`:
```json
{
  "extends": "@promocean/config/tsconfig.base.json",
  "include": ["src"]
}
```

`packages/contracts/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

- [ ] **Step 2: Write the failing tests**

`packages/contracts/test/contracts.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  trackEventRequestSchema,
  trackEventResponseSchema,
  errorEnvelopeSchema,
  EVENT_TYPE_PATTERN,
} from '../src/index.js'

describe('trackEventRequestSchema', () => {
  it('accepts a valid request', () => {
    const r = trackEventRequestSchema.safeParse({
      userId: 'u1',
      type: 'lesson_completed',
      idempotencyKey: 'a'.repeat(12),
      meta: { lessonId: 42 },
    })
    expect(r.success).toBe(true)
  })
  it('rejects bad event types', () => {
    for (const type of ['Lesson', '9lives', 'has space', ''])
      expect(trackEventRequestSchema.safeParse({ userId: 'u', type, idempotencyKey: 'a'.repeat(12) }).success).toBe(false)
  })
  it('rejects short idempotency keys', () => {
    expect(trackEventRequestSchema.safeParse({ userId: 'u', type: 'ok_type', idempotencyKey: 'short' }).success).toBe(false)
  })
})

describe('response and error schemas', () => {
  it('round-trips a track response', () => {
    const payload = {
      deduped: false,
      unlocks: [{ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }],
      progress: [{ achievementId: 'a1', current: 1, target: 1 }],
    }
    expect(trackEventResponseSchema.parse(payload)).toEqual(payload)
  })
  it('rejects unknown error codes', () => {
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false)
  })
  it('exports the event type pattern', () => {
    expect(EVENT_TYPE_PATTERN.test('lesson_completed')).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @promocean/contracts test`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Implement the schemas**

`packages/contracts/src/errors.ts`:
```ts
import { z } from 'zod'

export const errorCodeSchema = z.enum([
  'invalid_api_key',
  'invalid_payload',
  'rate_limited',
  'origin_not_allowed',
  'not_found',
  'internal_error',
])
export type ErrorCode = z.infer<typeof errorCodeSchema>

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>
```

`packages/contracts/src/events.ts`:
```ts
import { z } from 'zod'

export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/

export const trackEventRequestSchema = z.object({
  userId: z.string().min(1).max(128),
  type: z.string().regex(EVENT_TYPE_PATTERN).max(64),
  idempotencyKey: z.string().min(8).max(128),
  occurredAt: z.iso.datetime().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type TrackEventRequest = z.infer<typeof trackEventRequestSchema>

export const unlockPayloadSchema = z.object({
  achievementId: z.string(),
  name: z.string(),
  unlockedAt: z.iso.datetime(),
})
export type UnlockPayload = z.infer<typeof unlockPayloadSchema>

export const trackEventResponseSchema = z.object({
  deduped: z.boolean(),
  unlocks: z.array(unlockPayloadSchema),
  progress: z.array(
    z.object({ achievementId: z.string(), current: z.number().int(), target: z.number().int() }),
  ),
})
export type TrackEventResponse = z.infer<typeof trackEventResponseSchema>
```

`packages/contracts/src/achievements.ts`:
```ts
import { z } from 'zod'

export const achievementStatusSchema = z.object({
  achievementId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  current: z.number().int(),
  target: z.number().int(),
  unlockedAt: z.iso.datetime().nullable(),
})
export type AchievementStatus = z.infer<typeof achievementStatusSchema>

export const userAchievementsResponseSchema = z.object({
  achievements: z.array(achievementStatusSchema),
})
export type UserAchievementsResponse = z.infer<typeof userAchievementsResponseSchema>
```

`packages/contracts/src/index.ts`:
```ts
export * from './errors.js'
export * from './events.js'
export * from './achievements.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @promocean/contracts test && pnpm --filter @promocean/contracts build`
Expected: all tests PASS; `dist/` emitted.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): zod schemas for events, achievements, and error envelope"
```

---

### Task 3: `@promocean/core` — domain, ports, evaluation (GPL)

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts`, `packages/core/src/types.ts`, `packages/core/src/ports.ts`, `packages/core/src/evaluate.ts`
- Test: `packages/core/test/evaluate.test.ts`

**Interfaces:**
- Consumes: nothing internal (zero runtime deps — this package must not import zod, drizzle, or anything else).
- Produces (exact signatures every later task relies on):

```ts
export type Environment = 'test' | 'live'
export interface Scope { projectId: string; environment: Environment }
export interface AchievementDefinition {
  id: string; name: string; description: string | null; artworkUrl: string | null
  eventType: string; targetCount: number
}
export interface TrackedEvent { userId: string; type: string; occurredAt: Date }
export interface EvaluationResult {
  progressUpdates: { achievementId: string; current: number; target: number }[]
  unlocks: { achievementId: string; name: string }[]
}
export function evaluateEvent(
  event: TrackedEvent,
  definitions: AchievementDefinition[],
  currentCounts: Map<string, number>,
  multiplier?: number, // default 1; timed-event effects arrive in Sprint 3
): EvaluationResult

export interface AuthContext { projectId: string; environment: Environment; keyType: 'publishable' | 'secret' }
export interface ConfigStore { getAchievements(projectId: string): Promise<AchievementDefinition[]> }
export interface ApiKeyStore { verifyKey(rawKey: string): Promise<AuthContext | null> }
export interface EventStore {
  insertEvent(scope: Scope, event: {
    userId: string; type: string; idempotencyKey: string; occurredAt: Date; meta?: Record<string, unknown>
  }): Promise<{ deduped: boolean }>
}
export interface ProgressStore {
  getCounts(scope: Scope, userId: string, achievementIds: string[]): Promise<Map<string, number>>
  setProgress(scope: Scope, userId: string, achievementId: string, current: number): Promise<void>
  recordUnlock(scope: Scope, userId: string, achievementId: string, unlockedAt: Date): Promise<boolean>
  getUserAchievements(scope: Scope, userId: string): Promise<Array<{ achievementId: string; current: number; unlockedAt: Date | null }>>
}
export interface UsageStore { recordUsage(scope: Scope, userId: string, month: string): Promise<void> }
```

- [ ] **Step 1: Package skeleton**

`packages/core/package.json`:
```json
{
  "name": "@promocean/core",
  "version": "0.0.1",
  "license": "GPL-3.0-only",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@promocean/config": "workspace:*",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

`packages/core/tsconfig.json` and `vitest.config.ts`: identical in shape to Task 2's (extends base; test include `test/**/*.test.ts`).

- [ ] **Step 2: Write the failing tests**

`packages/core/test/evaluate.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { evaluateEvent, type AchievementDefinition } from '../src/index.js'

const defs: AchievementDefinition[] = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 },
  { id: 'a2', name: 'Getting Started', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 10 },
  { id: 'a3', name: 'Profiled', description: null, artworkUrl: null, eventType: 'profile_completed', targetCount: 1 },
]
const event = { userId: 'u1', type: 'lesson_completed', occurredAt: new Date('2026-07-06T00:00:00Z') }

describe('evaluateEvent', () => {
  it('increments matching achievements and unlocks at target', () => {
    const r = evaluateEvent(event, defs, new Map())
    expect(r.progressUpdates).toEqual([
      { achievementId: 'a1', current: 1, target: 1 },
      { achievementId: 'a2', current: 1, target: 10 },
    ])
    expect(r.unlocks).toEqual([{ achievementId: 'a1', name: 'First Lesson' }])
  })
  it('ignores non-matching event types', () => {
    const r = evaluateEvent({ ...event, type: 'signup' }, defs, new Map())
    expect(r.progressUpdates).toEqual([])
    expect(r.unlocks).toEqual([])
  })
  it('never advances past target and never re-unlocks', () => {
    const r = evaluateEvent(event, defs, new Map([['a1', 1], ['a2', 3]]))
    expect(r.progressUpdates).toEqual([{ achievementId: 'a2', current: 4, target: 10 }])
    expect(r.unlocks).toEqual([])
  })
  it('applies a multiplier and clamps to target', () => {
    const r = evaluateEvent(event, defs, new Map([['a1', 0], ['a2', 9]]), 2)
    expect(r.progressUpdates).toContainEqual({ achievementId: 'a2', current: 10, target: 10 })
    expect(r.unlocks).toContainEqual({ achievementId: 'a2', name: 'Getting Started' })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @promocean/core test`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Implement types, ports, evaluate**

`packages/core/src/types.ts`: the `Environment`, `Scope`, `AchievementDefinition`, `TrackedEvent`, `EvaluationResult`, `AuthContext` types exactly as in the Interfaces block above.

`packages/core/src/ports.ts`: the `ConfigStore`, `ApiKeyStore`, `EventStore`, `ProgressStore`, `UsageStore` interfaces exactly as in the Interfaces block above (import types from `./types.js`).

`packages/core/src/evaluate.ts`:
```ts
import type { AchievementDefinition, EvaluationResult, TrackedEvent } from './types.js'

export function evaluateEvent(
  event: TrackedEvent,
  definitions: AchievementDefinition[],
  currentCounts: Map<string, number>,
  multiplier = 1,
): EvaluationResult {
  const progressUpdates: EvaluationResult['progressUpdates'] = []
  const unlocks: EvaluationResult['unlocks'] = []
  for (const def of definitions) {
    if (def.eventType !== event.type) continue
    const prev = currentCounts.get(def.id) ?? 0
    if (prev >= def.targetCount) continue
    const current = Math.min(prev + 1 * multiplier, def.targetCount)
    progressUpdates.push({ achievementId: def.id, current, target: def.targetCount })
    if (current >= def.targetCount) unlocks.push({ achievementId: def.id, name: def.name })
  }
  return { progressUpdates, unlocks }
}
```

`packages/core/src/index.ts`:
```ts
export * from './types.js'
export * from './ports.js'
export * from './evaluate.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @promocean/core test && pnpm --filter @promocean/core build`
Expected: 4 tests PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): domain types, storage/config ports, and pure achievement evaluation"
```

---

### Task 4: `@promocean/adapter-db` — Drizzle schema + stores (GPL)

**Files:**
- Create: `packages/adapter-db/package.json`, `packages/adapter-db/tsconfig.json`, `packages/adapter-db/vitest.config.ts`, `packages/adapter-db/drizzle.config.ts`
- Create: `packages/adapter-db/src/index.ts`, `packages/adapter-db/src/schema.ts`, `packages/adapter-db/src/stores.ts`, `packages/adapter-db/src/migrate.ts`
- Create (generated): `packages/adapter-db/migrations/*` via drizzle-kit
- Test: `packages/adapter-db/test/stores.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `ProgressStore`, `UsageStore`, `Scope` from `@promocean/core` (Task 3).
- Produces:
  - `createDb(connectionString: string): NodePgDatabase` (also exports type `Db`)
  - `runMigrations(db: Db): Promise<void>`
  - `class PgEventStore implements EventStore` — `new PgEventStore(db)`
  - `class PgProgressStore implements ProgressStore` — `new PgProgressStore(db)`
  - `class PgUsageStore implements UsageStore` — `new PgUsageStore(db)`

- [ ] **Step 1: Package skeleton**

`packages/adapter-db/package.json`:
```json
{
  "name": "@promocean/adapter-db",
  "version": "0.0.1",
  "license": "GPL-3.0-only",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc && cp -r migrations dist/migrations",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@promocean/core": "workspace:*",
    "drizzle-orm": "^0.44.0",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "@promocean/config": "workspace:*",
    "@testcontainers/postgresql": "^11.0.0",
    "@types/pg": "^8.15.0",
    "drizzle-kit": "^0.31.0",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

`packages/adapter-db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
})
```

`vitest.config.ts`: as Task 2 but add `test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 }` (container startup).

- [ ] **Step 2: Schema**

`packages/adapter-db/src/schema.ts`:
```ts
import { integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const runtime = pgSchema('runtime')

export const events = runtime.table('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('events_idem_uq').on(t.projectId, t.environment, t.idempotencyKey)])

export const achievementProgress = runtime.table('achievement_progress', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  userId: text('user_id').notNull(),
  achievementId: text('achievement_id').notNull(),
  current: integer('current').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('progress_uq').on(t.projectId, t.environment, t.userId, t.achievementId)])

export const unlocks = runtime.table('unlocks', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  userId: text('user_id').notNull(),
  achievementId: text('achievement_id').notNull(),
  unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex('unlocks_uq').on(t.projectId, t.environment, t.userId, t.achievementId)])

export const monthlyActiveUsers = runtime.table('monthly_active_users', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  month: text('month').notNull(),
  userId: text('user_id').notNull(),
}, (t) => [uniqueIndex('mau_uq').on(t.projectId, t.environment, t.month, t.userId)])

export const usageCounters = runtime.table('usage_counters', {
  projectId: text('project_id').notNull(),
  environment: text('environment').notNull(),
  month: text('month').notNull(),
  eventsCount: integer('events_count').notNull().default(0),
}, (t) => [uniqueIndex('usage_uq').on(t.projectId, t.environment, t.month)])
```

Run: `pnpm --filter @promocean/adapter-db db:generate`
Expected: a SQL migration file appears under `packages/adapter-db/migrations/`.

- [ ] **Step 3: Write the failing tests**

`packages/adapter-db/test/stores.test.ts`:
```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations, PgEventStore, PgProgressStore, PgUsageStore, type Db } from '../src/index.js'
import type { Scope } from '@promocean/core'

let container: StartedPostgreSqlContainer
let db: Db
const scope: Scope = { projectId: 'p1', environment: 'test' }
const otherScope: Scope = { projectId: 'p2', environment: 'test' }

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
})
afterAll(async () => { await container.stop() })

describe('PgEventStore', () => {
  it('inserts then dedupes on idempotency key', async () => {
    const store = new PgEventStore(db)
    const e = { userId: 'u1', type: 'lesson_completed', idempotencyKey: 'k1234567', occurredAt: new Date() }
    expect((await store.insertEvent(scope, e)).deduped).toBe(false)
    expect((await store.insertEvent(scope, e)).deduped).toBe(true)
    expect((await store.insertEvent(otherScope, e)).deduped).toBe(false) // tenancy isolation
  })
})

describe('PgProgressStore', () => {
  it('sets and reads progress scoped by tenant', async () => {
    const store = new PgProgressStore(db)
    await store.setProgress(scope, 'u1', 'a1', 3)
    await store.setProgress(scope, 'u1', 'a1', 4)
    const counts = await store.getCounts(scope, 'u1', ['a1', 'a2'])
    expect(counts.get('a1')).toBe(4)
    expect(counts.get('a2')).toBeUndefined()
    expect((await store.getCounts(otherScope, 'u1', ['a1'])).size).toBe(0)
  })
  it('records unlocks idempotently', async () => {
    const store = new PgProgressStore(db)
    const at = new Date()
    expect(await store.recordUnlock(scope, 'u1', 'a1', at)).toBe(true)
    expect(await store.recordUnlock(scope, 'u1', 'a1', at)).toBe(false)
    const rows = await store.getUserAchievements(scope, 'u1')
    expect(rows).toContainEqual({ achievementId: 'a1', current: 4, unlockedAt: expect.any(Date) })
  })
})

describe('PgUsageStore', () => {
  it('counts events and distinct MAU', async () => {
    const store = new PgUsageStore(db)
    await store.recordUsage(scope, 'u1', '2026-07')
    await store.recordUsage(scope, 'u1', '2026-07')
    await store.recordUsage(scope, 'u2', '2026-07')
    // no exception = pass; counters are asserted via direct query
    const { rows } = await db.$client.query(
      `select events_count from runtime.usage_counters where project_id='p1' and month='2026-07'`,
    )
    expect(rows[0].events_count).toBe(3)
    const mau = await db.$client.query(
      `select count(*)::int as n from runtime.monthly_active_users where project_id='p1' and month='2026-07'`,
    )
    expect(mau.rows[0].n).toBe(2)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @promocean/adapter-db test`
Expected: FAIL — `../src/index.js` unresolved (or store classes missing).

- [ ] **Step 5: Implement db factory, migrator, stores**

`packages/adapter-db/src/migrate.ts`:
```ts
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Db } from './index.js'

export async function runMigrations(db: Db): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
  await migrate(db, { migrationsFolder: dir })
}
```

`packages/adapter-db/src/stores.ts`:
```ts
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { EventStore, ProgressStore, Scope, UsageStore } from '@promocean/core'
import { achievementProgress, events, monthlyActiveUsers, unlocks, usageCounters } from './schema.js'
import type { Db } from './index.js'

const scoped = (t: { projectId: any; environment: any }, s: Scope) =>
  and(eq(t.projectId, s.projectId), eq(t.environment, s.environment))

export class PgEventStore implements EventStore {
  constructor(private db: Db) {}
  async insertEvent(scope: Scope, e: { userId: string; type: string; idempotencyKey: string; occurredAt: Date; meta?: Record<string, unknown> }) {
    const inserted = await this.db.insert(events)
      .values({ ...scope, ...e })
      .onConflictDoNothing()
      .returning({ id: events.id })
    return { deduped: inserted.length === 0 }
  }
}

export class PgProgressStore implements ProgressStore {
  constructor(private db: Db) {}
  async getCounts(scope: Scope, userId: string, achievementIds: string[]) {
    if (achievementIds.length === 0) return new Map<string, number>()
    const rows = await this.db.select().from(achievementProgress).where(and(
      scoped(achievementProgress, scope),
      eq(achievementProgress.userId, userId),
      inArray(achievementProgress.achievementId, achievementIds),
    ))
    return new Map(rows.map((r) => [r.achievementId, r.current]))
  }
  async setProgress(scope: Scope, userId: string, achievementId: string, current: number) {
    await this.db.insert(achievementProgress)
      .values({ ...scope, userId, achievementId, current })
      .onConflictDoUpdate({
        target: [achievementProgress.projectId, achievementProgress.environment, achievementProgress.userId, achievementProgress.achievementId],
        set: { current, updatedAt: sql`now()` },
      })
  }
  async recordUnlock(scope: Scope, userId: string, achievementId: string, unlockedAt: Date) {
    const inserted = await this.db.insert(unlocks)
      .values({ ...scope, userId, achievementId, unlockedAt })
      .onConflictDoNothing()
      .returning({ achievementId: unlocks.achievementId })
    return inserted.length > 0
  }
  async getUserAchievements(scope: Scope, userId: string) {
    const progressRows = await this.db.select().from(achievementProgress)
      .where(and(scoped(achievementProgress, scope), eq(achievementProgress.userId, userId)))
    const unlockRows = await this.db.select().from(unlocks)
      .where(and(scoped(unlocks, scope), eq(unlocks.userId, userId)))
    const unlockedBy = new Map(unlockRows.map((r) => [r.achievementId, r.unlockedAt]))
    const ids = new Set([...progressRows.map((r) => r.achievementId), ...unlockedBy.keys()])
    return [...ids].map((achievementId) => ({
      achievementId,
      current: progressRows.find((r) => r.achievementId === achievementId)?.current ?? 0,
      unlockedAt: unlockedBy.get(achievementId) ?? null,
    }))
  }
}

export class PgUsageStore implements UsageStore {
  constructor(private db: Db) {}
  async recordUsage(scope: Scope, userId: string, month: string) {
    await this.db.insert(monthlyActiveUsers).values({ ...scope, month, userId }).onConflictDoNothing()
    await this.db.insert(usageCounters).values({ ...scope, month, eventsCount: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.projectId, usageCounters.environment, usageCounters.month],
        set: { eventsCount: sql`${usageCounters.eventsCount} + 1` },
      })
  }
}
```

`packages/adapter-db/src/index.ts`:
```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

export type Db = NodePgDatabase & { $client: pg.Pool }
export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString })
  return drizzle(pool) as Db
}
export { runMigrations } from './migrate.js'
export { PgEventStore, PgProgressStore, PgUsageStore } from './stores.js'
export * as schema from './schema.js'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @promocean/adapter-db test`
Expected: all PASS (Docker must be running for Testcontainers).

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-db
git commit -m "feat(adapter-db): drizzle runtime schema and Postgres store implementations"
```

---

### Task 5: `apps/cms` — Strapi with content types, config-plane endpoints, seed

**Files:**
- Create: `apps/cms/*` (generated by create-strapi, then edited)
- Create: `apps/cms/src/api/project/content-types/project/schema.json` (+ default routes/controllers/services files for each type)
- Create: `apps/cms/src/api/api-key/content-types/api-key/schema.json`, `apps/cms/src/api/api-key/content-types/api-key/lifecycles.ts`
- Create: `apps/cms/src/api/achievement/content-types/achievement/schema.json`
- Create: `apps/cms/src/api/config-plane/routes/config-plane.ts`, `apps/cms/src/api/config-plane/controllers/config-plane.ts`
- Modify: `apps/cms/src/index.ts` (bootstrap seed), `apps/cms/config/database.ts` (postgres), `apps/cms/package.json` (name/scripts)

**Interfaces:**
- Consumes: Postgres from Task 1; env `CONFIG_PLANE_SECRET`, `SEED_DEMO`.
- Produces (the config-plane protocol Task 6 implements a client for):
  - `GET {STRAPI_URL}/api/config-plane/achievements?projectId=<documentId>` with header `x-config-secret` → `200 { achievements: [{ id, name, description, artworkUrl, eventType, targetCount }] }`; `401` on bad secret.
  - `POST {STRAPI_URL}/api/config-plane/verify-key` body `{ "keyHash": "<sha256 hex>" }` with header `x-config-secret` → `200 { projectId, environment, keyType }` or `404`.
  - Seeded demo data (when `SEED_DEMO=true` and DB empty): project `demo`; publishable test key `pk_test_demo_1234567890abcdef`; achievements: First Lesson (`lesson_completed`×1), Getting Started (`lesson_completed`×10), Profiled (`profile_completed`×1).

- [ ] **Step 1: Generate the Strapi app**

Run from repo root:
```bash
pnpm dlx create-strapi@latest apps/cms --ts --no-run --no-example --no-git-init --skip-cloud --install
```
Then in `apps/cms/package.json` set `"name": "cms"` and add `"typecheck": "tsc --noEmit"`, `"dev": "strapi develop"`, `"test": "echo ok"` to scripts.

Replace `apps/cms/config/database.ts` content so postgres is the only client:
```ts
export default ({ env }: { env: any }) => ({
  connection: {
    client: 'postgres',
    connection: { connectionString: env('DATABASE_URL') },
    pool: { min: 0, max: 10 },
  },
})
```
Copy `.env.example` → `apps/cms/.env` additions: Strapi's generated `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `JWT_SECRET` stay; add `DATABASE_URL`, `CONFIG_PLANE_SECRET`, `SEED_DEMO` from root `.env.example`.

- [ ] **Step 2: Content-type schemas**

`apps/cms/src/api/project/content-types/project/schema.json`:
```json
{
  "kind": "collectionType",
  "collectionName": "projects",
  "info": { "singularName": "project", "pluralName": "projects", "displayName": "Project" },
  "options": { "draftAndPublish": false },
  "attributes": {
    "name": { "type": "string", "required": true },
    "slug": { "type": "uid", "targetField": "name" }
  }
}
```

`apps/cms/src/api/api-key/content-types/api-key/schema.json`:
```json
{
  "kind": "collectionType",
  "collectionName": "api_keys",
  "info": { "singularName": "api-key", "pluralName": "api-keys", "displayName": "API Key" },
  "options": { "draftAndPublish": false },
  "attributes": {
    "keyHash": { "type": "string", "unique": true, "configurable": false },
    "keyPrefix": { "type": "string", "configurable": false },
    "keyType": { "type": "enumeration", "enum": ["publishable", "secret"], "required": true, "default": "publishable" },
    "environment": { "type": "enumeration", "enum": ["test", "live"], "required": true, "default": "test" },
    "project": { "type": "relation", "relation": "manyToOne", "target": "api::project.project" }
  }
}
```

`apps/cms/src/api/achievement/content-types/achievement/schema.json`:
```json
{
  "kind": "collectionType",
  "collectionName": "achievements",
  "info": { "singularName": "achievement", "pluralName": "achievements", "displayName": "Achievement" },
  "options": { "draftAndPublish": false },
  "attributes": {
    "name": { "type": "string", "required": true },
    "description": { "type": "text" },
    "artworkUrl": { "type": "string" },
    "eventType": { "type": "string", "required": true, "regex": "^[a-z][a-z0-9_]*$" },
    "targetCount": { "type": "integer", "required": true, "min": 1, "default": 1 },
    "project": { "type": "relation", "relation": "manyToOne", "target": "api::project.project" }
  }
}
```

For each of the three types create the standard Strapi v5 core files (default factories), e.g. for achievement:
`apps/cms/src/api/achievement/routes/achievement.ts`:
```ts
import { factories } from '@strapi/strapi'
export default factories.createCoreRouter('api::achievement.achievement')
```
`.../controllers/achievement.ts`: `factories.createCoreController('api::achievement.achievement')`;
`.../services/achievement.ts`: `factories.createCoreService('api::achievement.achievement')`. Same pattern for `project` and `api-key`.

- [ ] **Step 3: Key-generation lifecycle hook**

`apps/cms/src/api/api-key/content-types/api-key/lifecycles.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto'

export default {
  beforeCreate(event: any) {
    const data = event.params.data
    if (data.keyHash) return // seeded with a precomputed hash
    const prefix = data.keyType === 'secret' ? 'sk' : 'pk'
    const raw = `${prefix}_${data.environment}_${randomBytes(16).toString('hex')}`
    data.keyHash = createHash('sha256').update(raw).digest('hex')
    data.keyPrefix = raw.slice(0, 12)
    strapi.log.info(`[promocean] API key created — shown ONCE: ${raw}`)
  },
}
```

- [ ] **Step 4: Config-plane routes + controller**

`apps/cms/src/api/config-plane/routes/config-plane.ts`:
```ts
export default {
  routes: [
    { method: 'GET', path: '/config-plane/achievements', handler: 'config-plane.achievements', config: { auth: false } },
    { method: 'POST', path: '/config-plane/verify-key', handler: 'config-plane.verifyKey', config: { auth: false } },
  ],
}
```

`apps/cms/src/api/config-plane/controllers/config-plane.ts`:
```ts
export default {
  async achievements(ctx: any) {
    if (ctx.request.header['x-config-secret'] !== process.env.CONFIG_PLANE_SECRET) return ctx.unauthorized()
    const projectId = String(ctx.query.projectId ?? '')
    const rows = await strapi.documents('api::achievement.achievement').findMany({
      filters: { project: { documentId: projectId } },
    })
    ctx.body = {
      achievements: rows.map((r: any) => ({
        id: r.documentId,
        name: r.name,
        description: r.description ?? null,
        artworkUrl: r.artworkUrl ?? null,
        eventType: r.eventType,
        targetCount: r.targetCount,
      })),
    }
  },
  async verifyKey(ctx: any) {
    if (ctx.request.header['x-config-secret'] !== process.env.CONFIG_PLANE_SECRET) return ctx.unauthorized()
    const { keyHash } = ctx.request.body ?? {}
    const rows = await strapi.documents('api::api-key.api-key').findMany({
      filters: { keyHash: { $eq: String(keyHash ?? '') } },
      populate: ['project'],
      limit: 1,
    })
    const key = rows[0]
    if (!key || !key.project) return ctx.notFound()
    ctx.body = { projectId: key.project.documentId, environment: key.environment, keyType: key.keyType }
  },
}
```

- [ ] **Step 5: Bootstrap seed**

In `apps/cms/src/index.ts`, fill the existing `bootstrap` export:
```ts
import { createHash } from 'node:crypto'

export default {
  register() {},
  async bootstrap({ strapi }: { strapi: any }) {
    if (process.env.SEED_DEMO !== 'true') return
    const existing = await strapi.documents('api::project.project').findMany({ limit: 1 })
    if (existing.length > 0) return
    const project = await strapi.documents('api::project.project').create({
      data: { name: 'Demo', slug: 'demo' },
    })
    const rawKey = 'pk_test_demo_1234567890abcdef'
    await strapi.documents('api::api-key.api-key').create({
      data: {
        keyHash: createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.slice(0, 12),
        keyType: 'publishable',
        environment: 'test',
        project: project.documentId,
      },
    })
    const achievements = [
      { name: 'First Lesson', description: 'Complete your first lesson.', eventType: 'lesson_completed', targetCount: 1 },
      { name: 'Getting Started', description: 'Complete ten lessons.', eventType: 'lesson_completed', targetCount: 10 },
      { name: 'Profiled', description: 'Complete your profile.', eventType: 'profile_completed', targetCount: 1 },
    ]
    for (const a of achievements) {
      await strapi.documents('api::achievement.achievement').create({
        data: { ...a, artworkUrl: null, project: project.documentId },
      })
    }
    strapi.log.info(`[promocean] Seeded demo project ${project.documentId} with key ${rawKey}`)
  },
}
```

- [ ] **Step 6: Manual verification**

Run: `pnpm db:up && pnpm --filter cms dev`
Expected: Strapi starts on :1337; log shows the seeded project ID and demo key.

Run (replace `<PROJECT_ID>` from the log):
```bash
curl -s -H 'x-config-secret: dev-config-secret' 'http://localhost:1337/api/config-plane/achievements?projectId=<PROJECT_ID>'
curl -s -X POST -H 'x-config-secret: dev-config-secret' -H 'content-type: application/json' \
  -d '{"keyHash":"'$(printf 'pk_test_demo_1234567890abcdef' | shasum -a 256 | cut -d' ' -f1)'"}' \
  http://localhost:1337/api/config-plane/verify-key
```
Expected: first returns 3 achievements; second returns `{ "projectId": "...", "environment": "test", "keyType": "publishable" }`. A request without the header returns 401.

- [ ] **Step 7: Commit**

```bash
git add apps/cms
git commit -m "feat(cms): strapi config plane with project/api-key/achievement types, secret-guarded config endpoints, demo seed"
```

---

### Task 6: `@promocean/adapter-strapi` — ConfigStore + ApiKeyStore client (GPL)

**Files:**
- Create: `packages/adapter-strapi/package.json`, `packages/adapter-strapi/tsconfig.json`, `packages/adapter-strapi/vitest.config.ts`
- Create: `packages/adapter-strapi/src/index.ts`
- Test: `packages/adapter-strapi/test/adapter.test.ts`

**Interfaces:**
- Consumes: `ConfigStore`, `ApiKeyStore`, `AchievementDefinition`, `AuthContext` from `@promocean/core`; the config-plane HTTP protocol from Task 5.
- Produces:
  - `class StrapiConfigPlane implements ConfigStore, ApiKeyStore`
  - `new StrapiConfigPlane({ baseUrl, configSecret, cacheTtlMs? /* default 30_000 */, fetchImpl? /* default globalThis.fetch */ })`
  - Behavior: 30s TTL cache per projectId for achievements and per keyHash for auth; **serves stale cache entries when Strapi errors** (stale-on-error, spec §3.3); `verifyKey(rawKey)` SHA-256-hashes before calling the endpoint.

- [ ] **Step 1: Package skeleton**

`packages/adapter-strapi/package.json`: same shape as Task 3's core package.json but `"name": "@promocean/adapter-strapi"`, `"license": "GPL-3.0-only"`, plus `"dependencies": { "@promocean/core": "workspace:*" }`.

- [ ] **Step 2: Write the failing tests**

`packages/adapter-strapi/test/adapter.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { StrapiConfigPlane } from '../src/index.js'

const achievementsBody = { achievements: [{ id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 }] }
const authBody = { projectId: 'p1', environment: 'test', keyType: 'publishable' }
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

function makePlane(fetchImpl: typeof fetch, cacheTtlMs = 30_000) {
  return new StrapiConfigPlane({ baseUrl: 'http://cms.test', configSecret: 's3cret', cacheTtlMs, fetchImpl })
}

describe('StrapiConfigPlane.getAchievements', () => {
  it('fetches with the secret header and maps definitions', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(achievementsBody))
    const defs = await makePlane(fetchImpl).getAchievements('p1')
    expect(defs).toEqual(achievementsBody.achievements)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://cms.test/api/config-plane/achievements?projectId=p1')
    expect(init.headers['x-config-secret']).toBe('s3cret')
  })
  it('caches within TTL', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(achievementsBody))
    const plane = makePlane(fetchImpl)
    await plane.getAchievements('p1')
    await plane.getAchievements('p1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('serves stale cache when strapi errors', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => ok(achievementsBody))
      .mockImplementation(() => Promise.reject(new Error('down')))
    const plane = makePlane(fetchImpl, 0) // TTL 0: always expired
    await plane.getAchievements('p1')
    const defs = await plane.getAchievements('p1')
    expect(defs).toEqual(achievementsBody.achievements)
  })
  it('throws when strapi errors with no cache', async () => {
    const plane = makePlane(vi.fn().mockImplementation(() => Promise.reject(new Error('down'))))
    await expect(plane.getAchievements('p1')).rejects.toThrow()
  })
})

describe('StrapiConfigPlane.verifyKey', () => {
  it('hashes the raw key and returns the auth context', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(authBody))
    const auth = await makePlane(fetchImpl).verifyKey('pk_test_demo_1234567890abcdef')
    expect(auth).toEqual(authBody)
    const [, init] = fetchImpl.mock.calls[0]
    const sent = JSON.parse(init.body)
    expect(sent.keyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sent.keyHash).not.toContain('pk_test')
  })
  it('returns null on 404', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 404 })))
    expect(await makePlane(fetchImpl).verifyKey('nope_key_123')).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @promocean/adapter-strapi test`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement**

`packages/adapter-strapi/src/index.ts`:
```ts
import { createHash } from 'node:crypto'
import type { AchievementDefinition, ApiKeyStore, AuthContext, ConfigStore } from '@promocean/core'

export interface StrapiConfigPlaneOptions {
  baseUrl: string
  configSecret: string
  cacheTtlMs?: number
  fetchImpl?: typeof fetch
}

interface CacheEntry<T> { value: T; expires: number }

export class StrapiConfigPlane implements ConfigStore, ApiKeyStore {
  private readonly ttl: number
  private readonly fetchImpl: typeof fetch
  private achievementsCache = new Map<string, CacheEntry<AchievementDefinition[]>>()
  private authCache = new Map<string, CacheEntry<AuthContext | null>>()

  constructor(private opts: StrapiConfigPlaneOptions) {
    this.ttl = opts.cacheTtlMs ?? 30_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private headers() {
    return { 'x-config-secret': this.opts.configSecret, 'content-type': 'application/json' }
  }

  async getAchievements(projectId: string): Promise<AchievementDefinition[]> {
    const cached = this.achievementsCache.get(projectId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/api/config-plane/achievements?projectId=${encodeURIComponent(projectId)}`,
        { headers: this.headers() },
      )
      if (!res.ok) throw new Error(`config plane responded ${res.status}`)
      const body = (await res.json()) as { achievements: AchievementDefinition[] }
      this.achievementsCache.set(projectId, { value: body.achievements, expires: Date.now() + this.ttl })
      return body.achievements
    } catch (err) {
      if (cached) return cached.value // stale-on-error
      throw err
    }
  }

  async verifyKey(rawKey: string): Promise<AuthContext | null> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const cached = this.authCache.get(keyHash)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/config-plane/verify-key`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ keyHash }),
      })
      const value = res.status === 404 ? null : res.ok ? ((await res.json()) as AuthContext) : null
      if (!res.ok && res.status !== 404) throw new Error(`config plane responded ${res.status}`)
      this.authCache.set(keyHash, { value, expires: Date.now() + this.ttl })
      return value
    } catch (err) {
      if (cached) return cached.value
      throw err
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @promocean/adapter-strapi test`
Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-strapi
git commit -m "feat(adapter-strapi): config-plane client with TTL cache, stale-on-error, and key hashing"
```

---

### Task 7: `apps/api` — Hono runtime API (GPL)

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`
- Create: `apps/api/src/app.ts`, `apps/api/src/auth.ts`, `apps/api/src/routes/events.ts`, `apps/api/src/routes/users.ts`, `apps/api/src/index.ts`
- Test: `apps/api/test/app.test.ts`, `apps/api/test/fakes.ts`

**Interfaces:**
- Consumes: all ports from `@promocean/core` (Task 3); schemas from `@promocean/contracts` (Task 2); `StrapiConfigPlane` + Pg stores wired only in `src/index.ts`.
- Produces:
  - `createApp(deps: AppDeps): Hono` where `AppDeps = { configStore: ConfigStore; apiKeyStore: ApiKeyStore; eventStore: EventStore; progressStore: ProgressStore; usageStore: UsageStore }`
  - HTTP surface (auth: `Authorization: Bearer <key>`):
    - `POST /v1/events` — body `TrackEventRequest` → `200 TrackEventResponse`
    - `GET /v1/users/:userId/achievements` → `200 UserAchievementsResponse`
    - `GET /healthz` → `200 { ok: true }`
  - Errors: `401 invalid_api_key`, `400 invalid_payload`, `500 internal_error` — always `ErrorEnvelope`.
  - Runtime env (index.ts): `DATABASE_URL`, `STRAPI_URL`, `CONFIG_PLANE_SECRET`, `API_PORT` (default 3001); runs migrations on boot; CORS `*` for `/v1/*`.

- [ ] **Step 1: Package skeleton**

`apps/api/package.json`:
```json
{
  "name": "api",
  "version": "0.0.1",
  "license": "GPL-3.0-only",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@hono/node-server": "^1.14.0",
    "@promocean/adapter-db": "workspace:*",
    "@promocean/adapter-strapi": "workspace:*",
    "@promocean/contracts": "workspace:*",
    "@promocean/core": "workspace:*",
    "hono": "^4.8.0"
  },
  "devDependencies": {
    "@promocean/config": "workspace:*",
    "tsx": "^4.19.0",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: Write in-memory fakes + failing tests**

`apps/api/test/fakes.ts`:
```ts
import type {
  AchievementDefinition, ApiKeyStore, AuthContext, ConfigStore, EventStore, ProgressStore, Scope, UsageStore,
} from '@promocean/core'

const sk = (s: Scope, rest: string) => `${s.projectId}:${s.environment}:${rest}`

export function makeFakes(definitions: AchievementDefinition[], auth: AuthContext | null) {
  const seenIdem = new Set<string>()
  const progress = new Map<string, number>()
  const unlockDates = new Map<string, Date>()
  const usage: string[] = []
  const configStore: ConfigStore = { getAchievements: async () => definitions }
  const apiKeyStore: ApiKeyStore = { verifyKey: async (raw) => (raw === 'pk_test_valid_key_1' ? auth : null) }
  const eventStore: EventStore = {
    insertEvent: async (s, e) => {
      const k = sk(s, e.idempotencyKey)
      if (seenIdem.has(k)) return { deduped: true }
      seenIdem.add(k)
      return { deduped: false }
    },
  }
  const progressStore: ProgressStore = {
    getCounts: async (s, u, ids) =>
      new Map(ids.flatMap((id) => (progress.has(sk(s, `${u}:${id}`)) ? [[id, progress.get(sk(s, `${u}:${id}`))!] as const] : []))),
    setProgress: async (s, u, id, c) => { progress.set(sk(s, `${u}:${id}`), c) },
    recordUnlock: async (s, u, id, at) => {
      const k = sk(s, `${u}:${id}`)
      if (unlockDates.has(k)) return false
      unlockDates.set(k, at)
      return true
    },
    getUserAchievements: async (s, u) =>
      [...progress.entries()]
        .filter(([k]) => k.startsWith(sk(s, `${u}:`)))
        .map(([k, current]) => {
          const achievementId = k.split(':').at(-1)!
          return { achievementId, current, unlockedAt: unlockDates.get(sk(s, `${u}:${achievementId}`)) ?? null }
        }),
  }
  const usageStore: UsageStore = { recordUsage: async (_s, u, m) => { usage.push(`${u}:${m}`) } }
  return { configStore, apiKeyStore, eventStore, progressStore, usageStore, usage }
}
```

`apps/api/test/app.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { makeFakes } from './fakes.js'

const defs = [
  { id: 'a1', name: 'First Lesson', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 1 },
  { id: 'a2', name: 'Getting Started', description: null, artworkUrl: null, eventType: 'lesson_completed', targetCount: 10 },
]
const auth = { projectId: 'p1', environment: 'test' as const, keyType: 'publishable' as const }
const headers = { authorization: 'Bearer pk_test_valid_key_1', 'content-type': 'application/json' }
const body = (idem: string) => JSON.stringify({ userId: 'u1', type: 'lesson_completed', idempotencyKey: idem })

function app() { return createApp(makeFakes(defs, auth)) }

describe('POST /v1/events', () => {
  it('rejects missing/invalid keys with invalid_api_key', async () => {
    const res = await app().request('/v1/events', { method: 'POST', body: body('k1234567'), headers: { ...headers, authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('invalid_api_key')
  })
  it('rejects bad payloads with invalid_payload', async () => {
    const res = await app().request('/v1/events', { method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_payload')
  })
  it('tracks, unlocks at target, and reports progress', async () => {
    const res = await app().request('/v1/events', { method: 'POST', headers, body: body('k1234567') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.deduped).toBe(false)
    expect(json.unlocks).toEqual([{ achievementId: 'a1', name: 'First Lesson', unlockedAt: expect.any(String) }])
    expect(json.progress).toContainEqual({ achievementId: 'a2', current: 1, target: 10 })
  })
  it('dedupes idempotency-key replays', async () => {
    const a = app()
    await a.request('/v1/events', { method: 'POST', headers, body: body('same_key_1') })
    const res = await a.request('/v1/events', { method: 'POST', headers, body: body('same_key_1') })
    const json = await res.json()
    expect(json.deduped).toBe(true)
    expect(json.unlocks).toEqual([])
  })
})

describe('GET /v1/users/:userId/achievements', () => {
  it('joins definitions with progress and unlock state', async () => {
    const a = app()
    await a.request('/v1/events', { method: 'POST', headers, body: body('k7654321') })
    const res = await a.request('/v1/users/u1/achievements', { headers })
    const json = await res.json()
    expect(json.achievements).toContainEqual({
      achievementId: 'a1', name: 'First Lesson', description: null, artworkUrl: null,
      current: 1, target: 1, unlockedAt: expect.any(String),
    })
    expect(json.achievements).toContainEqual({
      achievementId: 'a2', name: 'Getting Started', description: null, artworkUrl: null,
      current: 1, target: 10, unlockedAt: null,
    })
  })
})

describe('GET /healthz', () => {
  it('returns ok without auth', async () => {
    const res = await app().request('/healthz')
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter api test`
Expected: FAIL — `../src/app.js` missing.

- [ ] **Step 4: Implement app, auth, routes**

`apps/api/src/auth.ts`:
```ts
import type { Context, Next } from 'hono'
import type { ApiKeyStore, AuthContext } from '@promocean/core'

declare module 'hono' {
  interface ContextVariableMap { auth: AuthContext }
}

export function authMiddleware(apiKeyStore: ApiKeyStore) {
  return async (c: Context, next: Next) => {
    const header = c.req.header('authorization') ?? ''
    const rawKey = header.startsWith('Bearer ') ? header.slice(7) : ''
    const auth = rawKey ? await apiKeyStore.verifyKey(rawKey) : null
    if (!auth) {
      return c.json({ error: { code: 'invalid_api_key', message: 'Missing or invalid API key.' } }, 401)
    }
    c.set('auth', auth)
    await next()
  }
}
```

`apps/api/src/routes/events.ts`:
```ts
import { Hono } from 'hono'
import { trackEventRequestSchema, type TrackEventResponse } from '@promocean/contracts'
import { evaluateEvent, type Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function eventsRoute(deps: AppDeps) {
  const app = new Hono()
  app.post('/', async (c) => {
    const parsed = trackEventRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_payload', message: 'Invalid track payload.', details: parsed.error.issues } }, 400)
    }
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const { userId, type, idempotencyKey, meta } = parsed.data
    const occurredAt = parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date()

    const { deduped } = await deps.eventStore.insertEvent(scope, { userId, type, idempotencyKey, occurredAt, meta })
    if (deduped) {
      return c.json({ deduped: true, unlocks: [], progress: [] } satisfies TrackEventResponse)
    }

    const definitions = await deps.configStore.getAchievements(scope.projectId)
    const relevant = definitions.filter((d) => d.eventType === type)
    const counts = await deps.progressStore.getCounts(scope, userId, relevant.map((d) => d.id))
    const result = evaluateEvent({ userId, type, occurredAt }, definitions, counts)

    const unlockedAt = new Date()
    const unlocks: TrackEventResponse['unlocks'] = []
    for (const u of result.progressUpdates) {
      await deps.progressStore.setProgress(scope, userId, u.achievementId, u.current)
    }
    for (const u of result.unlocks) {
      const isNew = await deps.progressStore.recordUnlock(scope, userId, u.achievementId, unlockedAt)
      if (isNew) unlocks.push({ achievementId: u.achievementId, name: u.name, unlockedAt: unlockedAt.toISOString() })
    }
    await deps.usageStore.recordUsage(scope, userId, occurredAt.toISOString().slice(0, 7))

    return c.json({ deduped: false, unlocks, progress: result.progressUpdates } satisfies TrackEventResponse)
  })
  return app
}
```

`apps/api/src/routes/users.ts`:
```ts
import { Hono } from 'hono'
import type { UserAchievementsResponse } from '@promocean/contracts'
import type { Scope } from '@promocean/core'
import type { AppDeps } from '../app.js'

export function usersRoute(deps: AppDeps) {
  const app = new Hono()
  app.get('/:userId/achievements', async (c) => {
    const auth = c.get('auth')
    const scope: Scope = { projectId: auth.projectId, environment: auth.environment }
    const userId = c.req.param('userId')
    const [definitions, states] = await Promise.all([
      deps.configStore.getAchievements(scope.projectId),
      deps.progressStore.getUserAchievements(scope, userId),
    ])
    const byId = new Map(states.map((s) => [s.achievementId, s]))
    const achievements = definitions.map((d) => {
      const s = byId.get(d.id)
      return {
        achievementId: d.id, name: d.name, description: d.description, artworkUrl: d.artworkUrl,
        current: s?.current ?? 0, target: d.targetCount,
        unlockedAt: s?.unlockedAt ? s.unlockedAt.toISOString() : null,
      }
    })
    return c.json({ achievements } satisfies UserAchievementsResponse)
  })
  return app
}
```

`apps/api/src/app.ts`:
```ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ApiKeyStore, ConfigStore, EventStore, ProgressStore, UsageStore } from '@promocean/core'
import { authMiddleware } from './auth.js'
import { eventsRoute } from './routes/events.js'
import { usersRoute } from './routes/users.js'

export interface AppDeps {
  configStore: ConfigStore
  apiKeyStore: ApiKeyStore
  eventStore: EventStore
  progressStore: ProgressStore
  usageStore: UsageStore
}

export function createApp(deps: AppDeps) {
  const app = new Hono()
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.use('/v1/*', cors())
  app.use('/v1/*', authMiddleware(deps.apiKeyStore))
  app.route('/v1/events', eventsRoute(deps))
  app.route('/v1/users', usersRoute(deps))
  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: { code: 'internal_error', message: 'Internal error.' } }, 500)
  })
  return app
}
```

`apps/api/src/index.ts`:
```ts
import { serve } from '@hono/node-server'
import { createDb, runMigrations, PgEventStore, PgProgressStore, PgUsageStore } from '@promocean/adapter-db'
import { StrapiConfigPlane } from '@promocean/adapter-strapi'
import { createApp } from './app.js'

const db = createDb(process.env.DATABASE_URL!)
await runMigrations(db)
const plane = new StrapiConfigPlane({
  baseUrl: process.env.STRAPI_URL ?? 'http://localhost:1337',
  configSecret: process.env.CONFIG_PLANE_SECRET!,
})
const app = createApp({
  configStore: plane,
  apiKeyStore: plane,
  eventStore: new PgEventStore(db),
  progressStore: new PgProgressStore(db),
  usageStore: new PgUsageStore(db),
})
const port = Number(process.env.API_PORT ?? 3001)
serve({ fetch: app.fetch, port })
console.log(`promocean api listening on :${port}`)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter api test && pnpm turbo run typecheck`
Expected: 7 tests PASS; typecheck clean across workspace.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): hono runtime with key auth, event ingestion + evaluation, and user achievements"
```

---

### Task 8: CI — GitHub Actions

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts from Task 1; all package test scripts.
- Produces: a `ci` workflow running typecheck + tests on every push/PR (Testcontainers works on `ubuntu-latest` — no Postgres service block needed).

- [ ] **Step 1: Workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run typecheck build
      - run: pnpm turbo run test
```

- [ ] **Step 2: Verify and commit**

Run: `pnpm turbo run typecheck build test`
Expected: all green locally (CI mirrors this).

```bash
git add .github
git commit -m "chore(ci): typecheck, build, and test on push/PR"
git push -u origin main
```
Then confirm the Actions run is green on GitHub.

---

### Task 9: `@promocean/sdk` — TypeScript client (MIT)

**Files:**
- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/vitest.config.ts`, `packages/sdk/LICENSE` (MIT)
- Create: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/sdk.test.ts`

**Interfaces:**
- Consumes: `TrackEventResponse`, `UnlockPayload`, `AchievementStatus`, `userAchievementsResponseSchema`, `trackEventResponseSchema` from `@promocean/contracts`; HTTP surface from Task 7.
- Produces:
  - `class Promocean` — `new Promocean({ publishableKey: string, baseUrl: string, userId?: string, fetchImpl?: typeof fetch, maxRetries?: number /* default 3 */ })`
  - `identify(userId: string): void`
  - `track(type: string, meta?: Record<string, unknown>): Promise<TrackEventResponse>` — auto `idempotencyKey` (`crypto.randomUUID()`), calls are serialized through an internal promise chain (ordering), retries network/5xx errors with exponential backoff (250ms base), never retries 4xx, and emits each unlock to `onUnlock` listeners.
  - `onUnlock(cb: (u: UnlockPayload) => void): () => void` (returns unsubscribe)
  - `getAchievements(): Promise<AchievementStatus[]>`

- [ ] **Step 1: Package skeleton**

`packages/sdk/package.json`: shape of Task 2's, with `"name": "@promocean/sdk"`, `"license": "MIT"`, `"dependencies": { "@promocean/contracts": "workspace:*" }`, `"sideEffects": false`. MIT `LICENSE` file.

- [ ] **Step 2: Write the failing tests**

`packages/sdk/test/sdk.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { Promocean } from '../src/index.js'

const trackOk = { deduped: false, unlocks: [{ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }], progress: [] }
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new Promocean({ publishableKey: 'pk_test_x', baseUrl: 'http://api.test', userId: 'u1', fetchImpl, ...extra })
}

describe('track', () => {
  it('POSTs a valid payload with bearer auth and an idempotency key', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok(trackOk))
    await client(fetchImpl).track('lesson_completed', { lessonId: 1 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://api.test/v1/events')
    expect(init.headers.authorization).toBe('Bearer pk_test_x')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ userId: 'u1', type: 'lesson_completed', meta: { lessonId: 1 } })
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8)
  })
  it('emits unlocks to listeners', async () => {
    const c = client(vi.fn().mockImplementation(() => ok(trackOk)))
    const seen: string[] = []
    c.onUnlock((u) => seen.push(u.name))
    await c.track('lesson_completed')
    expect(seen).toEqual(['First Lesson'])
  })
  it('retries 5xx then succeeds, reusing the same idempotency key', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 500 })))
      .mockImplementation(() => ok(trackOk))
    const res = await client(fetchImpl, { maxRetries: 2 }).track('lesson_completed')
    expect(res.deduped).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const k1 = JSON.parse(fetchImpl.mock.calls[0][1].body).idempotencyKey
    const k2 = JSON.parse(fetchImpl.mock.calls[1][1].body).idempotencyKey
    expect(k1).toBe(k2)
  })
  it('does not retry 4xx', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { code: 'invalid_payload', message: 'bad' } }), { status: 400 })))
    await expect(client(fetchImpl).track('lesson_completed')).rejects.toThrow('invalid_payload')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('throws if no user identified', async () => {
    const c = new Promocean({ publishableKey: 'pk', baseUrl: 'http://api.test', fetchImpl: vi.fn() })
    await expect(c.track('lesson_completed')).rejects.toThrow(/identify/)
  })
})

describe('getAchievements', () => {
  it('fetches and returns the achievement list', async () => {
    const body = { achievements: [{ achievementId: 'a1', name: 'First Lesson', description: null, artworkUrl: null, current: 1, target: 1, unlockedAt: '2026-07-06T00:00:00.000Z' }] }
    const c = client(vi.fn().mockImplementation(() => ok(body)))
    expect(await c.getAchievements()).toEqual(body.achievements)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @promocean/sdk test`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement**

`packages/sdk/src/index.ts`:
```ts
import {
  trackEventResponseSchema, userAchievementsResponseSchema,
  type AchievementStatus, type TrackEventResponse, type UnlockPayload,
} from '@promocean/contracts'

export interface PromoceanOptions {
  publishableKey: string
  baseUrl: string
  userId?: string
  fetchImpl?: typeof fetch
  maxRetries?: number
}

export class PromoceanApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(`${code}: ${message}`)
  }
}

export class Promocean {
  private userId?: string
  private fetchImpl: typeof fetch
  private maxRetries: number
  private chain: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(u: UnlockPayload) => void>()

  constructor(private opts: PromoceanOptions) {
    this.userId = opts.userId
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a))
    this.maxRetries = opts.maxRetries ?? 3
  }

  identify(userId: string): void { this.userId = userId }

  onUnlock(cb: (u: UnlockPayload) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)))
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${this.opts.publishableKey}`, 'content-type': 'application/json', ...init?.headers },
        })
        if (res.status >= 500) { lastErr = new Error(`server ${res.status}`); continue }
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: { code: string; message: string } } | null
          throw new PromoceanApiError(body?.error?.code ?? 'internal_error', body?.error?.message ?? 'request failed', res.status)
        }
        return res
      } catch (err) {
        if (err instanceof PromoceanApiError) throw err
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('request failed')
  }

  track(type: string, meta?: Record<string, unknown>): Promise<TrackEventResponse> {
    const run = async (): Promise<TrackEventResponse> => {
      if (!this.userId) throw new Error('No user identified — call identify(userId) first.')
      const idempotencyKey = crypto.randomUUID()
      const res = await this.request('/v1/events', {
        method: 'POST',
        body: JSON.stringify({ userId: this.userId, type, idempotencyKey, ...(meta ? { meta } : {}) }),
      })
      const parsed = trackEventResponseSchema.parse(await res.json())
      for (const unlock of parsed.unlocks) for (const cb of this.listeners) cb(unlock)
      return parsed
    }
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => undefined) // keep the chain alive after failures
    return result
  }

  async getAchievements(): Promise<AchievementStatus[]> {
    if (!this.userId) throw new Error('No user identified — call identify(userId) first.')
    const res = await this.request(`/v1/users/${encodeURIComponent(this.userId)}/achievements`)
    return userAchievementsResponseSchema.parse(await res.json()).achievements
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @promocean/sdk test`
Expected: 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): promocean client with serialized tracking, retry/backoff, and unlock events"
```

---

### Task 10: `@promocean/widgets` — React components (MIT)

**Files:**
- Create: `packages/widgets/package.json`, `packages/widgets/tsconfig.json`, `packages/widgets/vitest.config.ts`, `packages/widgets/LICENSE` (MIT)
- Create: `packages/widgets/src/index.ts`, `packages/widgets/src/provider.tsx`, `packages/widgets/src/unlock-toast.tsx`, `packages/widgets/src/badge-cabinet.tsx`
- Test: `packages/widgets/test/widgets.test.tsx`

**Interfaces:**
- Consumes: `Promocean`, `UnlockPayload`, `AchievementStatus` types from `@promocean/sdk`/`@promocean/contracts`.
- Produces:
  - `<PromoceanProvider client={promocean}>{children}</PromoceanProvider>`
  - `usePromocean(): Promocean` (throws outside provider)
  - `<UnlockToast durationMs={5000} />` — renders unlocks from `client.onUnlock` in a `role="status"` `aria-live="polite"` container; auto-dismisses; never throws (errors render nothing)
  - `<BadgeCabinet />` — fetches `getAchievements()` on mount, refetches on unlock; each badge shows name + `current/target`; locked badges get `data-locked="true"`
- Constraint: inline styles only (no CSS imports — keeps embedding trivial); bundle stays dependency-free beyond react + sdk.

- [ ] **Step 1: Package skeleton**

`packages/widgets/package.json`:
```json
{
  "name": "@promocean/widgets",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "sideEffects": false,
  "scripts": { "build": "tsc", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@promocean/contracts": "workspace:*",
    "@promocean/sdk": "workspace:*"
  },
  "peerDependencies": { "react": ">=18" },
  "devDependencies": {
    "@promocean/config": "workspace:*",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.1.0",
    "jsdom": "^26.1.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

`packages/widgets/tsconfig.json` adds `"jsx": "react-jsx"` to compilerOptions; `vitest.config.ts` sets `test: { environment: 'jsdom', include: ['test/**/*.test.tsx'] }`.

- [ ] **Step 2: Write the failing tests**

`packages/widgets/test/widgets.test.tsx`:
```tsx
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UnlockPayload } from '@promocean/contracts'
import { BadgeCabinet, PromoceanProvider, UnlockToast } from '../src/index.js'

function fakeClient(achievements: unknown[] = []) {
  const listeners = new Set<(u: UnlockPayload) => void>()
  return {
    client: {
      onUnlock: (cb: (u: UnlockPayload) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
      getAchievements: vi.fn().mockResolvedValue(achievements),
    } as any,
    emit: (u: UnlockPayload) => listeners.forEach((cb) => cb(u)),
  }
}

describe('UnlockToast', () => {
  it('renders an unlock in a polite live region and auto-dismisses', async () => {
    vi.useFakeTimers()
    const { client, emit } = fakeClient()
    render(<PromoceanProvider client={client}><UnlockToast durationMs={1000} /></PromoceanProvider>)
    act(() => emit({ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }))
    expect(screen.getByRole('status')).toHaveTextContent('First Lesson')
    act(() => { vi.advanceTimersByTime(1100) })
    expect(screen.getByRole('status')).not.toHaveTextContent('First Lesson')
    vi.useRealTimers()
  })
})

describe('BadgeCabinet', () => {
  it('renders badges with progress and locked state', async () => {
    const { client } = fakeClient([
      { achievementId: 'a1', name: 'First Lesson', description: null, artworkUrl: null, current: 1, target: 1, unlockedAt: '2026-07-06T00:00:00.000Z' },
      { achievementId: 'a2', name: 'Getting Started', description: null, artworkUrl: null, current: 3, target: 10, unlockedAt: null },
    ])
    render(<PromoceanProvider client={client}><BadgeCabinet /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('First Lesson')).toBeDefined())
    expect(screen.getByText('3/10')).toBeDefined()
    expect(screen.getByText('Getting Started').closest('[data-locked]')?.getAttribute('data-locked')).toBe('true')
    expect(screen.getByText('First Lesson').closest('[data-locked]')?.getAttribute('data-locked')).toBe('false')
  })
  it('refetches when an unlock fires', async () => {
    const { client, emit } = fakeClient([])
    render(<PromoceanProvider client={client}><BadgeCabinet /></PromoceanProvider>)
    await waitFor(() => expect(client.getAchievements).toHaveBeenCalledTimes(1))
    act(() => emit({ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }))
    await waitFor(() => expect(client.getAchievements).toHaveBeenCalledTimes(2))
  })
})
```

Note: add `@testing-library/jest-dom`? No — `toHaveTextContent` requires it. Add `"@testing-library/jest-dom": "^6.6.0"` to devDependencies and a `test/setup.ts` with `import '@testing-library/jest-dom/vitest'`, referenced from `vitest.config.ts` as `setupFiles: ['test/setup.ts']`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @promocean/widgets test`
Expected: FAIL — components missing.

- [ ] **Step 4: Implement**

`packages/widgets/src/provider.tsx`:
```tsx
import { createContext, useContext, type ReactNode } from 'react'
import type { Promocean } from '@promocean/sdk'

const Ctx = createContext<Promocean | null>(null)

export function PromoceanProvider({ client, children }: { client: Promocean; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>
}

export function usePromocean(): Promocean {
  const client = useContext(Ctx)
  if (!client) throw new Error('usePromocean must be used inside <PromoceanProvider>.')
  return client
}
```

`packages/widgets/src/unlock-toast.tsx`:
```tsx
import { useEffect, useState } from 'react'
import type { UnlockPayload } from '@promocean/contracts'
import { usePromocean } from './provider.js'

export function UnlockToast({ durationMs = 5000 }: { durationMs?: number }) {
  const client = usePromocean()
  const [toasts, setToasts] = useState<UnlockPayload[]>([])

  useEffect(() => client.onUnlock((u) => {
    setToasts((t) => [...t, u])
    setTimeout(() => setToasts((t) => t.filter((x) => x !== u)), durationMs)
  }), [client, durationMs])

  return (
    <div role="status" aria-live="polite" style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 2147483647 }}>
      {toasts.map((t) => (
        <div key={`${t.achievementId}-${t.unlockedAt}`} style={{ background: '#1a1a2e', color: '#fff', borderRadius: 8, padding: '12px 16px', boxShadow: '0 4px 12px rgba(0,0,0,.3)', fontFamily: 'system-ui, sans-serif' }}>
          <strong>🏆 Achievement unlocked</strong>
          <div>{t.name}</div>
        </div>
      ))}
    </div>
  )
}
```

`packages/widgets/src/badge-cabinet.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react'
import type { AchievementStatus } from '@promocean/contracts'
import { usePromocean } from './provider.js'

export function BadgeCabinet() {
  const client = usePromocean()
  const [achievements, setAchievements] = useState<AchievementStatus[]>([])

  const refresh = useCallback(() => {
    client.getAchievements().then(setAchievements).catch(() => {}) // fail silent-to-empty
  }, [client])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => client.onUnlock(() => refresh()), [client, refresh])

  return (
    <ul style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, listStyle: 'none', padding: 0, fontFamily: 'system-ui, sans-serif' }}>
      {achievements.map((a) => {
        const locked = a.unlockedAt === null
        return (
          <li key={a.achievementId} data-locked={locked ? 'true' : 'false'}
              style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, opacity: locked ? 0.55 : 1 }}>
            <div style={{ fontWeight: 600 }}>{a.name}</div>
            {a.description ? <div style={{ fontSize: 13, color: '#666' }}>{a.description}</div> : null}
            <div style={{ fontSize: 13, marginTop: 4 }}>{a.current}/{a.target}</div>
          </li>
        )
      })}
    </ul>
  )
}
```

`packages/widgets/src/index.ts`:
```ts
export { PromoceanProvider, usePromocean } from './provider.js'
export { UnlockToast } from './unlock-toast.js'
export { BadgeCabinet } from './badge-cabinet.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @promocean/widgets test`
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/widgets
git commit -m "feat(widgets): provider, accessible unlock toast, and badge cabinet"
```

---

### Task 11: `apps/demo` — Next.js demo + Playwright e2e

**Files:**
- Create: `apps/demo/*` via create-next-app, then edit `apps/demo/app/page.tsx`, `apps/demo/app/promocean.tsx`
- Create: `apps/demo/playwright.config.ts`, `apps/demo/e2e/achievement-loop.spec.ts`
- Modify: `apps/demo/package.json` (scripts), root `README.md` (dev + e2e instructions)

**Interfaces:**
- Consumes: `Promocean` (Task 9), `PromoceanProvider`/`UnlockToast`/`BadgeCabinet` (Task 10); running cms (Task 5) + api (Task 7); env `NEXT_PUBLIC_PROMOCEAN_KEY`, `NEXT_PUBLIC_PROMOCEAN_API`.
- Produces: demo at `localhost:3002`; e2e spec proving the loop; **this spec passing = Sprint 1 done.**

- [ ] **Step 1: Generate and wire the demo app**

```bash
pnpm dlx create-next-app@latest apps/demo --ts --app --no-eslint --no-tailwind --no-src-dir --import-alias '@/*' --use-pnpm
```
In `apps/demo/package.json`: set `"name": "demo"`, `"dev": "next dev -p 3002"`, `"start": "next start -p 3002"`, add `"typecheck": "tsc --noEmit"`, `"test": "echo ok"`, `"e2e": "playwright test"`; add deps `@promocean/sdk`, `@promocean/widgets` (`workspace:*`), devDep `@playwright/test@^1.53.0`.

`apps/demo/app/promocean.tsx`:
```tsx
'use client'
import { useMemo, useState } from 'react'
import { Promocean } from '@promocean/sdk'
import { BadgeCabinet, PromoceanProvider, UnlockToast } from '@promocean/widgets'

export function Demo({ userId }: { userId: string }) {
  const client = useMemo(() => new Promocean({
    publishableKey: process.env.NEXT_PUBLIC_PROMOCEAN_KEY!,
    baseUrl: process.env.NEXT_PUBLIC_PROMOCEAN_API!,
    userId,
  }), [userId])
  const [busy, setBusy] = useState(false)

  const fire = (type: string) => async () => {
    setBusy(true)
    try { await client.track(type) } finally { setBusy(false) }
  }

  return (
    <PromoceanProvider client={client}>
      <main style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Promocean Demo</h1>
        <p>User: <code>{userId}</code></p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <button disabled={busy} onClick={fire('lesson_completed')}>Complete a lesson</button>
          <button disabled={busy} onClick={fire('profile_completed')}>Complete profile</button>
        </div>
        <h2>Your badges</h2>
        <BadgeCabinet />
        <UnlockToast />
      </main>
    </PromoceanProvider>
  )
}
```

`apps/demo/app/page.tsx`:
```tsx
import { Demo } from './promocean.js'

export default async function Page({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const { user } = await searchParams
  return <Demo userId={user ?? 'demo-user'} />
}
```

- [ ] **Step 2: Manual smoke test**

Run in three terminals (or `pnpm dev` from root):
```bash
pnpm db:up && pnpm --filter cms dev
pnpm --filter api dev
pnpm --filter demo dev
```
Open `http://localhost:3002/?user=manual-1`, click **Complete a lesson**.
Expected: toast "🏆 Achievement unlocked — First Lesson"; badge cabinet shows First Lesson 1/1 unlocked, Getting Started 1/10 locked.

- [ ] **Step 3: Playwright e2e**

`apps/demo/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3002' },
  webServer: { command: 'pnpm dev', url: 'http://localhost:3002', reuseExistingServer: true, timeout: 120_000 },
})
```
(cms + api + postgres must already be running — documented in README; CI handles it in Step 5.)

`apps/demo/e2e/achievement-loop.spec.ts`:
```ts
import { expect, test } from '@playwright/test'

test('track → unlock toast → badge cabinet', async ({ page }) => {
  const user = `e2e-${Date.now()}`
  await page.goto(`/?user=${user}`)
  await page.getByRole('button', { name: 'Complete a lesson' }).click()
  await expect(page.getByRole('status')).toContainText('First Lesson')
  const cabinet = page.getByRole('list')
  await expect(cabinet.getByText('First Lesson')).toBeVisible()
  await expect(cabinet.getByText('1/10')).toBeVisible()
  await expect(cabinet.locator('[data-locked="false"]').getByText('First Lesson')).toBeVisible()
})
```

- [ ] **Step 4: Run e2e locally**

Run: `pnpm --filter demo exec playwright install chromium`, then with the stack running: `pnpm --filter demo e2e`
Expected: 1 test PASS. **This green test is the Sprint 1 definition of done.**

- [ ] **Step 5: Add e2e job to CI**

Append to `.github/workflows/ci.yml`:
```yaml
  e2e:
    runs-on: ubuntu-latest
    needs: test
    env:
      DATABASE_URL: postgres://promocean:promocean@localhost:5432/promocean
      CONFIG_PLANE_SECRET: ci-config-secret
      STRAPI_URL: http://localhost:1337
      SEED_DEMO: "true"
      NEXT_PUBLIC_PROMOCEAN_KEY: pk_test_demo_1234567890abcdef
      NEXT_PUBLIC_PROMOCEAN_API: http://localhost:3001
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: docker compose up -d postgres
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run build
      - run: |
          (cd apps/cms && pnpm develop &) 
          npx wait-on -t 120000 http://localhost:1337/_health
      - run: |
          (cd apps/api && pnpm start &)
          npx wait-on -t 60000 http://localhost:3001/healthz
      - run: pnpm --filter demo exec playwright install --with-deps chromium
      - run: pnpm --filter demo e2e
```
(Strapi needs its secrets in CI: generate throwaway `APP_KEYS` etc. via repository secrets or inline dummy values in the job `env` — dummy values are fine for ephemeral CI databases.)

- [ ] **Step 6: Update README quickstart with e2e instructions, verify full loop, commit**

Run: `pnpm turbo run typecheck build test` then the e2e flow once more.
Expected: everything green.

```bash
git add apps/demo .github README.md
git commit -m "feat(demo): next.js demo app with playwright e2e proving the achievement loop"
git push
```

---

## Self-Review Notes

- **Spec coverage (Sprint 0–1 scope):** monorepo/turbo ✓ (T1), contracts+OpenAPI — OpenAPI generation deliberately deferred to the Sprint 4 plan (spec lists it under "polish, docs, OpenAPI"); zod contracts ✓ (T2); core/ports/evaluation ✓ (T3); adapter-db with tenancy + idempotency + MAU counters ✓ (T4); Strapi types, provisioning content types, config-plane protocol, lifecycle key hook, seed ✓ (T5); adapter-strapi with TTL + stale-on-error ✓ (T6); runtime API with auth, error envelope, CORS ✓ (T7); CI ✓ (T8); SDK with retry/serialization/unlock events ✓ (T9); accessible widgets ✓ (T10); demo + e2e DoD ✓ (T11). Deferred to later sprint plans, per spec: offers, timed events, webhooks, rate limiting, origin allowlist, pino/Sentry, hosting, Changesets, `pnpm dev` seed-orchestration polish.
- **Type consistency:** `AchievementDefinition`, `Scope`, port method names (`insertEvent`, `getCounts`, `setProgress`, `recordUnlock`, `getUserAchievements`, `recordUsage`, `getAchievements`, `verifyKey`), and contract field names (`achievementId`, `current`, `target`, `unlockedAt`, `deduped`) verified identical across Tasks 2–11.
- **Placeholder scan:** clean — every code step contains complete code; generated apps (Strapi, Next) use their scaffolds plus the exact edits shown.
