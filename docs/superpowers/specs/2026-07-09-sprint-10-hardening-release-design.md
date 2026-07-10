# Sprint 10 Design: Hardening & Release Readiness

Approved via brainstorming session 2026-07-09. The Sprint-6-pattern consolidation
sprint: burn down the seven-issue backlog accumulated across Sprints 0–9, ship the
one cross-cutting integrator papercut fix (reactive `identify()`), and rehearse the
npm release pipeline end to end against a private registry — no public publish.

## 1. Scope

In scope:

- **Reactive identify** (the sprint's one feature): SDK `onUserChange` listener;
  `PromoceanProvider` re-renders consumers on identify/re-identify; widget effect
  deps corrected (closes the #21 reactivity item for every widget at once)
- **Issue burn-down**, all seven: #5 (UnlockToast key collision → monotonic toast
  ids; BadgeCabinet keep-stale + warn; useRealTimers in finally; SDK mixed-failure
  stale-status fix + instanceof test), #15 (stats offset-ISO acceptance, response
  asymmetry + disabled-events OpenAPI docs, 403 consistency, dead placements
  userId param removal), #18 (N-way unlock-crossing race test; Docker runner-stage
  trim; race-test parameterization where free), #20 (durable cms verification
  script: admin-session relation payloads + legacy duplicate-staticCode scan),
  #21 (RewardsStore test additions: unmount-during-claim, unmapped error code,
  dynamic-mock refetch; reactivity per above), #23 (delivered-claims TTL sweep;
  per-tick cost comment; stats totals query chunked per 50 events), #24
  (legacy-NULL `$ne` probe + NULL→'none' backfill if the probe shows exclusion)
- **S7 unfiled notes**: shared `isValidUserId` helper; `user_streaks` composite PK
  (migration 0009); wallet `recent` ordering id tiebreak
- **Dead-code sweep**: `PgEventStore`, `PgProgressStore.setProgress`, placements
  GET `userId` param
- **Release rehearsal (prep only)**: consume accumulated changesets via
  `changeset version` (committed); `pnpm publish -r --dry-run` pack validation;
  real publish to a local verdaccio + scratch-project install/import smoke test
  of contracts/sdk/widgets; `RELEASING.md`; fix whatever the rehearsal surfaces

Out of scope (explicitly): actual npm publish (needs NPM_TOKEN + org — Steve's
call, documented in RELEASING.md), cloud hosting, Sentry, config-as-code CLI,
React Native SDK.

## 2. Decisions and rationale

| Decision | Choice |
|---|---|
| Theme | Hardening & release readiness — backlog at 7 issues (deepest ever), deferred here explicitly during Sprint 9 planning |
| npm | Prep only: rehearse against verdaccio, no public publish; RELEASING.md documents the remaining manual step |
| Widget reactivity | Make `identify()` reactive (listener + provider state) rather than documenting the constraint — fixes login-after-load for every widget at once |
| Organization | Package-per-task (one task per package slice, issue→task closure map in the plan); risk-first ordering folded in; the only cross-task chain is sdk → widgets for reactivity |
| #23 postures | TTL sweep: implement (real unbounded growth); per-tick cost: comment only; bind params: chunk totals query per 50 events (simple loop) |
| BadgeCabinet refetch failure | Keep stale + `console.warn` (no-silent-catch posture; blanking a badge wall on a transient error is worse) |
| Backfilled NULL recurrence | Only if the #24 probe shows `$ne` excludes NULLs: one UPDATE backfilling NULL→'none' in the verification script's fix mode |

## 3. Architecture

### 3.1 Reactive identify

**SDK** (`packages/sdk/src/index.ts`): new listener set mirroring `onUnlock`:

```ts
onUserChange(cb: (userId: string | undefined) => void): () => void
```

`identify(userId)` notifies listeners only when the value CHANGES (same-id
re-identify does not notify). No constructor or option changes; no wire changes.

**Widgets** (`packages/widgets/src/provider.tsx`): the provider subscribes once
(`useEffect` with unsubscribe cleanup) and mirrors `client.currentUserId` into
React state exposed through context alongside the client: the context value
becomes `{ client, userId }`. Widgets read `userId` from context and list it in
their effect deps (replacing direct `client.currentUserId` reads in render/effect
logic). Effects re-run on identity change; identified-only widgets render nothing
again if the userId becomes undefined. StrictMode-safe: subscribe/unsubscribe in
the effect pair.

### 3.2 Per-package slices

- **adapter-db** (migration 0009): `user_streaks` composite PK
  `(project_id, environment, user_id)` replacing the bare unique index; delivery
  store gains `deleteDeliveredClaimsBefore(cutoff: Date): Promise<number>`
  (delivered_at < cutoff), wired into the scheduler retention phase with
  `DELIVERED_CLAIMS_TTL_DAYS` (default 30, envInt pattern); wallet `recent`
  ordering already has the id tiebreak — verify and extend to any query missing
  it; stats totals participants query chunked per 50 events (windows for ≤ 50
  events per statement, summed in JS — bind-param ceiling never approached);
  N-way unlock-crossing race test; dead `PgEventStore` and
  `PgProgressStore.setProgress` removed (with the port methods they implement,
  if nothing else consumes them — check EventStore/ProgressStore usage first;
  remove port methods only if genuinely unconsumed).
- **api**: `statsQuerySchema` gains `{ offset: true }` on both datetime fields;
  OpenAPI stats description documents response asymmetry (zero-filled
  timedEvents vs activity-only achievements/offers is GONE post-Sprint-9 — the
  actual current behavior is documented: timed events appear only with a window
  in range) and disabled-events inclusion; 403 documented on every sk endpoint
  uniformly; placements GET drops the unused `userId` query param (and its
  validation); `isValidUserId` extracted to one helper consumed by users.ts and
  engagement.ts.
- **sdk**: mixed-failure retry loop clears the stale 5xx status when a later
  attempt fails on a network error (#5); exhausted-retries test asserts
  `instanceof PromoceanApiError` + `.status`.
- **cms**: `apps/cms/scripts/verify-lifecycles.ts` (checked in, documented) runs
  three probes against a target DB: admin-session-shaped relation payloads
  through reward/timed-event lifecycles; duplicate-staticCode scan per project;
  legacy-NULL recurrence `$ne` behavior. `--fix` mode applies the NULL→'none'
  backfill. Script output lands in the task report; real defects found get fixed
  in-task.
- **Docker**: api/cms runner stages copy built output + pruned prod node_modules
  instead of the full workspace; before/after image sizes recorded.

### 3.3 Release rehearsal

One task, ordered late (after all version-relevant changes have landed their
changesets): run `pnpm changeset version` (consumes every accumulated changeset,
bumps contracts/sdk/widgets, writes CHANGELOGs — committed to the branch);
`pnpm publish -r --dry-run` and inspect pack lists against `files` allowlists;
boot verdaccio (`docker run -d -p 4873:4873 verdaccio/verdaccio` — ephemeral, not
in compose); publish the three MIT packages for real to verdaccio; scratch
project (`/tmp` scope) installs all three from verdaccio and exercises: contracts
schema parse, SDK client construction + one mocked-fetch call, widgets import +
render smoke via the package's own test deps. Fix what surfaces (missing files,
broken `exports` maps, `workspace:*` leakage — pnpm rewrites these on publish,
verify). Write `RELEASING.md`: the flow, the verdaccio rehearsal recipe, and the
single remaining manual step for public publish (NPM_TOKEN secret + npm org).
`release.yml` untouched unless proven broken.

## 4. Data flow

Reactivity: `identify()` → listener → provider state → context consumers
re-render → mount effects re-run with the new userId → widgets populate. Logout
(future): `identify` never un-identifies today; the listener fires only on
change, so the undefined branch exists for API symmetry and future logout.

Release: changesets (S4–S10) → `changeset version` → bumped manifests +
changelogs on the branch → dry-run pack validation → verdaccio publish →
scratch install proves the consumer experience.

## 5. Error handling

- Reactivity: a listener throwing must not break `identify` (try/catch per
  listener, matching onUnlock's posture — verify onUnlock actually has this;
  add to both if not).
- TTL sweep failures log and continue (existing retention-phase pattern).
- Verification script exits non-zero on probe failures with a human-readable
  findings list; `--fix` is explicit opt-in.
- The stats chunked query preserves per-event distinct semantics across chunks
  (chunk by event, never split one event's windows across chunks).

## 6. Testing

- Reactivity: per-widget identify-after-mount test (render unidentified →
  identify → widget populates); re-identify-different-user refetch; same-id
  no-op (no duplicate fetch); provider unsubscribe on unmount. One e2e
  assertion set added to the engagement loop: demo identifies after initial
  render, widgets populate.
- adapter-db: TTL sweep boundary (delivered just-inside/just-outside cutoff;
  undelivered claims never swept); unlock-crossing N-way race (exactly one
  unlock + one bonus); PK migration on a populated table (0009 preserves rows);
  chunked stats equivalence (same results for 1 chunk vs forced multi-chunk).
- api/sdk/widgets/cms slices: each carries the tests its issue names.
- Release rehearsal: the verdaccio transcript IS the test; scratch-project
  import assertions run as a script with recorded output.

## 7. Definition of done

- Full turbo suite green; fresh compose e2e green (all specs incl. the new
  reactivity assertions)
- Verdaccio rehearsal transcript: publish + install + import of all three
  packages; pack-list validation recorded
- Image-size before/after recorded for api and cms
- All seven issues closed via PR `Closes` lines (issue→task map in the plan);
  READMEs updated where behavior changed (reactivity, stats offset-ISO);
  changeset added for the sdk/widgets minor bumps BEFORE the version task runs
- `RELEASING.md` committed; migration 0009 additive-safe on existing data
