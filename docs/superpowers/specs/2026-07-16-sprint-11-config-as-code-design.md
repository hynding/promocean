# Sprint 11 Design: Config-as-Code — Export/Import & CLI

Approved via brainstorming session 2026-07-16. Campaign definitions become
git-committable JSON: a dedicated export endpoint emits a portable,
slug-keyed file; a secret-guarded import endpoint applies it back through the
Document Service so every existing lifecycle validation fires; a thin CLI
(`promocean`) wraps both and doubles as a CI drift-check. This is the design
doc's "config-as-code: JSON export/import of definitions + CLI (also the
Strapi-exit migration path)" v1.x slice — the second-to-last one.

## 1. Scope

In scope:

- **File format** (`formatVersion: 1`, zod-schema'd in contracts): project
  settings (pointRules, registeredEventTypes, allowedOrigins) + placements,
  achievements, timed events, offers, rewards — slug-keyed, slug
  cross-references, ISO dates, no documentIds (instance-portable)
- **Slug fields** added to achievements, offers, and timed events in the cms
  (rewards/placements already have them): same regex + per-project uniqueness
  lifecycles as rewards; seed backfilled; runtime surfaces UNTOUCHED (api,
  adapters, widgets keep keying on documentId)
- **Export**: `GET /config-plane/projects/:projectId/export` (config-secret
  guarded) emitting the file format exactly — round-trip guarantee:
  export → import always yields an all-unchanged plan
- **Import**: `POST /config-plane/projects/:projectId/import` — body = file +
  `{ prune?, dryRun? }`; slug-matched plan (creates/updates/deletes/unchanged)
  with field-level diffing (idempotent no-op updates skipped); writes through
  the Document Service in dependency order; prune only on request; dry-run
  returns the plan without writing
- **CLI** `packages/cli` (`@promocean/cli`, MIT, bin `promocean`): `export`
  and `import` commands; `PROMOCEAN_CONFIG_SECRET` env-only auth; client-side
  schema validation; exit code 2 on dry-run-found-changes (CI drift-check
  primitive); no runtime deps beyond contracts + zod
- Docs (root README section + cli README), changeset (new package 0.1.0,
  patch contracts), compose e2e

Out of scope (explicitly, spec-noted as future): webhook-endpoint/api-key
portability (secret material stays admin-UI-managed), YAML support,
multi-project files, a packaged GitHub Action wrapper, any Strapi-exit
reimplementation itself.

## 2. Decisions and rationale

| Decision | Choice |
|---|---|
| Import conflict semantics | Upsert + opt-in `--prune` + `--dry-run` — safe default, declarative on request; a truncated file cannot nuke campaigns unless prune was explicitly passed |
| Identity | Slugs on every covered type — unique per project, the import match key; names stay free-form display text; files carry no instance-specific ids |
| Coverage | Campaign definitions only; api-keys/webhook-endpoints excluded (credential material never lands in a git file). `staticCode` IS included: marketer-authored campaign copy, not a credential |
| Write path | Config-plane write endpoints (not Strapi admin API, not direct DB): reuses the x-config-secret trust model, and all S8–S10 lifecycle validations fire because writes go through the Document Service; Strapi stays the single writer |
| Strapi-exit posture | The CLI depends only on the config-plane HTTP contract — a future non-Strapi config plane implementing the same two endpoints keeps every file and workflow working |
| CLI licensing | MIT (customer-facing tooling, joins contracts/sdk/widgets) |
| Cross-references | By slug (offers → placement, offers → timedEvent), resolved at import; unknown refs that aren't created by the same file fail BEFORE any write |

## 3. Architecture

### 3.1 File format (contracts)

New `packages/contracts/src/config-file.ts`:

```
configFileSchema = {
  formatVersion: literal 1,
  project: { pointRules: Record<string, int>=0+, registeredEventTypes: string[],
             allowedOrigins: string[] | null },
  placements: [{ slug, name }],
  achievements: [{ slug, name, description|null, artworkUrl|null, eventType,
                  targetCount>=1, pointsValue>=0 }],
  timedEvents: [{ slug, name, description|null, startsAt, endsAt,
                  endingSoonMinutes>=1, multiplier>=1,
                  recurrence: none|daily|weekly|monthly, recurrenceEndsAt|null,
                  enabled }],
  offers: [{ slug, name, headline, body|null, imageUrl|null, ctaText|null,
             ctaUrl|null, startsAt|null, endsAt|null, priority,
             placement: <slug>, timedEvent: <slug> | null }],
  rewards: [{ slug, name, description|null, codeType, staticCode|null,
              codePrefix|null, pointsPrice>=0, startsAt|null, endsAt|null,
              perUserLimit>=1, inventory|null, enabled }],
}
```

Slug fields validated with the established regex `/^[a-z][a-z0-9_-]*$/`.
Dates `z.iso.datetime()`. Also `importRequestSchema` (file + `prune`/`dryRun`
booleans, default false) and `importResponseSchema`:

```
{ applied: boolean,
  plan: { <type>: { creates: string[], updates: string[], deletes: string[],
                    unchanged: number } },   // slug lists
  error?: { stage: string, message: string } }
```

### 3.2 cms: slugs

`achievement`, `offer`, and `timed-event` schemas gain
`"slug": { "type": "string", "required": true }`; each content type's
lifecycles gain the reward-pattern checks (regex, per-project uniqueness with
populated project relation and self-exclusion on update — the S8 populate
lesson applies verbatim). Seed backfills deterministic slugs for every seeded
definition (e.g. `first_lesson`, `getting_started`, `welcome_banner`,
`double_progress_weekend`, `weekly_happy_hour`). Config-plane READ endpoints
add `slug` to their per-type responses (additive; the adapters' zod schemas
tolerate unknown keys — they strip them without erroring — so no adapter/api
changes this sprint).

Pre-existing rows without slugs (dev volumes): the export endpoint fails
loudly on a slugless row, naming the definition and pointing at the admin UI
or a fresh reseed. No automatic slug synthesis — silent generated identity
would haunt later imports.

### 3.3 cms: export endpoint

`GET /config-plane/projects/:projectId/export` (configSecretOk guard; 400
missing projectId; 404 unknown project): queries all covered types, maps to
the file format exactly (slug refs resolved from relations; explicit nulls;
ISO dates), responds with the file. The round-trip invariant — export output
imported back yields all-unchanged — is a named test.

### 3.4 cms: import endpoint

`POST /config-plane/projects/:projectId/import` (same guard):

1. Parse body against `importRequestSchema` → 400 with zod issues.
2. Resolve slug cross-references against (existing ∪ file-created)
   placements/timedEvents; unknown → 400 naming the offending offer + ref,
   BEFORE any write.
3. Build the plan per type by slug match: create (slug absent), update (slug
   present, field-level diff non-empty — order-insensitive for
   registeredEventTypes; unchanged definitions skipped for idempotence),
   delete (only when `prune: true`, slugs present in cms but absent from the
   file), unchanged (count).
4. `dryRun: true` → respond `{ applied: false, plan }`, zero writes.
5. Apply through `strapi.documents()` in dependency order: project settings →
   placements → timed events → achievements → rewards → offers; deletes run
   last, reverse order. Lifecycle validations fire on every write. On a
   mid-run rejection: stop, respond `{ applied: true, plan: <what actually
   applied — recomputed, not the intended plan>, error: { stage, message } }`
   with HTTP 422. No cross-document transaction exists in Strapi — partial
   application is possible and documented; `--dry-run` first is the
   recommended workflow, and idempotent re-import after a fix converges.

Prune never touches uncovered types (api-keys, webhook-endpoints) and never
cascades into runtime history (unlocks/coupons/ledger live in the runtime DB
keyed by old documentIds; a pruned-then-reimported definition gets a NEW
documentId — runtime continuity across delete/recreate is explicitly not
promised; update-in-place preserves ids, which is why slug-matched upsert is
the default path).

### 3.5 CLI (`packages/cli`)

`@promocean/cli`, MIT, `"bin": { "promocean": "dist/cli.js" }`, deps:
`@promocean/contracts` + `zod` only; Node 20+; hand-rolled arg parsing.

- `promocean export --url <cms> --project <id> [--out <file>]` — GET export,
  validate against `configFileSchema` (defense against a drifted server),
  pretty-print JSON to `--out` or stdout.
- `promocean import --url <cms> --project <id> --file <file> [--prune]
  [--dry-run]` — read + client-side validate (fail fast with zod issues),
  POST, render the plan as a human-readable per-type table with counts and
  slug lists, surface `error.stage/message` prominently on 422.
- Secret: `PROMOCEAN_CONFIG_SECRET` env var ONLY (never a flag — process-list
  leakage); missing → loud error naming the variable.
- Exit codes: 0 success/no-drift; 1 any error (validation, HTTP, partial
  apply); 2 dry-run completed and found changes — making
  `promocean import --dry-run` a CI drift check with no extra tooling.

## 4. Data flow

Authoring loop: marketer edits in Strapi → `promocean export` → commit the
file → PR review → merge. Deployment loop: edit the file → `promocean import
--dry-run` (CI shows the plan, exit 2 gates) → `promocean import` → config
plane TTL cache picks the changes up within 30s → api serves them.
Migration loop (Strapi-exit insurance): export from instance A → import into
instance B's empty project → identical definitions (fresh documentIds;
runtime history intentionally does not follow).

## 5. Error handling

- Export: slugless legacy row → 500 with a findings list naming each
  offending definition (fail loud, no silent synthesis).
- Import: schema 400 (zod issues verbatim) → unknown-ref 400 (named) →
  lifecycle rejection 422 mid-run with recomputed applied-plan + stage;
  dry-run can never partially apply by construction.
- CLI: network/HTTP failures → exit 1 with the response error envelope
  rendered; validation failures list zod issue paths; 422 renders what
  applied and what stopped it.
- Config-plane guard failures unchanged (401 via configSecretOk).

## 6. Testing

- **contracts**: configFileSchema round-trips incl. every nullable; slug
  regex boundaries; cross-ref shape; importResponse plan shape;
  formatVersion literal rejects 2.
- **cms (live verification script, extending the S10 harness pattern —
  checked in)**: round-trip no-op invariant; create/update/unchanged
  field-diff correctness (incl. registeredEventTypes order-insensitivity);
  prune only-with-flag + only-covered-types; dry-run plan equals subsequent
  apply plan; mid-run lifecycle rejection reports recomputed applied-plan +
  422; unknown-slug-ref fails before writes; slugless-row export failure;
  slug lifecycle checks on all three new types (regex, duplicate,
  self-update).
- **CLI (vitest, mocked fetch — sdk test style)**: arg parsing incl. missing
  required flags; env-secret required; export writes validated file /
  stdout; import renders plan; exit codes 0/1/2 each asserted; 422 rendering.
- **e2e (compose)**: CLI exports the seeded project → scripted edit (bump a
  pointsValue, add one achievement) → `--dry-run` exits 2 listing exactly
  those changes → import applies → `GET /v1/users/:id/achievements` (or
  config-plane read) confirms the new definition serves → re-import exits 0
  all-unchanged.
- Existing suite must stay green untouched (slug additions are additive;
  adapters' non-strict schemas ignore the new field).

## 7. Definition of done

- Full turbo green; fresh compose e2e green (existing specs + the new
  config-sync spec)
- Hand transcript: cross-instance simulation — export from the seeded
  project, import into a second empty project on the same stack, then export
  the second project and diff: the two files must be identical
- Round-trip invariant demonstrated live (export → import → all-unchanged)
- README config-as-code section (authoring loop, CI drift check, prune
  semantics, runtime-history caveat); `packages/cli/README.md`; RELEASING.md
  gains the cli package in its publish list (MIT, non-private)
- Changeset: `@promocean/cli` 0.1.0 (new), `@promocean/contracts` minor
  (new schemas)
