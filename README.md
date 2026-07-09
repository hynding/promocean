# Promocean

Achievements, offers, and live promotional events for any website or app — one API.

Monorepo: pnpm + Turborepo. See `docs/superpowers/specs/` for the design spec.

### Timed events

Timed events apply an achievement-progress multiplier while an event is live
or ending soon. When multiple events are live at once, the **highest**
multiplier wins — multipliers don't stack. Progress is always **clamped at
the achievement target**, so a ×2 event takes 9/10 to 10/10, not 11. Event
windows (`startsAt`/`endsAt`) are absolute UTC instants, not durations.

## Quickstart

The fastest way to see the whole thing working — clone, then one command:

    git clone https://github.com/hynding/promocean.git
    cd promocean
    cp .env.example .env
    docker compose --profile stack up

This builds and boots Postgres, the Strapi CMS, the API, and the demo app
(each gated behind healthchecks, so services come up in the right order), and
seeds a demo project with test API keys. Once it's up:

- `http://localhost:3002/?user=manual-1` — the demo app; click **Complete a
  lesson** to see an achievement unlock live, then use the **Rewards store**
  section to claim the free `WELCOME10` coupon or (once you've earned 100+
  points) the generated-code `Demo Discount` reward.
- `http://localhost:3002/stats` — server-rendered aggregate stats for
  everything you just did, plus a coupon-check form (validate/redeem a
  claimed code with the secret key, server-side).
- `http://localhost:1337/admin` — the Strapi CMS admin (log in with the
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` from your `.env`).
- `http://localhost:3001/v1/openapi.json` — the API's OpenAPI document.

Tear it down with `docker compose --profile stack down` (add `-v` to also
drop the Postgres volume).

Note: `.env.example` sets `SEED_DEMO=true`, which seeds a publicly known demo
publishable key (`pk_test_demo_…`) — fine for local dev and CI, but this must
never be enabled in a staging or production environment.

## Quickstart (dev, no Docker for the apps)

Postgres still runs in a container (profile-less, so it starts on its own);
`cms`, `api`, and `demo` run on the host via Turborepo instead of as compose
services — useful for iterating on app code without rebuilding images:

    corepack enable && pnpm install
    pnpm build
    cp .env.example .env
    pnpm db:up
    pnpm dev

The `dev` task starts every app in parallel via Turborepo, but `cms` and `api`
each need their own environment configured first — see below for a from-scratch
setup that boots the full stack (cms + api + demo) and proves the achievement
loop end to end.

### Running the full stack manually

From the repo root, first run `pnpm install` then `pnpm build` (workspace packages
must be built once so `cms`/`api`/`demo` can resolve each other's `dist/`). Then, in
three terminals:

    # 1. Postgres + Strapi CMS (reads apps/cms/.env — see apps/cms/.env.example)
    pnpm db:up
    pnpm --filter cms dev

    # 2. Runtime API (reads process.env directly — no .env file; pass inline)
    DATABASE_URL=postgres://promocean:promocean@localhost:5433/promocean \
    CONFIG_PLANE_SECRET=dev-config-secret \
    STRAPI_URL=http://localhost:1337 \
    API_PORT=3001 \
    pnpm --filter api dev

    # 3. Demo app (reads apps/demo/.env.local — copy apps/demo/.env.example)
    cp apps/demo/.env.example apps/demo/.env.local
    pnpm --filter demo dev

Note: Postgres is published on host port **5433** (`docker-compose.yml` maps
`5433:5432`), not the default 5432.

Open `http://localhost:3002/?user=manual-1` and click **Complete a lesson** —
you should see a "🏆 Achievement unlocked — First Lesson" toast and the badge
cabinet showing First Lesson 1/1 unlocked, Getting Started 1/10 in progress.

Then open `http://localhost:3002/stats` — a server-rendered page (reads the
server-only `PROMOCEAN_SECRET_KEY` from `apps/demo/.env.local`, never exposed
to the browser) showing live totals and per-achievement/offer/timed-event
breakdowns for everything you just did.

### End-to-end tests

The Playwright specs in `apps/demo/e2e/` drive the demo app in a real browser:
`achievement-loop.spec.ts` proves the track → unlock → badge-cabinet loop and
that the resulting event/unlock counts show up live on `/stats`;
`offer-loop.spec.ts` proves an offer renders, fires exactly one impression
beacon, dismisses, and — after a reload — neither re-renders nor fires
another impression beacon; `timed-event-loop.spec.ts` proves the live-event
countdown and progress multiplier; `engagement-loop.spec.ts` proves the
wallet/streak readouts and leaderboard row; `rewards-loop.spec.ts` proves
the full earn/burn loop — claiming a free static-code reward, being blocked
on a priced reward by insufficient points, earning enough to claim it
(generated code, balance debited), the `/stats` page's coupon
validate/redeem/re-redeem-409 flow, and that erasure counts the claimed
coupons. With cms + api already running (per above):

    pnpm --filter demo exec playwright install chromium
    pnpm --filter demo e2e

This is also run in CI as the `e2e` job in `.github/workflows/ci.yml`, which
builds the images and runs `docker compose --profile stack up -d --wait`
(the same one-command flow above) before running the spec against it.

## API surface

All `/v1/*` routes require `Authorization: Bearer <key>` (a publishable
`pk_...` or secret `sk_...` key from the CMS). `GET /v1/openapi.json` is the
one unauthenticated route — it's registered before the auth/rate-limit
middleware so tooling can fetch the spec without a key.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/events` | pk or sk | Track a user event; evaluates achievement progress/unlocks and applies any active timed-event multiplier. |
| GET | `/v1/users/:userId/achievements` | pk or sk | Fetch a user's full achievement status (locked and unlocked). |
| DELETE | `/v1/users/:userId` | sk only | Erase a user's stored data (GDPR-style right-to-erasure). Rejected with `403 forbidden` for publishable keys. |
| GET | `/v1/placements/:slug/offer` | pk or sk | Fetch the active offer creative for a placement slug (or `null`). Does **not** record an impression — see below. |
| POST | `/v1/offers/:id/impression` | pk or sk | Record an impression beacon for an offer (idempotent per `impressionId`). The `<Placement/>` widget fires this itself, once, only for offers that actually render (a dismissed offer never fires it). |
| POST | `/v1/offers/:id/click` | pk or sk | Record a click on an offer's CTA. |
| GET | `/v1/events/live` | pk or sk | List scheduled/live/ending-soon timed events and their multipliers. |
| GET | `/v1/users/:userId/wallet` | pk or sk | Fetch a user's points wallet: running balance plus a short recent ledger of event-rule and achievement-unlock-bonus awards. |
| GET | `/v1/users/:userId/streak` | pk or sk | Fetch a user's current/longest daily activity streak and last active (client-local) day. |
| GET | `/v1/leaderboard` | pk or sk | Rank users in a project by total points. Optional `?window=all\|7d\|30d` (default `all`) and `?limit=` (default 10, max 100). See the privacy note below. |
| GET | `/v1/rewards` | pk or sk | List enabled, in-window rewards available to claim (name, description, points price, claim window, per-user limit, remaining inventory). Never includes a static reward's `staticCode` — see the privacy note below. |
| POST | `/v1/rewards/:slug/claim` | pk or sk | Claim a reward for a user, returning its coupon code. Rejected with `404 not_found` for an unknown slug, or `409` `reward_unavailable` / `claim_limit_reached` / `insufficient_points` when the reward, per-user limit, or points balance rules aren't met. |
| POST | `/v1/coupons/validate` | sk only | Look up a coupon code without redeeming it: `{ valid, rewardSlug?, status?, reason? }`. Rejected with `403 forbidden` for publishable keys. |
| POST | `/v1/coupons/redeem` | sk only | Redeem a coupon code (one-time). Rejected with `409 already_redeemed` on a second redemption, `409 reward_unavailable` if the reward has since expired, or `404 not_found` for an unknown code. Rejected with `403 forbidden` for publishable keys. |
| GET | `/v1/stats` | sk only | Aggregate stats for the project: event/unlock/impression/click totals, per-achievement unlocks, per-offer CTR, per-timed-event participant counts. Optional `?from=&to=` ISO datetime range. Rejected with `403 forbidden` for publishable keys. |
| GET | `/v1/openapi.json` | none | Serve the OpenAPI document, generated from the same zod contracts the routes validate against. |
| GET | `/docs` | none | Serve an HTML API reference (Redoc) rendered from the same OpenAPI document. |

Every key is rate-limited independently at `RATE_LIMIT_PER_MINUTE` requests
per minute (default `300`; single-instance in-memory bucket, keyed by a hash
of the key), returning `429 rate_limited` with a `retry-after` header once
exceeded. The number of distinct buckets tracked is bounded by
`RATE_LIMIT_MAX_BUCKETS` (default `10000`); once at the cap, keys not yet seen
in the current window share a single overflow bucket (still counted and
429-able) rather than growing memory unboundedly. Publishable keys additionally enforce an `allowedOrigins`
allowlist when one is configured on the key: requests carrying an `Origin`
header not on that list are rejected with `403 origin_not_allowed` (secret
keys, and requests with no `Origin` header, are exempt from this check).

### Data retention

`DELETE /v1/users/:userId` erases a user's events, progress, unlocks,
offer_events, points_ledger, streaks, and coupons (claimed and redeemed
alike) rows in one transaction, but **MAU (monthly active user) counter
rows are retained** — they exist for usage-based billing history and
contain only the project/environment/month and the external user id, no
event content.

**Log retention:** every request is logged (`apps/api/src/app.ts`'s request
middleware) with the request path, which for user-scoped routes (e.g. `GET
/v1/users/:userId/achievements`, `DELETE /v1/users/:userId`) includes the
caller-supplied external `userId` verbatim. Erasure does **not** reach back
into already-emitted logs — it only deletes database rows. If you ship
these logs to persistent storage (stdout capture, a log aggregator, etc.),
applying your own rotation/retention policy — and redacting or expiring user
identifiers out of it in line with your data-retention obligations — is the
operator's responsibility, not something this API does for you.

### Registered event types

Enforcement is opt-in per project: set a project's `registeredEventTypes`
(an array of event type strings) in the CMS to turn it on. Once set,
`POST /v1/events` rejects any `type` not in that list with `400
unregistered_event_type` and a `details.suggestion` field (the closest
registered type, if one is within a small edit distance — useful for
catching typos like `lesson_completd`). Leave `registeredEventTypes` empty
or unset and any event type is accepted, no enforcement — this is the
default for projects that haven't opted in. The seeded demo project
registers `lesson_completed` and `profile_completed`.

### Points, streaks, leaderboards

A project's `pointRules` config (CMS config-plane, `{ eventType: points }`)
awards points for a tracked event, and an achievement's own `pointsValue`
awards a bonus the moment that achievement unlocks — both are applied
inside the same transaction as the event's ingestion, so `GET
/v1/users/:userId/wallet` (running balance plus a short recent ledger,
event awards and unlock bonuses labeled separately) never reflects a
partially-applied event. `GET /v1/users/:userId/streak` reports the user's
current/longest consecutive-day streak, advanced once per distinct
client-local calendar day (see the tz-offset fallback below) — multiple
events on the same local day don't double-count. `GET /v1/leaderboard`
ranks all users in a project by total points, optionally windowed and
limited (see the table above). Timed-event multipliers apply to achievement
progress only; point awards are never multiplied.

**Leaderboard privacy note:** these three endpoints are pk-accessible by
design, and the leaderboard response exposes every ranked user's external
`userId` (whatever id your app passes to `track()`/`identify()`) directly to
anyone holding a publishable key. If your ids are anything identifying
(emails, real names, etc.), don't pass them as-is: use an opaque/pseudonymous
id with Promocean and map it to a display name in your own host app before
rendering a leaderboard, rather than relying on Promocean to know or store
any identity beyond the id you give it.

**tz-offset fallback:** the SDK's `track()` sets `tzOffsetMinutes`
automatically (minutes east of UTC, e.g. `+60` for UTC+1) from the browser's
local timezone. Server-side callers may omit it. When it's missing,
non-numeric, or otherwise invalid, the event's local day is computed as if
the offset were `0` — i.e. it falls back to the UTC calendar day rather than
failing the request. (A numeric offset outside the real-world range of
±840 minutes / UTC-14..UTC+14 is clamped to the nearest bound instead.)

### Rewards & coupons

A project's rewards are points-redeemable coupons configured in the CMS:
`GET /v1/rewards` lists what's currently claimable (enabled + inside its
optional `startsAt`/`endsAt` window), and `POST /v1/rewards/:slug/claim`
claims one for a user, debiting `pointsPrice` from their wallet (as a
`redemption`-sourced points-ledger entry — see the SDK's wallet note below)
in the same transaction the coupon row is written. A reward is either
**generated** (a fresh, unique code like `DEMO-7F3KQPZ2XN` minted per claim
from a 32-character, ambiguity-free alphabet — no `0`/`O`/`1`/`I`) or
**static** (every claim shares one configured code, e.g. `WELCOME10`).
Claim eligibility is enforced under a per-reward-then-per-user advisory lock
pair (deadlock-free, fixed order) so two concurrent claims can never
overspend a shared inventory cap or a user's points balance: unavailable
rewards (disabled, out of window, sold out) and limit/balance violations
both come back as `409` (`reward_unavailable`, `claim_limit_reached`,
`insufficient_points`); an unknown reward slug is `404 not_found`.

Once claimed, a code is checked and consumed with the **secret-key-only**
`POST /v1/coupons/validate` (read-only — reports whether a code is
`claimed` or already `redeemed`, or `reason: 'not_found' | 'expired'` when
invalid) and `POST /v1/coupons/redeem` (one-time; a second redeem attempt
on the same code is rejected with `409 already_redeemed`). Both endpoints
require a secret key precisely because they let the caller enumerate
whether/how an arbitrary code resolves — a browser-exposed publishable key
must never be able to do that.

**Static-code oldest-first semantics:** every claim of a static reward
inserts its own coupon row sharing the same code string, so many users can
each hold "their" claim of e.g. `WELCOME10` at once. Redemption doesn't
care which claim a caller "means" — it locks and redeems whichever
still-claimed row for that code was claimed longest ago (oldest-first,
`FOR UPDATE SKIP LOCKED` so concurrent redeemers never block on or double-redeem
the same row), so a shared code's redemption count simply tracks through
its outstanding claims in claim order.

**Expiry is evaluated at redemption, not at claim time:** a reward's
`endsAt` only gates *claiming* a new coupon — a code claimed while the
reward was still live remains a valid, redeemable coupon even after
`endsAt` passes, **except** validate/redeem re-check the reward's live
window at request time and reject with `reward_unavailable` (redeem) /
`reason: 'expired'` (validate) if it's since ended. In other words: earning
a coupon locks in eligibility to redeem it later, but "later" still has to
be before the reward itself expires.

**staticCode is never exposed via the catalog:** `GET /v1/rewards`'
response schema has no `staticCode` field at all (not merely omitted when
empty) — even for a static reward, the only way to learn its code is to
actually claim it (or, for callers with a secret key, resolve an already-known
code via validate/redeem). This is deliberate: the catalog is safe to expose
to a publishable key/browser context without leaking a shared promo code to
anyone who hasn't earned it.

## Webhooks

The api dispatches signed `POST` webhooks for `timed_event.live` /
`timed_event.ending_soon` / `timed_event.ended` (fired by a 30s lifecycle
scheduler as events cross those thresholds) and `achievement.unlocked`
(fired inline from `POST /v1/events` when a track call unlocks an
achievement). Every message carries a `messageId` (a uuid) — **consumers
must dedup by `messageId`, not by event/transition**: a redelivery of a
timed-event transition is sent as a brand-new message with a fresh
`messageId`, not a retry of the original one. Also verify the
`x-promocean-signature` HMAC header and check the signed `createdAt`
against a replay window (e.g. reject anything older than a few minutes) —
both belong in your consumer regardless of transport.

Timed-event delivery is claim-then-mark: the scheduler claims a transition
once, delivers it to every enabled endpoint (each endpoint independently
retries transient failures and is dead-lettered on permanent failure), then
marks the claim delivered. If the process crashes between delivering and
marking, the claim is left stale and a later tick's **redelivery sweep**
re-drives it (incrementing an attempt counter, capped at 5 attempts) with a
freshly built message and a new `messageId`, as above. A **retention
sweep** on the same tick purges dead letters older than
`WEBHOOK_DEAD_LETTER_TTL_DAYS` (default 30). Once redelivery attempts hit
the cap of 5, an **exhaustion sweep** on the same tick dead-letters the
claim (`<exhausted>`) and marks it delivered so it stops being retried.
Disabling an event stops its lifecycle transitions
from firing at whatever point the disable happens: an event disabled
before ever going live emits no messages at all, and one disabled after
going live emits no `ended` message either — its state simply snaps back
to draft.

The dispatcher `POST`s directly to whatever URL a project configures as a
webhook endpoint. There is currently no SSRF protection (e.g. blocking
private/internal IP ranges) — treat endpoint URLs as trusted input for now.
Blocking requests to private IP ranges is required before this becomes a
multi-tenant, self-service feature and is tracked as future work.

Scheduler tuning (all optional, read once at process start):

| Env var | Default | Purpose |
| --- | --- | --- |
| `WEBHOOK_REDELIVERY_GRACE_MINUTES` | `5` | How long a claimed-but-undelivered transition sits before the redelivery sweep re-drives it. |
| `TIMED_EVENT_SCAN_GRACE_MINUTES` | `60` | How far back the config-plane scan window looks for timed events. Must exceed the redelivery grace (a shorter scan window would let events drop out of the feed before a stale claim could ever be redriven) — if misconfigured, the scheduler logs a warning at startup and clamps it to `WEBHOOK_REDELIVERY_GRACE_MINUTES + 5`. If the api is down longer than this grace, transitions that occurred during the outage are dropped permanently — no claim is ever made and no dead letter is recorded — so size it to your expected downtime. |
| `WEBHOOK_DEAD_LETTER_TTL_DAYS` | `30` | Dead letters older than this are purged by the retention sweep. |

## Publishing

MIT packages (`@promocean/contracts`, `@promocean/sdk`, `@promocean/widgets`) publish via a two-step manual flow:

1. **Describe the change**: Run `pnpm changeset` to create a `.changeset/*.md` file (describes the change type and affected packages). Commit this file with your PR.

2. **Bump versions**: Before releasing, run `pnpm changeset version` to consume pending changesets, bump `package.json` versions, and update changelogs. Commit and merge this version bump.

3. **Publish to npm**: Trigger the **Release** workflow from GitHub Actions (Actions → Release → Run workflow). The workflow runs the package test suite, builds packages, and runs `changeset publish` (which also tags each published version — the workflow pushes those tags to origin afterwards), publishing any versions not yet on npm. Requires the `NPM_TOKEN` repo secret.

### Changeset authoring

When you run `pnpm changeset`, only select the packages your change actually
touched (or whose public behavior it affects transitively). `changeset`
defaults to listing every package it's asked about, so it's easy to
over-select — e.g. tick `@promocean/sdk` for a change that only touched
`@promocean/widgets`. An over-broad changeset produces a changelog entry
("version bump") on a package with nothing to say why, which is confusing
for consumers reading release notes. If a package's version is only bumping
because `updateInternalDependencies: "patch"` cascaded a workspace
dependency bump (see `.changeset/config.json`), that's expected and separate
from this — the authoring step is about which packages *you* list, not
about the automatic dependency-bump cascade.
