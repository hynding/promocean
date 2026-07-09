# Sprint 8 Design: Rewards & Coupons

Approved via brainstorming session 2026-07-09. Closes the earn/burn loop opened by
Sprint 7: the points wallet gains something to spend on. Marketers define rewards in
Strapi; users claim coupon codes (optionally debiting points); the customer's
checkout validates and redeems codes through secret-key endpoints.

Roadmap lineage: "Coupon/promo-code generation and validation" (v1.x, design doc
§7), plus the burn side of "points/XP wallet". The points-wallet-powered offerwall
(v3) is the long-range lane this unlocks.

## 1. Scope

In scope:

- `reward` content type in the Strapi config plane (generated or static codes,
  optional points price, expiry window, per-user limit, inventory cap)
- Runtime `coupons` table (migration 0007) — one row per claim; doubles as the
  claim record
- API: `GET /v1/rewards`, `POST /v1/rewards/:slug/claim` (pk);
  `POST /v1/coupons/validate`, `POST /v1/coupons/redeem` (sk-only)
- Atomic claim: constraint checks + wallet debit + code issuance in one transaction
- SDK methods (`listRewards`, `claimReward`, `validateCoupon`, `redeemCoupon`)
- `RewardsStore` widget; demo earn→claim→redeem flow; OpenAPI + README + seed
- GDPR erasure extended to coupon rows

Out of scope (explicitly): points refund on unredeemed expiry (future issue — a
product decision), uploaded code pools (CSV import), server-side frequency capping,
backlog issues #5/#15/#18, remaining v1.x items (retroactive grants, recurrence,
config-as-code, RN SDK).

## 2. Decisions and rationale

| Decision | Choice |
|---|---|
| Theme | Rewards & coupons — next v1.x item, builds directly on Sprint 7's wallet |
| Points linkage | Optional `pointsPrice` per reward; 0 = free promo-code campaign, >0 debits wallet on claim |
| Code source | `generated` (unique per claim, optional prefix) or `static` (one shared code) — uploaded pools deferred |
| Lifecycle | Full claim→validate→redeem; single-use enforcement is the product value |
| Constraints | Expiry window + per-user claim limit (default 1) + inventory cap — all three |
| Architecture | First-class content type (mirrors achievements/offers/timed-events), NOT an offer extension — display items and economy items have different semantics |
| Claim record | The coupon row IS the claim record — counts derive from `COUNT(*)`, no second table to drift |
| Serialization | `pg_advisory_xact_lock` per (project, environment, reward) — `FOR UPDATE` cannot lock the absence of a row, which is what claim-count races are |
| Frontend | `RewardsStore` widget (per-sprint widget pattern); MyCoupons list deferred |

## 3. Architecture

### 3.1 Config plane (Strapi `reward` content type)

Fields, following the offers/timed-events pattern (project relation, `environment`,
`enabled`, `slug`, `name`, `description`):

- `codeType`: enum `generated | static`
- `staticCode`: string, required iff `codeType = static`, forbidden otherwise
  (lifecycle validation hook, like timed-events transition checks)
- `codePrefix`: optional string for generated codes (e.g. `SUMMER-`)
- `pointsPrice`: integer ≥ 0 (0 = free)
- `startsAt` / `endsAt`: nullable datetimes; `endsAt > startsAt` enforced
- `perUserLimit`: integer ≥ 1, default 1
- `inventory`: nullable integer ≥ 1 (null = uncapped)

adapter-strapi gains `getRewards(scope)` mirroring `getOffers`: TTL cache,
stale-on-error fallback, and Zod validation of the CMS response (issue-#4 lesson —
no cast-trusting).

Seed adds two demo rewards: a free static reward (`WELCOME10`) and a points-priced
generated reward (100 points, prefix `DEMO-`), exercising both paths against
Sprint 7's seeded point values (50/100/75).

### 3.2 Coupons table (migration 0007)

```
coupons: id (uuid pk), project_id, environment, reward_id, user_id,
         code, status ('claimed' | 'redeemed'), claimed_at, redeemed_at (nullable)
```

- Partial unique index on `(project_id, environment, code)` for generated codes
  (static claims share one code by design and are exempted; rows carry a
  `code_shared` boolean set from the reward's `codeType` at claim time so the
  partial index predicate is local to the table)
- Per-user limit = `COUNT(*) WHERE reward_id AND user_id`; inventory =
  `COUNT(*) WHERE reward_id` — both computed inside the claim transaction
- GDPR: `DELETE /v1/users/:userId` erasure extends to `coupons` rows (the
  Sprint 7 final-review lesson, applied proactively this time)

### 3.3 Claim transaction

1. Outside the transaction: load reward from the cached config plane; reject
   disabled / out-of-window with `reward_unavailable`.
2. `BEGIN`; `pg_advisory_xact_lock(hash(project_id, environment, reward_id))` —
   serializes claims per reward; auto-releases on commit/rollback; claims on
   different rewards never contend.
3. Inside the lock: inventory count (`reward_unavailable` if exhausted), per-user
   count (`claim_limit_reached`), and if `pointsPrice > 0` a wallet balance check
   (`SUM(points_ledger.delta)`, the Sprint 7 derived-balance model) rejecting with
   `insufficient_points`.
4. Insert ledger row (`delta: -pointsPrice, source: 'redemption',
   sourceRef: <coupon id>`) when priced, insert coupon row, `COMMIT`. Rollback on
   any failure — no debit-without-code, no code-without-debit.

Code generation: `crypto.randomBytes` → 10 chars, Crockford-style alphabet (no
`0/O/1/I`), optional prefix. Bounded retry (3 attempts) on unique-index collision;
exhausting retries is treated as an internal error (at 32^10 keyspace a collision
loop signals a bug, not bad luck).

The ledger `source` contract enum widens to `'event' | 'unlock' | 'redemption'`
(the DB column is already plain text — contracts-only change).

### 3.4 Validate and redeem (sk-only)

Both guard with the established `auth.keyType !== 'secret'` → 403 pattern
(stats.ts/users.ts precedent). Separate endpoints because checkouts check codes at
cart time but consume them at order completion — collapsing them forces redemption
on abandoned carts.

- **Validate** (`POST /v1/coupons/validate`, body `{ code }`): read-only SELECT
  joined to reward config. Response `{ valid, status?, rewardSlug?, reason? }`;
  reasons: `not_found`, `already_redeemed`, `expired` (reward `endsAt` passed —
  claimed codes die with the campaign; expiry is evaluated at
  validation/redemption time, not frozen at claim time). Note: validate always
  returns 200 with `valid: false` + `reason` (a response-field enum, not the
  error catalog) — a checkout probing a code is not an error condition. Redeem,
  which mutates, uses the error envelope (`already_redeemed`,
  `reward_unavailable`, `not_found`).
- **Redeem** (`POST /v1/coupons/redeem`, body `{ code }`): one conditional
  `UPDATE … SET status='redeemed', redeemed_at=now() WHERE scope AND code AND
  status='claimed' RETURNING …` — the conditional update IS the race guard; no
  lock. Zero rows → diagnose: `not_found` / `already_redeemed` /
  `reward_unavailable` (expired). Static codes: multiple claim rows share one
  code; redeem consumes the **oldest unredeemed** claim (`ORDER BY claimed_at
  LIMIT 1` via ctid/id subselect — deterministic, documented). Validate reports
  `valid` if any unredeemed claim exists.

### 3.5 API surface

| Endpoint | Key | Behavior |
|---|---|---|
| `GET /v1/rewards` | pk | Enabled, in-window rewards; includes `pointsPrice`, remaining inventory (null = uncapped); **never includes `staticCode`** — the code is only revealed by claiming, else the wallet debit is bypassable |
| `POST /v1/rewards/:slug/claim` | pk | Body `{ userId }` (1–128 chars, shared bound); returns `{ code, rewardId, claimedAt, pointsSpent }` |
| `POST /v1/coupons/validate` | sk | See 3.4 |
| `POST /v1/coupons/redeem` | sk | See 3.4 |

New error codes in the catalog: `reward_unavailable`, `claim_limit_reached`,
`insufficient_points`, `already_redeemed`. Claim inherits the existing per-key
rate limiter — no new mechanism. All four endpoints documented in OpenAPI with
the standard error envelope.

### 3.6 SDK, widget, demo

- **SDK:** `listRewards()`, `claimReward(slug, { userId })`, `validateCoupon(code)`,
  `redeemCoupon(code)`; sk methods documented server-side-only (getStats posture).
  Claim errors surface as typed `PromoceanApiError` so integrators can branch on
  `insufficient_points` vs `claim_limit_reached`.
- **Widget:** `<RewardsStore userId>` — reward list with prices and remaining
  inventory, wallet balance header (reuses Sprint 7 wallet read), claim button,
  issued code shown inline (copyable) on success. Disabled states: insufficient
  balance, limit reached, sold out, out of window. Follows leaderboard.tsx
  conventions (provider context, data-attribute hooks, unstyled).
- **Demo:** rewards section on the engagement page (earn points with existing
  event buttons → spend in the store); the sk-backed stats page gains a small
  validate/redeem form to demo the checkout side end-to-end.

## 4. Data flow

Earn→burn round trip: demo button → `POST /v1/events` → points ledger credit
(Sprint 7) → `RewardsStore` refetches wallet + rewards → user claims → claim
transaction debits ledger and inserts coupon → code rendered → user pastes code
into the demo checkout form → `validate` (sk) shows valid → `redeem` (sk) flips
status → second redeem returns `already_redeemed`.

Config flow: marketer edits reward in Strapi → TTL cache expiry (or stale-on-error
fallback) → API picks up new window/inventory/price on next fetch. Inventory
lowered below claimed count: no clawback — new claims blocked, existing coupons
unaffected.

## 5. Error handling

- Claim: `not_found` (unknown slug), `invalid_payload` (bad userId/body),
  `reward_unavailable` (disabled, out of window, inventory exhausted),
  `claim_limit_reached`, `insufficient_points`. Distinct codes because the widget
  renders different disabled/CTA states per cause.
- Validate/redeem: 403 on pk keys; `invalid_payload` on malformed code (length
  bounds mirror generation: 1–64); redeem failure diagnosis per 3.4.
- Config-plane failure during claim: stale-on-error cache serves last-good reward
  config (established behavior); a cold-cache hard failure returns the existing
  config-unavailable error path — claims fail closed, never against unknown config.
- Widget: claim failure renders an inline message mapped from the error code; no
  silent catch (Sprint 7 refreshEngagement lesson).

## 6. Testing

TDD per task, per house style:

- **contracts:** schema boundaries — `pointsPrice` 0/negative, `perUserLimit` 0/1,
  code length bounds, staticCode presence rules
- **core:** claim-decision unit tests (window/enabled/inventory/limit/balance
  matrix), code-generation alphabet and prefix properties
- **adapter-db (integration):** the claim transaction — happy paths (free static,
  priced generated); **N-way concurrent claim race at the inventory boundary**
  asserting exactly `inventory` coupons issued; **balance-boundary race** asserting
  the wallet never goes negative; ledger/coupon rollback atomicity; redeem race
  (parallel redeems of one code → exactly one success); oldest-first static-code
  redemption order; erasure removes coupons
- **api routes:** every error code, sk 403s on validate/redeem, userId bounds,
  staticCode never present in `GET /v1/rewards`
- **adapter-strapi:** getRewards cache + stale-on-error + response validation
- **sdk/widgets:** per established patterns, including error-code branching and
  disabled-state rendering
- **e2e (compose):** seed → earn → claim both reward types → validate → redeem →
  re-redeem fails; erasure sweep includes coupons

## 7. Definition of done

- Full turbo suite green; compose e2e green from a fresh seed
- Demo exercises earn → claim (both reward types) → validate → redeem live
- Hand-curl of sk validate/redeem against the running compose stack
- OpenAPI covers all four endpoints; README documents the rewards flow and the
  static-code redemption semantics; changeset entries per house style
- Erasure verified to cover coupons (no repeat of the Sprint 7 Critical)
