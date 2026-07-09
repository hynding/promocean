# Promocean Sprint 8: Rewards & Coupons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The burn side of the Sprint 7 points economy: marketers define rewards in Strapi (generated or static coupon codes, optional points price, expiry/per-user/inventory constraints); users claim codes through a `RewardsStore` widget; the customer's checkout validates and redeems codes via sk-only endpoints with single-use enforcement.

**Architecture:** One new runtime table (`coupons`, migration 0007) that doubles as the claim record — claim counts and inventory derive from `COUNT(*)`, never maintained. Claims run in one transaction serialized by `pg_advisory_xact_lock` (per-reward, then per-user for priced claims) because `FOR UPDATE` cannot lock the absence of a row; the wallet debit is a negative `points_ledger` row (`source: 'redemption'`) in the same transaction. Redeem is a single conditional UPDATE — the race guard with no lock. Config: new `reward` content type served by a dedicated config-plane endpoint. Layering as always: pure calc in `core`, persistence in `adapter-db`, config in cms/adapter-strapi, routes in `apps/api`, then SDK → widgets → demo/e2e.

**Spec:** `docs/superpowers/specs/2026-07-09-sprint-8-rewards-coupons-design.md`. Branch `sprint-8-rewards-coupons` (currently based on `sprint-7-engagement` @ 53606d0; rebase onto main once PR #19 merges, before Task 1).

## Global Constraints

(All prior global constraints bind: error envelope, zod contracts single source of truth, TDD per task, per-package gates green before commit, known-break pattern recorded on port widening, compose-stack e2e in CI.)

Sprint-8 additions (values verbatim from the spec):
- `staticCode` NEVER appears in any pk-accessible response (`GET /v1/rewards` omits it); a static reward's code is revealed only by claiming. The config-plane response (secret-guarded, api-internal) does carry it.
- New error codes: `reward_unavailable` (disabled / out of window / inventory exhausted / expired-at-redeem), `claim_limit_reached`, `insufficient_points`, `already_redeemed`. All four map to HTTP 409 (state-dependent conflicts); `not_found` stays 404, validation stays 400.
- Claim transaction lock order, always: reward advisory lock, then (only when `pointsPrice > 0`) user advisory lock — same order in every code path, so no deadlock cycle is possible. Locks are `pg_advisory_xact_lock(hashtext(<ns>), hashtext(<key>))` with ns = `'{projectId}:{environment}'`, key = `'reward:{rewardId}'` / `'user:{userId}'` (collision over-serializes, never corrupts).
- Generated codes: 10 chars from the 32-char alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0/O/1/I`), optional `codePrefix` prepended verbatim; ≤ 3 insert retries on unique-violation, then throw (a collision loop at 32^10 keyspace signals a bug).
- Validate is read-only and ALWAYS returns 200 `{ valid, ... }` — a checkout probing a code is not an error. Its `reason` values (`not_found` / `already_redeemed` / `expired`) are a response-field enum, not error-catalog codes. Redeem mutates and uses the error envelope.
- Expiry (`endsAt`) is evaluated at validate/redeem time — claimed codes die with the campaign. A rewardId no longer present in config is treated as expired. Only `startsAt` gates claiming; it never gates redemption.
- Static (shared) codes: redeem consumes the oldest unredeemed claim (`ORDER BY claimed_at ASC, id ASC` + `FOR UPDATE SKIP LOCKED` so concurrent redeems consume distinct claims); validate reports `valid: true` if ANY unredeemed claim exists.
- Balances stay computed (`SUM(delta)`); the debit row's `sourceRef` is the coupon id. Wallet may now go DOWN but never below 0 (balance check inside the user lock).
- userId bounds 1..128 (established); code bounds 1..64 on validate/redeem input.
- Erasure (`DELETE /v1/users/:userId`) must delete the user's coupon rows and report the count (the Sprint 7 Critical, applied proactively).
- Inventory lowered in Strapi below claimed count: new claims blocked, existing coupons unaffected (no clawback).
- Rewards config is per-project like every other content type (offers/achievements carry no environment field); runtime coupon rows are scoped by the auth context's project+environment.

---

### Task 1: contracts — reward/coupon schemas, error codes, ledger source widening

**Files:** Create `packages/contracts/src/rewards.ts`; modify `src/errors.ts` (4 new codes), `src/wallet.ts` (source enum), `src/users.ts` (erase counts), `src/index.ts`; test append `packages/contracts/test/contracts.test.ts`.

**Interfaces — produces:**
```ts
// errors.ts: errorCodeSchema gains 'reward_unavailable' | 'claim_limit_reached' | 'insufficient_points' | 'already_redeemed'

// wallet.ts: recent[].source becomes z.enum(['event', 'unlock', 'redemption'])

// users.ts: eraseUserResponseSchema counts gains coupons: z.number().int()

// rewards.ts
export const rewardSchema = z.object({
  slug: z.string(), name: z.string(), description: z.string().nullable(),
  codeType: z.enum(['generated', 'static']),   // staticCode itself is NEVER in this schema
  pointsPrice: z.number().int().min(0),
  startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
  perUserLimit: z.number().int().min(1),
  inventory: z.number().int().min(1).nullable(),
  remaining: z.number().int().min(0).nullable(), // null = uncapped
})
export const rewardsResponseSchema = z.object({ rewards: z.array(rewardSchema) })
export const claimRewardRequestSchema = z.object({ userId: z.string().min(1).max(128) })
export const claimRewardResponseSchema = z.object({
  code: z.string(), rewardSlug: z.string(), claimedAt: z.iso.datetime(), pointsSpent: z.number().int().min(0),
})
export const couponCodeSchema = z.string().min(1).max(64)
export const validateCouponRequestSchema = z.object({ code: couponCodeSchema })
export const validateCouponResponseSchema = z.object({
  valid: z.boolean(),
  rewardSlug: z.string().optional(),           // present whenever the code resolved to a reward
  status: z.enum(['claimed', 'redeemed']).optional(),
  reason: z.enum(['not_found', 'already_redeemed', 'expired']).optional(), // present iff valid: false
})
export const redeemCouponRequestSchema = z.object({ code: couponCodeSchema })
export const redeemCouponResponseSchema = z.object({
  redeemed: z.literal(true), rewardSlug: z.string(), redeemedAt: z.iso.datetime(),
})
export type Reward = z.infer<typeof rewardSchema>
// + z.infer type exports for every schema above, house style
```
Tests (RED first): each schema round-trips; `pointsPrice` −1 rejected / 0 accepted; `perUserLimit` 0 rejected; `inventory` 0 rejected / null accepted; code length 0 and 65 rejected, 64 accepted; wallet accepts a `'redemption'` entry; erase counts without `coupons` rejected; the four new error codes parse.

**Known break (record, don't patch):** `counts` widening breaks apps/api `satisfies EraseUserResponse` and the wallet source widening breaks nothing yet, but api stays red until Task 6 anyway once core ports widen in Task 2. Contracts gates green. Commit: `feat(contracts): reward, claim, and coupon schemas; redemption ledger source`

---

### Task 2: core — RewardDefinition, ports, pure claim/code logic

**Files:** Modify `packages/core/src/types.ts`, `src/ports.ts`, `src/index.ts`; create `src/rewards.ts`; tests `packages/core/test/rewards.test.ts`.

**Interfaces — produces:**
```ts
// types.ts
export interface RewardDefinition {
  id: string
  slug: string
  name: string
  description: string | null
  codeType: 'generated' | 'static'
  staticCode: string | null      // populated iff codeType === 'static'
  codePrefix: string | null      // generated codes only
  pointsPrice: number            // 0 = free
  startsAt: Date | null
  endsAt: Date | null
  perUserLimit: number
  inventory: number | null       // null = uncapped
  enabled: boolean
}

// rewards.ts (pure, exhaustive tests)
export const COUPON_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 chars, no 0/O/1/I
export function couponCodeFromBytes(bytes: Uint8Array, prefix: string | null): string
// requires bytes.length === 10 (throw otherwise); maps alphabet[byte % 32] per byte; prefix ?? '' prepended
export type ClaimRejection = 'reward_unavailable' | 'claim_limit_reached' | 'insufficient_points'
export function decideClaim(input: {
  reward: RewardDefinition
  now: Date
  claimedCount: number       // all claims for this reward (scope-wide)
  userClaimedCount: number   // this user's claims for this reward
  balance: number            // caller supplies 0 for free rewards (skip the SUM)
}): { ok: true; debit: number } | { ok: false; reason: ClaimRejection }
// check order (first failure wins): !enabled OR now < startsAt OR now > endsAt -> reward_unavailable;
// inventory !== null && claimedCount >= inventory -> reward_unavailable;
// userClaimedCount >= perUserLimit -> claim_limit_reached;
// pointsPrice > balance -> insufficient_points; else ok with debit = pointsPrice

// ports.ts:
// ConfigStore gains getRewards(projectId: string): Promise<RewardDefinition[]>
// ErasureStore.eraseUser return gains coupons: number
// EngagementStore.getWallet recent[].source widens to 'event' | 'unlock' | 'redemption'
export interface RewardStore {
  getClaimCounts(scope: Scope, rewardIds: string[]): Promise<Map<string, number>>
  claimCoupon(scope: Scope, userId: string, reward: RewardDefinition, now: Date): Promise<
    | { ok: true; couponId: string; code: string; claimedAt: Date; pointsSpent: number }
    | { ok: false; reason: ClaimRejection }>
  // claimCoupon re-runs decideClaim INSIDE its transaction with locked counts/balance —
  // the route's pre-check is a fast path, never the guard.
  validateCoupon(scope: Scope, code: string): Promise<
    | { found: false }
    | { found: true; rewardId: string; status: 'claimed' | 'redeemed' }>
  // prefers an unredeemed row when the code is shared: reports 'claimed' if ANY unredeemed claim exists
  redeemCoupon(scope: Scope, code: string): Promise<
    | { ok: true; rewardId: string; redeemedAt: Date }
    | { ok: false; reason: 'not_found' | 'already_redeemed' }>
}
```
Tests: couponCodeFromBytes — length/alphabet properties (every output char ∈ alphabet, length 10 + prefix), deterministic for fixed bytes, prefix null vs `'SUMMER-'`, wrong byte-length throws; decideClaim — full matrix: disabled, before startsAt, after endsAt, at-boundary instants (startsAt inclusive, endsAt inclusive), inventory exactly-at vs one-under, per-user at-limit vs under, balance exactly-equal (ok) vs one-short (insufficient), free reward with balance 0 ok, null inventory/window fields skip their checks, check-order precedence (disabled + broke → reward_unavailable wins).

**Known break (record, don't patch):** `ConfigStore.getRewards` + `ErasureStore`/`EngagementStore` widening break adapter-db, adapter-strapi, apps/api until Tasks 3/5/6 (same chain shape as Sprint 7). Core gates green. Commit: `feat(core): reward definitions, claim decision, coupon codes, and reward ports`

---

### Task 3: adapter-db — migration 0007, PgRewardStore, erasure coupons

**Files:** Modify `packages/adapter-db/src/schema.ts`, `src/stores.ts` (new class + erasure + wallet source cast), `src/index.ts`; create migration `packages/adapter-db/migrations/0007_*` (drizzle-kit generate); tests `packages/adapter-db/test/rewards.test.ts` + extend `test/erasure.test.ts` (or wherever eraseUser is covered).

**Schema:** `coupons` (`id uuid PK default random`, `project_id`, `environment`, `reward_id text NOT NULL`, `user_id text NOT NULL`, `code text NOT NULL`, `code_shared boolean NOT NULL default false`, `status text NOT NULL default 'claimed'`, `claimed_at timestamptz default now() NOT NULL`, `redeemed_at timestamptz`), indexes: partial unique `coupons_code_uq (project_id, environment, code) WHERE code_shared = false`; `coupons_code_ix (project_id, environment, code)`; `coupons_reward_ix (project_id, environment, reward_id)`; `coupons_user_ix (project_id, environment, reward_id, user_id)`.

**Behavior (`PgRewardStore implements RewardStore`):**
- `getClaimCounts`: `SELECT reward_id, COUNT(*) ... WHERE reward_id IN (...) GROUP BY reward_id`; absent ids simply missing from the Map; empty input → empty Map without querying.
- `claimCoupon(scope, userId, reward, now)` — one `db.transaction`: (1) `SELECT pg_advisory_xact_lock(hashtext(${projectId + ':' + environment}), hashtext(${'reward:' + reward.id}))`; (2) if `reward.pointsPrice > 0`, same call with `'user:' + userId` (lock order per Global Constraints); (3) count claims for reward, count for (reward, user), and if priced `COALESCE(SUM(delta),0)` from `points_ledger` for the user; (4) `decideClaim({ reward, now, claimedCount, userClaimedCount, balance })` (import from @promocean/core — the applyStreak precedent); not-ok → return the rejection (transaction commits having written nothing); (5) code: static → `reward.staticCode!` with `codeShared: true`; generated → `couponCodeFromBytes(randomBytes(10), reward.codePrefix)` with `codeShared: false`, retried ≤ 3 times on pg unique violation `23505` on `coupons_code_uq` (re-generate bytes each retry; rethrow anything else, throw after 3rd); (6) insert coupon row, then if priced insert `points_ledger` row (`delta: -reward.pointsPrice, source: 'redemption', sourceRef: <coupon id>`); (7) return `{ ok: true, couponId, code, claimedAt, pointsSpent: reward.pointsPrice }`.
- `validateCoupon`: single SELECT `WHERE scope AND code ORDER BY (status = 'claimed') DESC, claimed_at ASC LIMIT 1` → `{ found: false }` or `{ found: true, rewardId, status }`.
- `redeemCoupon`: one transaction: `UPDATE coupons SET status = 'redeemed', redeemed_at = now() WHERE id = (SELECT id FROM coupons WHERE scope AND code AND status = 'claimed' ORDER BY claimed_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING reward_id, redeemed_at`. Zero rows → diagnose with a follow-up existence SELECT: no row for code → `not_found`; rows exist (all redeemed or locked-elsewhere-and-then-redeemed) → `already_redeemed`.
- `PgErasureStore.eraseUser` gains the coupons delete + count (same delete-returning pattern as the other six).
- `PgEngagementStore.getWallet` source cast widens to `'event' | 'unlock' | 'redemption'`.

Tests (Testcontainers): free static claim (row written, no ledger row, code = staticCode, codeShared true); priced generated claim (ledger row −100 sourceRef = coupon id, wallet SUM drops, code matches `/^DEMO-[A-Z2-9]{10}$/`-style shape); rejection paths write NOTHING (assert row counts unchanged: inventory-full, per-user-limit, insufficient balance); **N-way concurrent claim race at the inventory boundary** (inventory 3, 8 parallel claims → exactly 3 coupon rows, 5 `reward_unavailable`); **balance-boundary race** (balance covers exactly 1 priced claim, 4 parallel claims on TWO different priced rewards for the same user → exactly one success, wallet ≥ 0 after — this is what the user lock exists for); per-user-limit race (limit 1, parallel same-user claims → 1 row); generated-code uniqueness across claims; static shared code inserts N rows for N users despite equal `code`; redeem happy path; **parallel redeems of one generated code → exactly one success, one `already_redeemed`**; two-users-one-static-code parallel redeems → BOTH succeed consuming distinct claims (SKIP LOCKED); oldest-first consumption order (claim twice, redeem once → earlier `claimed_at` row flipped); validate prefers unredeemed row on shared codes; cross-tenant isolation (same code text in two scopes); erasure deletes coupons + reports count. Workspace still red (adapter-strapi, api) — known break continues. Commit: `feat(adapter-db): coupons table, claim/validate/redeem store, erasure coverage (migration 0007)`

---

### Task 4: cms — reward content type, lifecycle validation, config-plane endpoint, seed

**Files:** Create `apps/cms/src/api/reward/content-types/reward/schema.json`, `apps/cms/src/api/reward/content-types/reward/lifecycles.ts` (+ the standard empty `controllers`/`routes`/`services` scaffolding mirroring `offer`); modify config-plane controller `apps/cms/src/api/config-plane/controllers/config-plane.ts` + routes (`GET /config-plane/rewards?projectId=`, same `configSecretOk` guard), seed in `apps/cms/src/index.ts`; regenerate `contentTypes.d.ts`.

**Content type attributes:** `name` string required; `slug` string required (validated `/^[a-z][a-z0-9_-]*$/` in lifecycles, unique per project — enforce with a lifecycle duplicate check, matching how placements guard slugs if they do, else a filtered count query); `description` text; `enabled` boolean default true required; `codeType` enumeration `['generated','static']` required default `generated`; `staticCode` string; `codePrefix` string; `pointsPrice` integer min 0 default 0 required; `startsAt`/`endsAt` datetime; `perUserLimit` integer min 1 default 1 required; `inventory` integer min 1; `project` manyToOne relation → `api::project.project`. (No environment field — config is per-project, like offers/achievements.)

**Lifecycles (beforeCreate/beforeUpdate, mirror api-key/webhook-endpoint style):** `codeType === 'static'` ⇒ non-empty `staticCode` required (reject otherwise); `codeType === 'generated'` ⇒ `staticCode` must be empty; both dates present ⇒ `endsAt > startsAt`; `staticCode`/`codePrefix` length ≤ 64.

**Config-plane response** (`{ rewards: [...] }`, missing projectId → 400, unknown project → empty list, matching the offers handler): each reward mapped as `{ id, slug, name, description, codeType, staticCode, codePrefix, pointsPrice, startsAt, endsAt, perUserLimit, inventory, enabled }` — staticCode IS included here (secret-guarded internal plane; the api strips it from public responses).

**Seed:** demo project gains two rewards — `welcome_coupon` (static `WELCOME10`, pointsPrice 0, perUserLimit 1, no window, no inventory) and `demo_discount` (generated, codePrefix `DEMO-`, pointsPrice 100, perUserLimit 5, inventory 50). Idempotence-gated like the existing seed entries.

Verification: live curl — rewards guard (401 without secret) / 400 missing projectId / happy path carrying both rewards incl. staticCode / lifecycle rejections (static without staticCode, endsAt ≤ startsAt); typecheck green. Commit: `feat(cms): reward content type, validation, config-plane rewards, seed`

---

### Task 5: adapter-strapi — rewards schema + getRewards

**Files:** Modify `packages/adapter-strapi/src/index.ts`, `src/schemas.ts`; test `packages/adapter-strapi/test/adapter.test.ts`.

**Behavior:** `rewardsResponseSchema` in schemas.ts: `{ rewards: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), description: z.string().nullable(), codeType: z.enum(['generated','static']), staticCode: z.string().nullable(), codePrefix: z.string().nullable(), pointsPrice: z.number().int().min(0), startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(), perUserLimit: z.number().int().min(1), inventory: z.number().int().min(1).nullable(), enabled: z.boolean() })) }`. New `getRewards(projectId)` implementing the widened ConfigStore: `rewardsCache` map, same TTL + stale-on-error machinery as getOffers, fetch `/api/config-plane/rewards?projectId=`, parseOrThrow, map dates via `new Date(...)` into `RewardDefinition[]`. Tests: happy path mapping (both codeTypes), cache hit (second call no fetch), malformed response → throws → stale-on-error returns cached, static reward carries staticCode through. apps/api still red until Task 6 — recorded. Commit: `feat(adapter-strapi): rewards config fetch`

---

### Task 6: api — rewards + coupons routes, wiring, openapi

**Files:** Create `apps/api/src/routes/rewards.ts` (catalog + claim), `src/routes/coupons.ts` (validate + redeem); modify `src/app.ts` (AppDeps gains `rewardStore: RewardStore`; mount `app.route('/v1/rewards', rewardsRoute(deps))` and `app.route('/v1/coupons', couponsRoute(deps))`), `src/index.ts` (wire `PgRewardStore`), `src/openapi.ts` (four paths + schemas), `test/fakes.ts` (fake configStore gains getRewards; new fakeRewardStore with settable results); tests `apps/api/test/rewards.test.ts`.

**rewards.ts:**
- `GET /` (pk ok): `const rewards = (await deps.configStore.getRewards(scope.projectId)).filter(r => r.enabled)`; visible = also within `startsAt`/`endsAt` (now-based; null bounds pass); `const counts = await deps.rewardStore.getClaimCounts(scope, visible.map(r => r.id))`; map to contract shape with `remaining: r.inventory === null ? null : Math.max(0, r.inventory - (counts.get(r.id) ?? 0))` — NEVER `staticCode` (assert in test), dates as ISO. Respond `{ rewards } satisfies RewardsResponse`.
- `POST /:slug/claim` (pk ok): parse body via `claimRewardRequestSchema` (400 invalid_payload); find reward by slug among `getRewards(...)` (unknown slug → 404 not_found; disabled or out-of-window → 409 reward_unavailable — the route's only pre-checks, both config-derived); everything count/balance-dependent is decided solely by `deps.rewardStore.claimCoupon(scope, userId, reward, new Date())` (which re-runs decideClaim under the locks — no route-level fast-path duplicate). Map the result: ok → `{ code, rewardSlug: slug, claimedAt: ISO, pointsSpent } satisfies ClaimRewardResponse`; `{ ok: false, reason }` → 409 with `code: reason` and a per-code human message.
- Config-plane failure: `getRewards` throws (cold cache, CMS down) → let it hit the app-level `onError` 500 path for the catalog; for claim, same — claims fail closed against unknown config (established posture).

**coupons.ts (both handlers open with the sk guard — `auth.keyType !== 'secret'` → 403 forbidden, users.ts precedent):**
- `POST /validate`: parse `validateCouponRequestSchema` (400); `const hit = await deps.rewardStore.validateCoupon(scope, code)`; `!hit.found` → 200 `{ valid: false, reason: 'not_found' }`; resolve reward by `hit.rewardId` from `getRewards` — missing from config OR `endsAt` in the past → 200 `{ valid: false, rewardSlug?, reason: 'expired' }` (slug present only when config still has it); `hit.status === 'redeemed'` → 200 `{ valid: false, rewardSlug, status: 'redeemed', reason: 'already_redeemed' }`; else 200 `{ valid: true, rewardSlug, status: 'claimed' }`.
- `POST /redeem`: parse (400); resolve as validate does — code unknown → 404 not_found; reward missing/`endsAt` past → 409 reward_unavailable; then `deps.rewardStore.redeemCoupon(scope, code)`: `{ ok: false, reason: 'already_redeemed' }` → 409; `not_found` (lost a race with erasure) → 404; ok → 200 `{ redeemed: true, rewardSlug, redeemedAt: ISO } satisfies RedeemCouponResponse`.

**openapi.ts:** four new paths (`/v1/rewards`, `/v1/rewards/{slug}/claim`, `/v1/coupons/validate`, `/v1/coupons/redeem`) with request/response schemas, 403 documented on the coupon pair, 409 with the four new codes on claim/redeem; path-count assertion moves 11 → 15.

Tests: catalog shape incl. `remaining` math and null-inventory passthrough; **staticCode absent from every catalog entry (explicit assertion)**; disabled/out-of-window filtered from catalog; claim happy path (fake returns ok) mapping; each 409 reason mapped with its code; userId bounds; unknown slug 404; sk guard 403s on validate+redeem for pk; validate all five outcomes (valid, not_found, already_redeemed, expired via past endsAt, expired via missing-from-config); redeem outcomes incl. race-shaped `already_redeemed` from the fake; erase response now carries `coupons` count (fake erasure store updated). Workspace typecheck fully green again after this task. Commit: `feat(api): rewards catalog and claim; coupon validate and redeem`

---

### Task 7: sdk — rewards + coupon methods

**Files:** Modify `packages/sdk/src/index.ts`; test `packages/sdk/test/sdk.test.ts`.

**Interfaces — produces:**
```ts
async listRewards(): Promise<Reward[]>
// GET /v1/rewards; parse rewardsResponseSchema; returns .rewards; no user required (catalog is user-agnostic)
async claimReward(slug: string): Promise<ClaimRewardResponse>
// requires identified user (established guard/message); POST /v1/rewards/:slug/claim body { userId: this.userId };
// parse claimRewardResponseSchema; claim failures surface as PromoceanApiError with code
// 'insufficient_points' | 'claim_limit_reached' | 'reward_unavailable' (status 409) — integrators branch on .code
async validateCoupon(code: string): Promise<ValidateCouponResponse>
// requires secretKey option (getStats posture + message); POST /v1/coupons/validate, useSecretKey: true
async redeemCoupon(code: string): Promise<RedeemCouponResponse>
// same sk posture; POST /v1/coupons/redeem
```
Note: the spec sketch showed `claimReward(slug, { userId })`; the SDK's house pattern is the identified user (`identify()` + guard) everywhere a user acts — claimReward follows the house pattern (flagged for reviewers).

Tests: listRewards hits the path and parses; claimReward requires identify (throws the established message), sends `{ userId }` body, propagates a 409 `insufficient_points` envelope as `PromoceanApiError` with `.code === 'insufficient_points'` and `.status === 409` (assert instanceof — the issue-#5 lesson); validate/redeem throw without secretKey, send the sk bearer when configured. Commit: `feat(sdk): reward catalog, claim, and coupon validate/redeem`

---

### Task 8: widgets — RewardsStore component

**Files:** Create `packages/widgets/src/rewards-store.tsx`; modify `src/index.ts` (export); tests `packages/widgets/test/widgets.test.tsx`.

**Behavior:** `<RewardsStore title?: string />` — requires an identified user (`client.currentUserId`); renders nothing when unidentified. On mount (cancelled-guarded effect, the established Placement/Leaderboard pattern, StrictMode-safe): fetch `listRewards()` + `getWallet()` in parallel; render balance header + a row per reward (name, description, `pointsPrice` or "Free", remaining when capped). Per-row claim button → `claimReward(slug)`; while pending, button disabled; on success show the returned code inline in that row (a `<code>` element, plus a copy button using `navigator.clipboard` in a try/catch) and refetch wallet + rewards; on `PromoceanApiError` render the failure inline per row mapped from `.code` (insufficient points / limit reached / unavailable) — no silent catch (Sprint 7 refreshEngagement lesson). Derived disabled states before clicking: `pointsPrice > balance` → disabled "Not enough points"; `remaining === 0` → "Sold out". `data-promocean-rewards` attribute on the root; inline styles consistent with existing widgets.

Tests: renders rows + balance from fake client; unidentified → renders nothing; claim success shows code and refetches (fake call counts); claim failure renders the mapped message (fake throws PromoceanApiError('insufficient_points', ..., 409)); insufficient-balance and sold-out rows disabled; unmount-before-resolve safe. Commit: `feat(widgets): rewards store component`

---

### Task 9: demo, e2e, docs — sprint DoD

**Files:** Modify `apps/demo/app/promocean.tsx` (add `<RewardsStore />` near the engagement readouts), `apps/demo/app/stats/page.tsx` + a small server-action module (coupon check form: input + Validate/Redeem buttons calling `validateCoupon`/`redeemCoupon` via the sk SDK client, rendering the JSON result — server-side only, established `PROMOCEAN_SECRET_KEY` posture); create `apps/demo/e2e/rewards-loop.spec.ts`; docs: root README (rewards endpoints in the API table + a "Rewards & coupons" section: claim/validate/redeem flow, static-code oldest-first semantics, expiry-at-redemption, the staticCode-hidden rule), `packages/sdk/README.md` (four methods, sk posture), `packages/widgets/README.md` (RewardsStore usage); changeset entries per house style.

**e2e (`rewards-loop.spec.ts`):** seed math uses `pointRules { lesson_completed: 10, profile_completed: 25 }` and the 100-point `demo_discount` reward: identify fresh user → claim `welcome_coupon` free → code `WELCOME10` visible, wallet unchanged → attempt `demo_discount` with insufficient points → inline "not enough points" state → track `lesson_completed` ×10 (100 points) → claim succeeds, code matches `/^DEMO-[A-HJ-NP-Z2-9]{10}$/`, balance drops to 0 → via Playwright `request` with the sk key (or the stats-page form): validate → valid, redeem → redeemed, redeem again → 409 `already_redeemed` → erasure check: `DELETE /v1/users/:id` counts include `coupons ≥ 2`.

**DoD steps (in order):** `pnpm turbo run typecheck build test` fully green; boot the compose stack (`docker compose --profile stack build && up -d --wait`) and run `pnpm --filter demo e2e` — ALL specs green including rewards-loop; hand-curl the sk pair against the live stack (validate a real claimed code, redeem it, re-redeem → 409); stop the stack; push branch; confirm the GitHub Actions compose e2e goes green (poll the public checks API as established). Commit: `feat(demo): rewards store and coupon checkout demo; docs — sprint 8 wrap`

PR notes must state: four new endpoints (two sk-only); four new error codes (all 409); `EraseUserResponse.counts` gains `coupons` (additive); **wallet `recent[].source` gains `'redemption'` — older SDK/contracts versions will fail zod-parsing a wallet containing a redemption entry (semver-minor contracts/sdk bump; consumers must upgrade before spending exists in their project)**; staticCode privacy rule; delivers the "coupon/promo-code generation and validation" v1.x roadmap slice and closes the earn/burn loop.

---

## Self-Review Notes

- **Spec coverage:** §3.1 config plane ✓ (T4 cms, T5 adapter, T2 port); §3.2 coupons table + counts-derive-from-rows + erasure ✓ (T3, erase wire shape T1/T6); §3.3 claim transaction ✓ (T2 decideClaim/codeFromBytes, T3 locks+retry+debit) — **plan adds a per-user advisory lock the spec's §3.3 didn't call out**: the spec's per-reward lock alone cannot stop one user overspending across two different priced rewards concurrently (both pass the balance read); lock order reward→user is fixed and documented, deadlock-free. §3.4 validate/redeem ✓ (T3 store semantics incl. SKIP LOCKED, T6 routes; validate-200 vs redeem-envelope split preserved); §3.5 API surface ✓ (T6 + openapi 15 paths; staticCode-absent asserted); §3.6 SDK/widget/demo ✓ (T7/T8/T9); §4 flows = T9 e2e; §5 error handling distributed (fail-closed config T6, per-code widget states T8); §6 testing mapped 1:1 (both named races in T3); §7 DoD = T9.
- **Spec deviations (flagged, both reviewer-visible):** (1) per-user advisory lock added — a correctness fix, not scope creep; (2) claim response carries `rewardSlug` not `rewardId` (claims are slug-addressed; ids are config-plane internals), and `claimReward(slug)` uses the identified user instead of the spec sketch's `{ userId }` param (SDK house pattern). (3) No `environment` field on the reward content type — the spec's field list said "following the offers/timed-events pattern", and that pattern has no environment field on config types; runtime rows are env-scoped via auth.
- **Known-break chain:** T1 (erase counts contract) + T2 (getRewards, RewardStore, erase/wallet port widening) → adapter-db green at T3, adapter-strapi at T5, api at T6 — same three-task shape as Sprints 5–7; recorded.
- **Type consistency:** `RewardDefinition` field set identical T2 (type) / T4 (cms response) / T5 (schema+map); `ClaimRejection` values = the three claim 409 codes T1/T2/T3/T6/T7; `RewardStore` method names/signatures identical T2 (port) / T3 (impl) / T6 (routes+fakes); `couponCodeFromBytes(bytes, prefix)` consistent T2/T3; validate reason enum `not_found|already_redeemed|expired` consistent T1/T6; `coupons` erase-count key consistent T1/T2/T3/T6/T9.
- **Deliberate choices encoded:** rejection paths return through a committed-but-empty transaction (no writes ⇒ nothing to roll back — cheaper than aborting); redeem's zero-row diagnosis is a follow-up read outside the atomic UPDATE (diagnosis can be stale only in the direction of reporting `already_redeemed`, which is the safe direction); catalog `remaining` clamps at 0 for the inventory-lowered-below-claims case; disabled rewards are 409 (exists, unavailable) while unknown slugs are 404.
- **Compression note:** as with Sprints 2–7, test code specified behaviorally; production interfaces, lock keys, alphabet, bounds, and validation order are exact.
