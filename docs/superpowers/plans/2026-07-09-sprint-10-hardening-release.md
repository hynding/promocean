# Promocean Sprint 10: Hardening & Release Readiness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Burn down the seven-issue backlog (#5 #15 #18 #20 #21 #23 #24) plus the S7 unfiled notes, ship reactive `identify()` across the widget layer, and rehearse the npm release pipeline end to end against a local verdaccio — no public publish.

**Architecture:** Package-per-task; everything is additive-or-internal so tasks are independent except one chain (sdk `onUserChange` → widgets provider) and one small vertical (the delivered-claims TTL sweep touches core port + adapter-db + the scheduler retention phase in one task). The release rehearsal runs LAST so `changeset version` consumes every changeset the sprint adds.

**Spec:** `docs/superpowers/specs/2026-07-09-sprint-10-hardening-release-design.md`. Branch `sprint-10-hardening-release` off main (PR #25 merge).

## Issue → Task closure map (PR carries the Closes lines)

| Issue | Closed by |
|---|---|
| #5 (widget toast + SDK error edge) | T1 (sdk half) + T2 (widgets half) |
| #15 (stats polish bundle) | T4 |
| #18 (race test, Docker hygiene, parameterization) | T3 (race test + parameterization) + T6 (Docker) |
| #20 (cms admin-session verification + legacy staticCode scan) | T5 |
| #21 (RewardsStore tests + identify-after-mount reactivity) | T2 |
| #23 (delivered-claims retention, per-tick cost, bind params) | T3 |
| #24 (legacy-NULL `$ne` proof) | T5 |

## Global Constraints

(All prior global constraints bind: error envelope, zod contracts single source of truth, TDD per task, per-package gates green before commit, compose-stack e2e in CI. api pnpm filter name is `api`.)

Sprint-10 additions (values verbatim from the spec):
- `onUserChange` notifies ONLY when the identified userId actually changes (same-id re-identify = no notification). A listener throwing must not break `identify` — try/catch per listener; verify `onUnlock` dispatch has the same guard and add it there too if missing.
- Provider context value becomes `{ client, userId }`; `usePromocean(): Promocean` keeps its exact signature (returns `.client`); new `usePromoceanUser(): string | undefined`. Widgets read the hook and list `userId` in effect deps — no widget re-reads `client.currentUserId` in render/effect logic afterward.
- BadgeCabinet refetch failure: keep stale + `console.warn` (never blank on transient error). UnlockToast keys/removal switch to a monotonic per-toast id (module counter) — no `${achievementId}-${unlockedAt}` composites, no reference equality.
- SDK mixed-failure fix: a network error in a later retry attempt CLEARS the remembered 5xx status (`lastStatus = undefined` in the catch) so exhausted retries throw the true final failure; exhausted-retries tests assert `instanceof PromoceanApiError` + `.status` (or plain Error for pure network failure), never message substrings.
- Delivered-claims TTL: `deleteDeliveredClaimsBefore(cutoff: Date): Promise<number>` (rows with `delivered_at IS NOT NULL AND delivered_at < cutoff`); scheduler retention phase; `DELIVERED_CLAIMS_TTL_DAYS` default 30 via the envInt pattern. Undelivered claims are NEVER swept (redelivery owns them).
- Migration 0009: `user_streaks` composite PRIMARY KEY `(project_id, environment, user_id)` replacing the bare unique index (drop `user_streaks_uq`). Additive-safe on populated tables (columns already NOT NULL).
- Stats totals participants: chunk by EVENT (≤ 50 events' windows per query — never split one event's windows across chunks); for the cross-event total, collect DISTINCT user_id per chunk and merge Sets in JS before counting (a user active in events from two chunks counts once). Per-event results unchanged.
- Dead code: remove `EventStore` port + `PgEventStore` (zero consumers — verified) and `ProgressStore.setProgress` (port method + Pg impl + fake). `ProgressStore` itself stays (users route consumes `getUserAchievements`).
- `statsQuerySchema` datetimes gain `{ offset: true }`; OpenAPI stats description already documents the intersects-range behavior — extend with the disabled-events inclusion note; 403 documented uniformly on ALL sk-only endpoints (stats, users delete, coupons pair, backfill).
- Release rehearsal is prep-only: verdaccio (`docker run -d --name verdaccio -p 4873:4873 verdaccio/verdaccio`, removed afterward), never the public registry; `release.yml` untouched unless the rehearsal proves it broken. `changeset version` output IS committed (bumped manifests + CHANGELOGs).
- cms verification script `apps/cms/scripts/verify-lifecycles.ts`: probes exit non-zero with findings; `--fix` explicitly opt-in; the NULL→'none' backfill runs ONLY if the `$ne` probe shows NULL rows are excluded from the ended-filter exemption.

---

### Task 1: sdk — onUserChange + mixed-failure retry fix

**Files:** Modify `packages/sdk/src/index.ts`; test `packages/sdk/test/sdk.test.ts`.

**Interfaces — produces (T2 consumes):**
```ts
onUserChange(cb: (userId: string | undefined) => void): () => void
// subscribe/unsubscribe shape identical to onUnlock; fires on identify(newId) when newId !== current;
// listener exceptions caught per-listener (console.warn), never breaking identify.
// identify(userId) itself: unchanged signature; after updating this.userId, notify if changed.
```
**Retry-loop fix (#5 sdk half), `request()`:** the network-error catch branch sets `lastStatus = undefined` alongside `lastErr = err`, so a 5xx followed by a network error on the final attempt throws the network error (plain Error) rather than a `PromoceanApiError` carrying the stale 5xx status. A run ending on a 5xx still throws the PromoceanApiError with that status (unchanged).

Tests (RED first): onUserChange fires on identify with a new id (payload = new id); same-id re-identify does NOT fire; multiple listeners all fire; unsubscribe stops delivery; a throwing listener doesn't prevent identify or other listeners (console.warn asserted via spy); onUnlock throwing-listener guard (add the same try/catch there if absent — test both); mixed-failure: mock fetch 500 then network-reject → exhausted retries throw a plain Error (NOT instanceof PromoceanApiError), message from the network error; all-5xx run → `instanceof PromoceanApiError` with `.status` = last 5xx (assert instanceof + status, no message substrings). Commit: `fix(sdk): user-change listener and true-final-failure retry errors`

---

### Task 2: widgets — reactive provider, toast hardening, RewardsStore tests

**Files:** Modify `packages/widgets/src/provider.tsx`, `src/unlock-toast.tsx`, `src/badge-cabinet.tsx`, `src/leaderboard.tsx`, `src/rewards-store.tsx` (and any other widget reading `client.currentUserId` — grep first); tests `packages/widgets/test/widgets.test.tsx`.

**Interfaces — consumes:** T1's `onUserChange`. **Produces:**
```tsx
// provider.tsx
const Ctx = createContext<{ client: Promocean; userId: string | undefined } | null>(null)
export function PromoceanProvider({ client, children }: { client: Promocean; children: ReactNode })
// subscribes to client.onUserChange in a useEffect (unsubscribe in cleanup, StrictMode-safe);
// mirrors client.currentUserId into useState, initialized from client.currentUserId at mount.
export function usePromocean(): Promocean            // unchanged signature — returns ctx.client
export function usePromoceanUser(): string | undefined  // new hook; throws outside provider like usePromocean
```
**Widget changes:** every widget that gates on identity reads `const userId = usePromoceanUser()` and lists `userId` in its fetch-effect deps; render-time identity checks use the hook value. **UnlockToast:** each incoming unlock gets `id: nextToastId++` (module-level counter); render keys and removal filter use `t.id` — the timer closure captures the id. **BadgeCabinet:** refetch-on-unlock failure keeps the previous list and `console.warn`s (no silent catch, no blanking). **Tests:** `vi.useRealTimers()` moved into `finally` wherever fake timers are used.

Tests: per identified-only widget — render unidentified (nothing) → `act(() => client-fake fires user change)` → widget fetches and populates; re-identify to a different user → refetch with new id (call-count + arg assertions); same-id notify absence covered at sdk level, but the provider must not re-render on a no-op (assert render count or effect call count stable); unsubscribe on unmount (fake exposes listener count). Toast: two unlocks same achievementId+unlockedAt millisecond → two toasts, dismissing one removes exactly that one; timer-based auto-dismiss removes the right toast under fake timers (finally-guarded). BadgeCabinet: refetch failure keeps stale list + warns. RewardsStore (#21): unmount-before-claim-resolves (no state update — spy on console.error for the React warning, assert absent); unmapped `PromoceanApiError` code renders `err.message`; non-ApiError rejection renders generic message; dynamic-mock refetch — wallet mock returns 250 then 50, post-claim the demo_discount-priced row flips to disabled "Not enough points" (DOM assertion). Commit: `feat(widgets): reactive identify via provider user state; toast and test hardening`

---

### Task 3: core/adapter-db — TTL sweep vertical, migration 0009, races, chunked stats, dead code

**Files:** Modify `packages/core/src/ports.ts` (WebhookDeliveryStore + remove EventStore + remove ProgressStore.setProgress), `packages/adapter-db/src/schema.ts` (user_streaks PK), `src/stores.ts` (PgWebhookDeliveryStore method; delete PgEventStore + PgProgressStore.setProgress; chunked stats totals; per-tick cost comment goes in api — see below), `src/index.ts` (export list); migration `packages/adapter-db/migrations/0009_*` (drizzle-kit generate); `apps/api/src/webhooks.ts` (retention phase calls the new method; the #23 per-tick cost comment lands on the tick loop), `apps/api/src/env.ts`-consumer wiring in `src/index.ts` (`DELIVERED_CLAIMS_TTL_DAYS`, envInt default 30), `apps/api/test/fakes.ts` (remove setProgress; add deleteDeliveredClaimsBefore); tests: `packages/adapter-db/test/webhook-delivery.test.ts`, `test/ingestion.test.ts` (race), `test/stats.test.ts` (chunk equivalence), `test/engagement.test.ts` (PK survival if fixtures touch streaks).

**Behavior:**
- Port: `deleteDeliveredClaimsBefore(cutoff: Date): Promise<number>` on `WebhookDeliveryStore` (JSDoc: delivered_at NOT NULL and < cutoff; undelivered rows untouched — redelivery owns them). Pg impl mirrors `deleteDeadLettersBefore`. Scheduler phase 3 gains the call next to the dead-letter purge, logging count when > 0, `deadLetterTtlDays`-style option `deliveredClaimsTtlDays` default 30, wired from env in `apps/api/src/index.ts`.
- Migration 0009: schema.ts `user_streaks` gains `primaryKey({ columns: [t.projectId, t.environment, t.userId] })` in the table extras and DROPS the `user_streaks_uq` uniqueIndex; drizzle-kit generates the constraint swap. Verify generated SQL: `ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY` + `DROP INDEX` — data-safe on populated tables.
- Unlock-crossing race (#18): N-way test (8 parallel `ingestEvent` calls whose increments sum across the target on one achievement) asserting exactly ONE `unlocks` row, exactly one `newUnlocks` emission across all results, and exactly one bonus ledger row. Parameterize the existing 2-way/8-way ingestion race pair while in the file (single `describe.each` or loop — only if genuinely free; skip if the structure resists).
- Chunked stats totals: split `timedEventWindows` into per-event groups, chunk groups so each query covers ≤ 50 events; per-event participant counts unchanged (already per-event queries or grouped — keep result shape identical); the cross-event `totals.timedEventParticipants` collects `SELECT DISTINCT user_id` per chunk and merges JS Sets. Equivalence test: same fixture evaluated with chunk size forced to 1 (test-only injection or a windows fixture > 50 events... keep simple: export chunk size as an optional constructor arg defaulting 50; test constructs the store with chunkSize 1 and asserts identical results to chunkSize 50, incl. a user active in two events from different chunks counted once in totals).
- Dead code: delete `EventStore` interface + `PgEventStore` + its export + any fake; delete `setProgress` from `ProgressStore` port, `PgProgressStore`, and `apps/api/test/fakes.ts:36`.
- Wallet/leaderboard tiebreak sweep: wallet `recent` already orders `(created_at DESC, id DESC)`; leaderboard ties by `user_id ASC` — verify both in code, add an ordering tiebreak ONLY where a query orders by a non-unique column alone (report findings; likely no change).

Workspace typecheck goes red between the port edit and the api wiring within this SAME task — end-of-task gate: `pnpm --filter @promocean/adapter-db test` + `pnpm --filter api test` + full `pnpm turbo run typecheck` green. Commit: `feat(adapter-db): delivered-claims retention, user_streaks PK, chunked stats totals, race coverage; drop dead stores (migration 0009)`

---

### Task 4: api/contracts — stats polish, 403 uniformity, validators, dead param

**Files:** Modify `packages/contracts/src/stats.ts` (offset acceptance), `apps/api/src/routes/placements.ts` (drop dead userId param), `src/routes/users.ts` + `src/routes/engagement.ts` (shared validator), create `apps/api/src/validation.ts`, modify `src/openapi.ts` (403 uniformity + disabled-events sentence); tests: contracts test (offset round-trip), api tests touching placements/users/engagement/openapi.

**Behavior:**
- `statsQuerySchema` from/to become `z.iso.datetime({ offset: true }).optional()` — offset-form inputs accepted (contracts test: `2026-07-01T00:00:00+02:00` parses; Z-form still parses; garbage rejected). Route code already `new Date(...)`s the values — offsets convert correctly; add one api test with an offset-form `from`.
- `apps/api/src/validation.ts`: `export function isValidUserId(userId: string): boolean { return userId.length >= 1 && userId.length <= 128 }` — users.ts inline check and engagement.ts local copy both replaced; bounds behavior identical (existing boundary tests keep passing untouched).
- placements.ts GET: remove the unused `userId` query parse/validation (nothing consumes it since the impression beacon — #15); adjust/remove its test.
- openapi.ts: every sk-only endpoint (`/v1/stats`, `DELETE /v1/users/{userId}`, `/v1/coupons/validate`, `/v1/coupons/redeem`, `/v1/achievements/{id}/backfill`) documents 403 with the same structure (the stats-style explicit entry); stats description gains the disabled-events sentence ("historical windows of since-disabled events are included"). OpenAPI test asserts a 403 response entry exists on all five.

Gate: contracts + api packages green; workspace typecheck green. Commit: `fix(api): stats offset datetimes, uniform 403 docs, shared userId validator, drop dead placement param`

---

### Task 5: cms — durable verification script + legacy probes

**Files:** Create `apps/cms/scripts/verify-lifecycles.ts` (+ an npm script `verify:lifecycles` in apps/cms/package.json); fix files only if probes find real defects; report records everything.

**Behavior (script, standalone Strapi bootstrap — the method from prior cms task reports, now checked in):** three probes against the target DB (dev Postgres 5433 by default, `DATABASE_URL`-overridable):
1. **Admin-session relation shapes (#20.1):** create + update a reward and a timed event through `strapi.entityService`/documents with relation payloads in the shapes the Content-Manager sends (numeric id, `{ id }`, `{ connect: [...] }`, `{ set: [...] }` — enumerate what `resolveProjectId` handles); assert slug/staticCode uniqueness checks actually FIRE on the update path for each shape (a silently-skipped check = probe failure).
2. **Duplicate staticCode scan (#20.2):** per project, group static rewards by staticCode; duplicates → non-zero exit listing them (no auto-fix; operator decides).
3. **Legacy-NULL recurrence probe (#24):** insert a raw NULL-recurrence timed-event row (SQL, simulating pre-0008 data), run the timedEventsAll filter query, report whether the NULL row is included or excluded from the recurring exemption; `--fix` backfills `UPDATE ... SET recurrence = 'none' WHERE recurrence IS NULL` (and the probe re-runs clean). Clean up the synthetic row either way.
Run the script live; if probe 1 or 3 reveals a real defect, fix it in this task (lifecycles populate/shape handling or the NULL backfill) with the fix live-verified. Typecheck green. Commit: `chore(cms): durable lifecycle verification script; legacy staticCode and NULL-recurrence probes`

---

### Task 6: Docker — runner-stage trim

**Files:** Modify `apps/api/Dockerfile`, `apps/cms/Dockerfile` (runner stages only; demo untouched unless trivially identical).

**Behavior:** runner stages copy built output (`dist`/build artifacts), the pruned production `node_modules` (from `pnpm deploy --prod` or the installer stage's prod-pruned tree — pick the mechanism that works with the existing turbo-prune layout), package.json files, and migrations (api needs `packages/adapter-db/migrations` at runtime — verify how migrations are located and DO NOT break `runMigrations`), instead of `COPY --from=installer /app .`. Non-root user, alpine, healthchecks unchanged. Record `docker images` sizes before/after for both.

Verification: `docker compose --profile stack build` then `up -d --wait` → all healthchecks pass, `/readyz` 200, seeded demo loads, ONE Playwright spec run as smoke (`pnpm --filter demo e2e -- --grep engagement` or equivalent single-spec filter) — the full suite runs in T7. Stack left down. Commit: `chore(docker): trim api and cms runner stages to built output and prod deps`

---

### Task 7: demo, e2e, docs, changeset — sprint DoD

**Files:** Modify `apps/demo/app/promocean.tsx` (a "Switch user" control: re-identifies the client to a fresh generated id — exercising reactive identify in the real app), extend `apps/demo/e2e/engagement-loop.spec.ts` (reactivity assertions: after switching user, the leaderboard highlight moves to the new id and the wallet readout resets/refetches — condition-based waits); docs: root README (reactive identify section: onUserChange, provider behavior, migration note "widgets now live-update on identify—remounting via key is no longer needed"; stats offset-ISO acceptance note), `packages/sdk/README.md` (onUserChange + retry-error semantics), `packages/widgets/README.md` (usePromoceanUser, reactive behavior); create `.changeset/hardening-reactive-identify.md` (minor: sdk, widgets; patch: contracts for the offset widening — additive input acceptance).

**DoD steps (in order):** `pnpm turbo run typecheck build test` fully green; fresh compose stack (`down -v && build && up -d --wait`, images now carry T6's trimmed runners + all sprint code); `pnpm --filter demo e2e` — ALL specs green including the new reactivity assertions; stop the stack; push branch. Commit: `feat(demo): switch-user reactivity demo; docs and changeset — sprint 10 wrap`

---

### Task 8: release rehearsal — verdaccio + RELEASING.md

**Files:** Create `RELEASING.md`; commit the `changeset version` output (bumped package.json versions + CHANGELOG.md files + consumed changeset removals); fix whatever the rehearsal surfaces (files allowlists, exports maps).

**Steps (record every command + output in the report):**
1. `pnpm changeset version` — consumes ALL pending changesets (rewards-and-coupons, campaign-lifecycle, forbidden-erasure-contracts, hardening-reactive-identify); inspect the version bumps and CHANGELOGs; commit.
2. `pnpm turbo run build --filter='./packages/*'` then `pnpm publish -r --dry-run --no-git-checks` — validate each MIT package's pack list against its `files` allowlist: dist present, src/tests absent, LICENSE present, README present; `workspace:*` deps rewritten to real versions in the packed package.json (inspect the tarball manifest).
3. `docker run -d --name verdaccio -p 4873:4873 verdaccio/verdaccio`; publish contracts, sdk, widgets to it (`--registry http://localhost:4873`, throwaway auth via `npm adduser` against verdaccio or auth-bypass config — document what worked).
4. Scratch project in the scratchpad/tmp: `npm init -y && npm install @promocean/contracts @promocean/sdk @promocean/widgets --registry http://localhost:4873` plus react/react-dom peers; a small node script imports contracts (parse one schema), constructs `new Promocean({...})` with a mock fetchImpl and calls `listRewards()` against a canned response, and imports `{ PromoceanProvider, RewardsStore }` from widgets asserting they're functions. Run it; record output.
5. Fix findings (missing files, broken exports/types fields, peer-dep gaps) and re-run the failing step.
6. `docker rm -f verdaccio`; write `RELEASING.md`: the changeset flow, the rehearsal recipe (steps 2–4 as a repeatable checklist), `release.yml`'s workflow_dispatch trigger, and the remaining manual step for public publish (create npm org/scope access + `NPM_TOKEN` repo secret; then run the release workflow). `release.yml` untouched unless step 2/3 proved it broken (if broken: fix + explain in report).
Gate: full `pnpm turbo run typecheck build test` still green after version bumps (internal `workspace:*` refs unaffected). Push branch. Commit: `chore(release): version packages, verdaccio rehearsal fixes, RELEASING.md`

---

## Self-Review Notes

- **Spec coverage:** §3.1 reactivity ✓ (T1 listener, T2 provider/hook/deps, T7 demo+e2e); §3.2 slices ✓ (T3 adapter-db+TTL vertical+dead code, T4 api/contracts, T5 cms script, T6 docker); §3.3 rehearsal ✓ (T8, ordered last so `changeset version` consumes T7's changeset); §5 error handling ✓ (per-listener try/catch T1, TTL log-and-continue T3, script non-zero exits T5, chunk-by-event T3); §6 testing mapped 1:1; §7 DoD split T7 (code gates + compose) / T8 (rehearsal transcript) with both pushing.
- **Issue map:** every issue has a closing task (table above); PR body carries `Closes #5 #15 #18 #20 #21 #23 #24`.
- **Known-break note:** the only intra-task red window is T3's port-edit→api-wiring (same task, end-of-task gates cover it). No cross-task breaks anywhere — hardening is additive.
- **Type consistency:** `onUserChange(cb): () => void` T1/T2; context `{ client, userId }` + `usePromoceanUser(): string | undefined` T2/T7 (demo consumes via widgets only); `deleteDeliveredClaimsBefore(cutoff: Date): Promise<number>` T3 port/impl/scheduler/fake; `isValidUserId` name/bounds T4 both consumers; chunk size 50 constructor-arg T3 impl/test.
- **Deliberate choices encoded:** `usePromocean()` signature preserved (returns client) so only identity-gated widgets change; toast ids from a module counter (no Date.now — deterministic under fake timers); chunked totals merge DISTINCT user sets in JS (correct cross-chunk dedup, bounded by participant count at MVP scale); T6 runs a single-spec smoke while T7 owns the full suite (avoids paying the whole e2e cost twice); verdaccio is ephemeral docker, never composed.
- **Compression note:** as with Sprints 2–9, test code specified behaviorally; interfaces, bounds, defaults, chunk sizes, and command sequences are exact.
