# Promocean Sprint 11: Config-as-Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Campaign definitions become git-committable JSON — a slug-keyed portable file, config-plane export/import endpoints (upsert + opt-in prune + dry-run, all lifecycle validations firing), and a thin MIT CLI whose dry-run doubles as a CI drift check.

**Architecture:** Slugs become the cross-instance identity for achievements/offers/timed events (rewards/placements already have them); files carry no documentIds. Export is a dedicated endpoint emitting the file format exactly (round-trip invariant: export → import = all-unchanged). Import writes through the Document Service in dependency order so the S8–S10 lifecycle checks fire; Strapi stays the single writer; the CLI depends only on the config-plane HTTP contract (the Strapi-exit posture). Runtime surfaces (api, adapters, widgets) are untouched.

**Spec:** `docs/superpowers/specs/2026-07-16-sprint-11-config-as-code-design.md`. Branch `sprint-11-config-as-code` off main (PR #27 merge).

## Global Constraints

(All prior global constraints bind: error envelope, zod contracts single source of truth, TDD per task, per-package gates green before commit, compose-stack e2e in CI. api pnpm filter name is `api`. cms has no unit harness — cms behavior is verified by checked-in live scripts, the S10 `verify-lifecycles.ts` pattern: disposable DB on dev Postgres 5433, localhost blast-radius guard, typed-error assertions, positive controls, `finally` cleanup.)

Sprint-11 additions (values verbatim from the spec):
- File format `formatVersion: 1`; slug regex `/^[a-z][a-z0-9_-]*$/`; dates `z.iso.datetime()`; cross-references by slug (offers → placement, offers → timedEvent); NO documentIds anywhere in the file; api-keys and webhook-endpoints are NOT covered (never exported, never pruned); `staticCode` IS exported (marketer copy, not credential).
- Import semantics: slug-matched upsert; field-level diff (unchanged definitions skipped — idempotent; `registeredEventTypes` compared order-insensitively); deletes ONLY with `prune: true` and only covered types; `dryRun: true` returns the plan with ZERO writes; apply order: project settings → placements → timed events → achievements → rewards → offers, deletes last in reverse order; mid-run lifecycle rejection → HTTP 422 with `{ applied: true, plan: <recomputed actually-applied plan>, error: { stage, message } }`; unknown slug cross-ref (not in existing ∪ file-created) → 400 BEFORE any write.
- Export fails loudly (500 + findings list naming each definition) on any covered row missing a slug — no silent slug synthesis.
- Round-trip invariant is a named test: export output imported back = all-unchanged plan.
- CLI: secret via `PROMOCEAN_CONFIG_SECRET` env var ONLY (never a flag); exit codes 0 success/no-drift, 1 any error, 2 dry-run-found-changes; deps limited to `@promocean/contracts` + `zod`; hand-rolled arg parsing; Node 20+; MIT.
- Runtime untouched: no changes under packages/core, packages/adapter-db, packages/adapter-strapi, packages/sdk, packages/widgets, apps/api (adapters' zod schemas strip the additive `slug` on config-plane reads without error — verified non-strict).
- Prune/runtime caveat (docs must state): update-in-place preserves documentIds; delete + recreate gets a NEW documentId — runtime history continuity across prune/recreate is explicitly not promised.

---

### Task 1: contracts — config file, import request/response schemas

**Files:** Create `packages/contracts/src/config-file.ts`; modify `src/index.ts` (re-export); test append `packages/contracts/test/contracts.test.ts`.

**Interfaces — produces:**
```ts
export const configSlugSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/)
export const configFileSchema = z.object({
  formatVersion: z.literal(1),
  project: z.object({
    pointRules: z.record(z.string(), z.number().int().min(0)),
    registeredEventTypes: z.array(z.string()),
    allowedOrigins: z.array(z.string()).nullable(),
  }),
  placements: z.array(z.object({ slug: configSlugSchema, name: z.string() })),
  achievements: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    artworkUrl: z.string().nullable(), eventType: z.string(),
    targetCount: z.number().int().min(1), pointsValue: z.number().int().min(0),
  })),
  timedEvents: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
    endingSoonMinutes: z.number().int().min(1), multiplier: z.number().int().min(1),
    recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']),
    recurrenceEndsAt: z.iso.datetime().nullable(), enabled: z.boolean(),
  })),
  offers: z.array(z.object({
    slug: configSlugSchema, name: z.string(), headline: z.string(),
    body: z.string().nullable(), imageUrl: z.string().nullable(),
    ctaText: z.string().nullable(), ctaUrl: z.string().nullable(),
    startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
    priority: z.number().int(), placement: configSlugSchema,
    timedEvent: configSlugSchema.nullable(),
  })),
  rewards: z.array(z.object({
    slug: configSlugSchema, name: z.string(), description: z.string().nullable(),
    codeType: z.enum(['generated', 'static']), staticCode: z.string().nullable(),
    codePrefix: z.string().nullable(), pointsPrice: z.number().int().min(0),
    startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
    perUserLimit: z.number().int().min(1), inventory: z.number().int().min(1).nullable(),
    enabled: z.boolean(),
  })),
})
export const importRequestSchema = z.object({
  file: configFileSchema,
  prune: z.boolean().default(false),
  dryRun: z.boolean().default(false),
})
const typePlanSchema = z.object({
  creates: z.array(z.string()), updates: z.array(z.string()),
  deletes: z.array(z.string()), unchanged: z.number().int().min(0),
})
export const importResponseSchema = z.object({
  applied: z.boolean(),
  plan: z.object({
    project: typePlanSchema, placements: typePlanSchema, achievements: typePlanSchema,
    timedEvents: typePlanSchema, offers: typePlanSchema, rewards: typePlanSchema,
  }),
  error: z.object({ stage: z.string(), message: z.string() }).optional(),
})
export type ConfigFile = z.infer<typeof configFileSchema>
export type ImportRequest = z.infer<typeof importRequestSchema>
export type ImportResponse = z.infer<typeof importResponseSchema>
```
(`project` in the plan uses creates/deletes always empty — settings are update-or-unchanged only; keeping one plan shape avoids a special case.)

Tests (RED first): full-file round-trip with every nullable exercised both ways; `formatVersion: 2` rejected; slug regex boundaries (leading digit, uppercase, hyphen + underscore accepted); offer with `timedEvent: null` accepted; prune/dryRun defaults false when omitted; importResponse with and without `error` parses; negative `unchanged` rejected. Additive — no break. Commit: `feat(contracts): config-as-code file, import request and response schemas`

---

### Task 2: cms — slugs on achievements, offers, timed events + seed backfill

**Files:** Modify `apps/cms/src/api/achievement/content-types/achievement/schema.json`, `apps/cms/src/api/offer/content-types/offer/schema.json`, `apps/cms/src/api/timed-event/content-types/timed-event/schema.json` (each gains `"slug": { "type": "string", "required": true }`); create `apps/cms/src/api/achievement/content-types/achievement/lifecycles.ts` and `apps/cms/src/api/offer/content-types/offer/lifecycles.ts`; modify `apps/cms/src/api/timed-event/content-types/timed-event/lifecycles.ts` (add slug checks to the existing recurrence validation); config-plane controller read mappers add `slug` (achievements, offers, timedEvents, timedEventsAll); seed `apps/cms/src/index.ts`; regenerate `contentTypes.d.ts`; extend `apps/cms/scripts/verify-lifecycles.ts` probe 1 to cover the three new types' slug checks.

**Slug lifecycles:** exactly the reward pattern (S8, incl. the populated-project-relation fix and update-path self-exclusion): regex `/^[a-z][a-z0-9_-]*$/`, unique per project. Extract nothing across content types yet unless trivially shared — mirror the reward file's structure per type (the S10 probe infrastructure asserts these fire; duplication across lifecycles files is the established pattern).

**Seed backfill (exact values):** achievements `first_lesson`, `getting_started`, `profiled`; offer `welcome_offer`; timed events `double_progress_weekend`, `weekly_happy_hour`. (Placement `homepage-banner` and rewards `welcome_coupon`/`demo_discount` already carry slugs.)

Verification (live, disposable DB via the checked-in script + curls): fresh seed carries all slugs; config-plane reads expose `slug` on all four timed/achievement/offer surfaces; slug lifecycle rejections (bad regex, in-project duplicate, self-update clean) fire for all THREE new types via the extended probe; second-boot idempotence; `pnpm --filter cms typecheck` green; ALSO run `pnpm --filter @promocean/adapter-strapi test` + `pnpm --filter api test` untouched-green (proves the additive field is stripped harmlessly). Commit: `feat(cms): slugs on achievements, offers, timed events with uniqueness lifecycles and seed backfill`

---

### Task 3: cms — export endpoint

**Files:** Modify `apps/cms/src/api/config-plane/controllers/config-plane.ts` (new `exportProject` handler), `apps/cms/src/api/config-plane/routes/config-plane.ts` (`GET /config-plane/projects/:projectId/export`).

**Interfaces — produces (Task 4 + CLI consume):** the response body IS a `ConfigFile` (Task 1 schema) — key order per the schema, explicit nulls for absent optionals, ISO datetimes, offers' `placement`/`timedEvent` as slugs resolved from populated relations.

**Behavior:** configSecretOk guard → 401; missing projectId → 400; unknown project → 404; query all covered types filtered by project (populate offer relations); ANY covered row with a missing/empty slug → 500 `{ error: 'unexported definitions missing slugs', findings: ['achievement "Getting Started" (documentId …)', …] }` listing EVERY offender (not just the first); map to the file shape; respond. `project.pointRules` defaults `{}`, `registeredEventTypes` defaults `[]`, `allowedOrigins` null when absent/malformed (matching the verifyKey mapper's tolerance).

Verification (live): guard/400/404; happy path parses against `configFileSchema` (run the parse in the verification script — the contract IS the test); slugless-row failure lists all offenders (create two slugless rows, assert both named); offer slug refs match the placement/timed-event slugs. Commit: `feat(cms): project config export endpoint`

---

### Task 4: cms — import endpoint + verify-config-sync script

**Files:** Modify config-plane controller (+`importProject` handler) and routes (`POST /config-plane/projects/:projectId/import`); create `apps/cms/src/api/config-plane/services/import-plan.ts` (pure-ish plan computation — keep the handler thin); create `apps/cms/scripts/verify-config-sync.ts` (+ npm script `verify:config-sync`) reusing the S10 script's harness conventions (localhost guard, disposable-DB workflow, typed assertions, finally cleanup, positive controls).

**Interfaces — consumes:** Task 1 schemas (parse body with `importRequestSchema`; respond `satisfies ImportResponse`); Task 3's export (for the round-trip test).

**Behavior (handler):**
1. Guard → 401; parse → 400 with zod issues.
2. Cross-ref resolution: every `offer.placement` ∈ (existing placement slugs ∪ file placement slugs) and every non-null `offer.timedEvent` ∈ (existing ∪ file timed-event slugs); violation → 400 `{ error: 'unknown reference', details: [{ offer: <slug>, ref: <slug>, type: 'placement'|'timedEvent' }] }`, zero writes.
3. Plan (in `import-plan.ts`, unit-testable shape even though cms has no harness — the verification script exercises it): per type, slug-match against current rows; `creates` = file-only slugs; `deletes` = cms-only slugs when prune else []; `updates` = matched slugs whose field-level diff is non-empty (normalize before compare: ISO strings vs stored datetimes through `new Date().toISOString()`; `registeredEventTypes` as sets; explicit null vs undefined unified to null); `unchanged` = matched with empty diff. Project settings: update-or-unchanged.
4. `dryRun` → `{ applied: false, plan }`, 200, zero writes.
5. Apply via `strapi.documents()` in the constraint order (project → placements → timedEvents → achievements → rewards → offers; deletes last, reverse order); offers resolve placement/timedEvent slugs to documentIds at write time. Lifecycle rejection mid-run → catch, recompute the actually-applied plan (re-query and re-diff — do NOT trust a partially-executed intended plan), respond 422 `{ applied: true, plan: <recomputed>, error: { stage: '<type>/<slug>', message } }`.
6. Full success → 200 `{ applied: true, plan }`.

**verify-config-sync.ts scenarios (each a named check, non-zero exit on failure):** round-trip invariant (export → import → every plan bucket empty except unchanged); create+update+unchanged in one file (assert exact slug lists); registeredEventTypes order-insensitive (reordered array → unchanged); prune only-with-flag (absent slug survives without prune, deleted with; api-key/webhook rows untouched — seed one webhook endpoint and assert survival); dry-run plan deep-equals the subsequent apply's plan; unknown-ref 400 before writes (count rows before/after); mid-run 422 (import a file whose reward has `codeType: 'static', staticCode: null` — the S8 lifecycle rejects it — assert 422, stage `rewards/<slug>`, earlier types genuinely applied, recomputed plan matches DB state); update-in-place preserves documentId (capture before/after).

Verification: script run recorded (all scenarios green) against a disposable DB; typecheck green. Commit: `feat(cms): config import endpoint with plan, prune, dry-run; config-sync verification script`

---

### Task 5: CLI — @promocean/cli package

**Files:** Create `packages/cli/` — `package.json` (name `@promocean/cli`, version 0.0.1, MIT license file copied from sdk's, `"bin": { "promocean": "./dist/cli.js" }`, `files: ["dist", "LICENSE", "README.md"]`, deps `@promocean/contracts` `workspace:*` + `zod`; scripts mirroring sdk: build/test/typecheck), `tsconfig.json` (mirror sdk's), `src/cli.ts` (entry: shebang `#!/usr/bin/env node`, arg dispatch), `src/args.ts` (hand-rolled parser: `parseArgs(argv): { command: 'export'|'import', url, project, out?, file?, prune, dryRun }` — throws usage errors naming the missing flag), `src/commands/export.ts`, `src/commands/import.ts`, `src/render.ts` (plan → human table string); `README.md`; tests `packages/cli/test/cli.test.ts` (vitest, mocked fetch injected — commands accept `fetchImpl` for tests, same DI style as the sdk).

**Interfaces — produces:**
```ts
// export command: GET {url}/api/config-plane/projects/{project}/export
//   headers { 'x-config-secret': process.env.PROMOCEAN_CONFIG_SECRET }
//   -> parse configFileSchema (defense vs drifted server) -> JSON.stringify(file, null, 2)
//   -> writeFile(out) or stdout. Missing env var -> exit 1 naming PROMOCEAN_CONFIG_SECRET.
// import command: read file, configFileSchema.parse (fail fast, zod issue paths listed),
//   POST {url}/api/config-plane/projects/{project}/import with { file, prune, dryRun }
//   -> parse importResponseSchema -> render plan table (per type: counts + slug lists,
//   error.stage/message prominent on 422).
// exit codes (constraint-exact): 0 success / dry-run-no-changes; 1 any error incl. 422;
//   2 dry-run completed with a non-empty creates/updates/deletes anywhere.
```
Tests: arg parsing (missing --url/--project/--file each named; unknown command usage); env secret required (exit 1, message names the var); export happy path writes validated pretty JSON; export server-drift (invalid body) → exit 1 with zod paths; import dry-run no changes → exit 0; dry-run with one create → exit 2 and the table shows it; apply success → 0; 422 → exit 1 rendering stage+message+applied plan; HTTP 401 → exit 1 with the envelope. Run gates: `pnpm --filter @promocean/cli test` + typecheck; full `pnpm turbo run typecheck` green (new package joins the workspace — check turbo picks it up; add to pnpm-workspace globs if needed, it matches `packages/*`). Commit: `feat(cli): promocean export and import commands`

---

### Task 6: e2e, docs, changeset — sprint DoD

**Files:** Create `apps/demo/e2e/config-sync.spec.ts`; docs: root README ("Config as code" section: authoring loop, CI drift check via exit code 2, prune semantics, the runtime-history caveat verbatim from the constraint), `packages/cli/README.md` already exists from Task 5 — extend if verification revealed gaps; `RELEASING.md` publish list gains `@promocean/cli` (MIT, non-private — confirm its package.json has NO `private: true` and carries `files`/LICENSE per Task 5); changeset `.changeset/config-as-code.md` (`@promocean/cli` minor — its first release lands it at 0.1.0; `@promocean/contracts` minor).

**e2e (`config-sync.spec.ts`)** — drives the CLI as a real subprocess (`execFile('node', ['packages/cli/dist/cli.js', ...])` from the repo root with `PROMOCEAN_CONFIG_SECRET` from the compose env) against the compose stack: export seeded project → file parses + contains the six seeded slugs; scripted edit (bump `first_lesson.pointsValue` to 60, append achievement `{ slug: 'bookworm', name: 'Bookworm', eventType: 'lesson_completed', targetCount: 25, pointsValue: 10, description: null, artworkUrl: null }`) → `--dry-run` exits 2 with plan showing exactly `updates: [first_lesson]`, `creates: [bookworm]` → import exits 0 → config-plane achievements read (or `/v1/users/:id/achievements` via api) shows Bookworm and pointsValue 60 within the 30s TTL (poll with condition-waits) → re-import exits 0 all-unchanged.

**DoD steps (in order):** `pnpm turbo run typecheck build test` fully green; fresh compose stack (`down -v && build && up -d --wait`); `pnpm --filter demo e2e` — ALL specs green incl. config-sync; hand transcript: the cross-instance simulation (create a second empty project via the admin bootstrap method, import the first project's export into it, export the second project, `diff` the two files — identical); stack down; push branch. Commit: `feat(e2e,docs): config-sync loop, config-as-code docs and changeset — sprint 11 wrap`

PR notes must state: three content types gain a required `slug` (existing dev volumes need reseed or manual slug backfill — the export endpoint's loud failure names offenders); config plane gains its first WRITE endpoint (same x-config-secret trust model, operator-only); new MIT package `@promocean/cli`; runtime surfaces untouched (adapters strip the additive slug); prune/runtime-history caveat; delivers the "config-as-code" v1.x slice — one roadmap item (React Native SDK) remains.

---

## Self-Review Notes

- **Spec coverage:** §3.1 file format ✓ (T1 verbatim schemas); §3.2 slugs + seed + read exposure + legacy posture ✓ (T2; slugless-export failure in T3); §3.3 export ✓ (T3 incl. all-offenders listing); §3.4 import ✓ (T4: plan service, cross-ref-before-write, dependency order, recomputed 422 plan, prune bounds); §3.5 CLI ✓ (T5: env-only secret, exit codes 0/1/2, DI fetch, zero extra deps); §4 flows = T6 e2e + hand transcript; §5 error handling mapped (loud slugless 500 T3, 400/422 T4, CLI renderings T5); §6 testing 1:1 (round-trip invariant + dry-run-equals-apply + order-insensitivity named in T4's script; existing-suite-untouched gate in T2); §7 DoD = T6.
- **Type consistency:** `ConfigFile`/`ImportRequest`/`ImportResponse` names identical T1/T3/T4/T5; plan bucket keys (`project, placements, achievements, timedEvents, offers, rewards` × `creates/updates/deletes/unchanged`) identical T1/T4/T5/T6; slug regex identical T1/T2; endpoint paths identical T3/T4/T5/T6; exit codes identical T5/T6; seed slugs identical T2/T6 (`first_lesson` etc.).
- **Known-break chain:** none — every task is additive; the only ordering constraints are T1→(T3,T4,T5) for schemas and T2→T3 for slugs existing. cms tasks are verified live (no unit harness), per the established pattern.
- **Deliberate choices encoded:** plan computation isolated in `import-plan.ts` so the diff/normalization logic has one home; 422's plan is RECOMPUTED from the DB, never the intended plan (partial-failure honesty); the e2e drives the CLI as a subprocess (tests the bin contract, not the library); `project` plan bucket kept shape-uniform (empty creates/deletes) to avoid a special case in contracts and the renderer; CLI at 0.0.1 + minor changeset → lands at 0.1.0 alongside its siblings.
- **Compression note:** as with Sprints 2–10, test/verification code specified behaviorally; schemas, endpoint semantics, orderings, exit codes, and seed slugs are exact.
