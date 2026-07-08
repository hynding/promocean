# Promocean

Achievements, offers, and live promotional events for any website or app — one API.

Monorepo: pnpm + Turborepo. See `docs/superpowers/specs/` for the design spec.

### Timed events

Timed events apply an achievement-progress multiplier while an event is live
or ending soon. When multiple events are live at once, the **highest**
multiplier wins — multipliers don't stack. Progress is always **clamped at
the achievement target**, so a ×2 event takes 9/10 to 10/10, not 11. Event
windows (`startsAt`/`endsAt`) are absolute UTC instants, not durations.

## Quickstart (dev)

    corepack enable && pnpm install
    pnpm build
    cp .env.example .env
    pnpm db:up
    pnpm dev

The `dev` task starts every app in parallel via Turborepo, but `cms` and `api`
each need their own environment configured first — see below for a from-scratch
setup that boots the full stack (cms + api + demo) and proves the achievement
loop end to end.

Note: `.env.example` sets `SEED_DEMO=true`, which seeds a publicly known demo
publishable key (`pk_test_demo_…`) — fine for local dev and CI, but this must
never be enabled in a staging or production environment.

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
countdown and progress multiplier. With cms + api already running (per
above):

    pnpm --filter demo exec playwright install chromium
    pnpm --filter demo e2e

This is also run in CI as the `e2e` job in `.github/workflows/ci.yml`, which
boots Postgres, cms, and api with throwaway secrets before running the spec.

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
| GET | `/v1/stats` | sk only | Aggregate stats for the project: event/unlock/impression/click totals, per-achievement unlocks, per-offer CTR, per-timed-event participant counts. Optional `?from=&to=` ISO datetime range. Rejected with `403 forbidden` for publishable keys. |
| GET | `/v1/openapi.json` | none | Serve the OpenAPI document, generated from the same zod contracts the routes validate against. |

Every key is rate-limited independently at `RATE_LIMIT_PER_MINUTE` requests
per minute (default `300`; single-instance in-memory bucket, keyed by a hash
of the key), returning `429 rate_limited` with a `retry-after` header once
exceeded. Publishable keys additionally enforce an `allowedOrigins`
allowlist when one is configured on the key: requests carrying an `Origin`
header not on that list are rejected with `403 origin_not_allowed` (secret
keys, and requests with no `Origin` header, are exempt from this check).

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
`WEBHOOK_DEAD_LETTER_TTL_DAYS` (default 30). A disabled event that was
never observed live emits no `ended` message — disabling before an event
ever went live means no lifecycle transition ever fired for it.

The dispatcher `POST`s directly to whatever URL a project configures as a
webhook endpoint. There is currently no SSRF protection (e.g. blocking
private/internal IP ranges) — treat endpoint URLs as trusted input for now.
Blocking requests to private IP ranges is required before this becomes a
multi-tenant, self-service feature and is tracked as future work.

Scheduler tuning (all optional, read once at process start):

| Env var | Default | Purpose |
| --- | --- | --- |
| `WEBHOOK_REDELIVERY_GRACE_MINUTES` | `5` | How long a claimed-but-undelivered transition sits before the redelivery sweep re-drives it. |
| `TIMED_EVENT_SCAN_GRACE_MINUTES` | `60` | How far back the config-plane scan window looks for timed events. Must exceed the redelivery grace (a shorter scan window would let events drop out of the feed before a stale claim could ever be redriven) — if misconfigured, the scheduler logs a warning at startup and clamps it to `WEBHOOK_REDELIVERY_GRACE_MINUTES + 5`. |
| `WEBHOOK_DEAD_LETTER_TTL_DAYS` | `30` | Dead letters older than this are purged by the retention sweep. |

## Publishing

MIT packages (`@promocean/contracts`, `@promocean/sdk`, `@promocean/widgets`) publish via a two-step manual flow:

1. **Describe the change**: Run `pnpm changeset` to create a `.changeset/*.md` file (describes the change type and affected packages). Commit this file with your PR.

2. **Bump versions**: Before releasing, run `pnpm changeset version` to consume pending changesets, bump `package.json` versions, and update changelogs. Commit and merge this version bump.

3. **Publish to npm**: Trigger the **Release** workflow from GitHub Actions (Actions → Release → Run workflow). The workflow builds packages and runs `changeset publish`, publishing any versions not yet on npm. Requires the `NPM_TOKEN` repo secret.
