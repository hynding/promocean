# Promocean — MVP Design Spec

**Date:** 2026-07-06
**Status:** Approved design, pending implementation plan
**Author:** Steve Hynding + Claude

## 1. Product Vision

Promocean is the engagement layer for any website or app: achievements, first-party
offers, and live timed events from one API. It targets the market whitespace where
gamification APIs (Trophy, GameLayer), promotion engines (Talon.One, Voucherify), and
offer/ad SDKs each stop: **no vendor bundles all three, and no vendor treats "timed
event" as a first-class primitive** — double-points weekends and flash promos are
hand-assembled from campaign rules and cron jobs everywhere in the market today.

**Positioning statement:** developer-first integration (REST API, TypeScript SDK,
embeddable widgets) with a marketer-usable admin (Strapi CMS) from day one.

**Business model (design target, not built in MVP):** freemium + transparent MAU-based
usage tiers — free to ~1k MAU, ~$99/mo entry tier, billing on *active* users only.
**MAU is defined as: a distinct external user ID with ≥1 tracked event in the calendar
month.** We explicitly avoid two competitor-attacked patterns: charging for dormant
users (Talon.One) and gating API access to top tiers (Smile.io).

**Ads roadmap ordering:** first-party offers (MVP) → cross-promo network (later) →
third-party ad serving (last, only if demand justifies the compliance burden).

## 2. Decisions Locked

| Decision | Choice |
|---|---|
| Primary customer | Mixed: developers (API/SDK) + marketers (CMS admin) from day one |
| MVP scope | Thin slice of all three domains: achievements, first-party offers, timed events |
| "Advertisements" meaning | First-party offers first; cross-promo and third-party ads are roadmap tiers |
| Monetization | Freemium + MAU-based usage tiers; metering counters built in MVP, billing later |
| Client platforms v1 | Web-first: REST + TS SDK + framework-agnostic embeddable widgets |
| Team/pace | Solo + AI, side-project cadence; 2-week sprints |
| Frontend stack | Next.js + React |
| MVP success bar | Demo app in the monorepo proves the full loop end-to-end, configured via CMS |
| Architecture | Approach A: Strapi as config plane, custom runtime API, ports-and-adapters core |
| Licensing | Platform (`apps/`, adapters) GPL-3.0; `sdk`, `widgets`, `contracts` published MIT |

## 3. Architecture

### 3.1 Two planes

- **Config plane (Strapi v5):** marketers define achievements, offers, and timed events
  in Strapi's admin UI. Strapi stores *definitions* only. It is never exposed to end
  users or SDKs.
- **Runtime plane (custom):** a thin Hono-on-Node service (`apps/api`) owns the hot
  path — event ingestion, rule evaluation, offer serving, timed-event state. It is the
  only public API surface.

All domain logic lives in pure-TypeScript packages behind ports-and-adapters
interfaces. `core` defines ports (e.g. `ConfigStore`, `ProgressStore`); infrastructure
packages implement them. The domain cannot import Strapi — swappability is a
compile-time property, not a migration plan.

**The swap story:** `core` sees only
`interface ConfigStore { getAchievements(projectId); getOffers(...); getTimedEvents(...) }`
(~6 methods). Replacing Strapi = writing `adapter-custom` against that interface and
repointing the API's dependency injection. SDK, widgets, demo, and domain logic are
untouched. Config-as-code export (roadmap, §7) doubles as the data-migration story.

### 3.2 Monorepo layout (pnpm workspaces + Turborepo)

```
promocean/
├── apps/
│   ├── cms/            # Strapi v5 — definitions + admin UI (GPL-3.0)
│   ├── api/            # Runtime API — Hono on Node, only public surface (GPL-3.0)
│   └── demo/           # Next.js demo site — integrates everything; IS the MVP test (GPL-3.0)
├── packages/
│   ├── core/           # Pure TS domain: entities, rule evaluation, event lifecycle.
│   │                   #   Zero runtime deps. (GPL-3.0)
│   ├── contracts/      # Zod schemas for every request/response + webhook payload.
│   │                   #   Single source of truth; OpenAPI generated from these. (MIT)
│   ├── adapter-strapi/ # Implements ConfigStore against Strapi REST (GPL-3.0)
│   ├── adapter-db/     # Implements state ports against Postgres via Drizzle (GPL-3.0)
│   ├── sdk/            # @promocean/sdk — browser+server TS client (MIT)
│   ├── widgets/        # @promocean/widgets — React components (MIT)
│   └── config/         # Shared tsconfig/eslint presets (MIT)
```

Dependency rules: apps depend on packages, never the reverse; packages never depend on
apps; `core` and `contracts` depend on nothing internal.

**Licensing rationale:** GPL on code embedded in customers' sites is an adoption
blocker (legal-team veto). SDK/widgets/contracts ship MIT (Trophy's open UI-kit
pattern); the platform stays GPL for the open-core angle. Each package carries its own
LICENSE file; the root LICENSE remains GPL-3.0 with a LICENSING.md map at the root.

### 3.3 Storage

One Postgres instance, two schema ownerships:

- Strapi owns its tables (definitions: achievements, offers, timed events).
- The runtime owns its tables (events, user progress, unlocks, impressions/clicks,
  usage counters) via Drizzle in a separate Postgres schema.

Cleanly separable to two databases later. The runtime reads definitions through
`adapter-strapi` with a short in-memory TTL cache (definitions change rarely; events
arrive constantly). On config-plane failure the cache serves stale — Strapi down
degrades the admin experience only, never the runtime.

### 3.4 Multi-tenancy, environments, keys

- Every runtime table carries `projectId` **and** `environment` (`test` | `live`).
- Two key types (Stripe pattern): **publishable key** (`pk_test_…`/`pk_live_…` —
  browser-safe: track events, read own-user data) and **secret key** (`sk_…` — server,
  full API). Retrofitting key separation later is painful; it ships in MVP.
- Tenancy filtering is enforced once, at the adapter layer — not per-endpoint.
- Per-key rate limits.

## 4. Domain Model & Data Flow

### 4.1 Core entities

- **Project** — tenant; has API keys, environments, usage counters.
- **User** — external ID supplied by the customer. No PII stored beyond the ID.
- **Event** — `{ projectId, environment, userId, type, idempotencyKey, occurredAt, meta }`.
  Raw events are stored (append-only), enabling retroactive achievement evaluation later.
- **Achievement** — definition: name, description, tiered artwork, criterion. MVP
  criterion type: *event-count* ("event X occurs N times"). Progress tracked as x/N.
- **Offer** — creative (image/text/CTA), schedule window, placement targeting.
  MVP audience: everyone. `audience` is modeled as an extensible discriminated union
  (`{ kind: "everyone" }` in MVP) so segments slot in without schema breaks.
- **Placement** — named slot in the host app (`homepage-banner`); offers attach to
  placements.
- **TimedEvent** — first-class primitive: schedule window, lifecycle state machine,
  and *effects*. MVP effect types: (a) achievement-progress multiplier
  ("double progress weekend"), (b) offer attachment (offers live only during the event).

### 4.2 TimedEvent lifecycle

```
draft → scheduled → live → ending_soon → ended
```

- State is **computed on read** from `startsAt` / `endsAt` / `endingSoonThreshold` —
  no cron for correctness. A lightweight scheduler exists solely to fire lifecycle
  webhooks at transition times (with retries).
- `ending_soon` threshold is configurable per event (default: 24h before end); it
  exists to power FOMO/countdown mechanics and fires its own webhook.
- **Timezone rule (MVP):** `startsAt`/`endsAt` are absolute UTC instants. Per-user
  local-time windows (needed for streaks later) are deferred; the schema documents
  this so UTC instants don't ossify as the only model. A nullable `recurrence` field
  is reserved for recurring events (roadmap).

### 4.3 Write path (hot)

```
demo app ── sdk.track('lesson_completed') ──▶ POST /v1/events (apps/api)
  → contracts: validate payload (zod)
  → adapter-db: append event (idempotency-key dedup), bump usage counters
  → core: load cached definitions; evaluate rules — a pure function:
      (event, definitions, currentProgress, activeTimedEvents) → effects
  → apply effects: progress++ (× live multipliers) / unlock achievement / etc.
  → response includes any new unlocks → widgets render the unlock toast
  → signed webhook fired for unlocks (async, retried)
```

### 4.4 Read paths

- `GET /v1/users/:id/achievements` — unlocks + progress.
- `GET /v1/placements/:id/offer` — resolves the active offer for a placement
  (schedule + timed-event attachment aware). Impression recorded; click via
  `POST /v1/offers/:id/click`.
- `GET /v1/events/live` — active/upcoming timed events with server-computed
  countdown state.
- `DELETE /v1/users/:id` — GDPR erasure pass-through: deletes the user's events,
  progress, and unlocks.
- OpenAPI document is generated from `contracts` (zod-openapi) and served at
  `/v1/openapi.json`; API reference docs render from it.

### 4.5 SDK & widgets

- `@promocean/sdk`: `init({ publishableKey })`, `identify(userId)`, `track(type, meta?)`,
  `getAchievements()`, `getPlacementOffer(id)`, `getLiveEvents()`. Track calls batch
  and retry with backoff; client-generated idempotency keys make retries safe.
- `@promocean/widgets` (React): `<UnlockToast/>`, `<BadgeCabinet/>`,
  `<Placement id/>`, `<EventCountdown/>`.
- **Widget budget:** ~10 kB gz core ceiling, SSR-safe, accessible by default
  (focus management on toasts, alt text from CMS, reduced-motion respect). Widgets
  run on customers' sites — their performance is our reputation.

## 5. Error Handling & Resilience

- **Typed error envelope** `{ code, message, details }` from a fixed catalog in
  `contracts` (`invalid_api_key`, `unknown_event_type`, `rate_limited`, …). SDK maps
  codes to typed exceptions.
- **Widgets fail silent-to-empty:** an erroring placement renders nothing; widgets
  never break the host page.
- **Idempotent ingestion:** client idempotency keys; duplicate events are no-ops.
  This is also the future anti-cheat seam.
- **Stale-on-error config cache** (§3.3); webhook delivery has retries + a
  dead-letter table.
- **Webhooks signed** with HMAC (`X-Promocean-Signature`) — table stakes per market
  research.

## 6. Testing Strategy

- `core`: pure functions → exhaustive Vitest unit tests, no mocks. Achievement rules
  and the TimedEvent state machine live here, so the trickiest logic is the cheapest
  to test.
- `contracts`: schema round-trip tests; OpenAPI generation snapshot.
- Adapters: integration tests against real Postgres and Strapi via Testcontainers.
- End-to-end: one Playwright flow on the demo app — *track events → unlock toast
  appears → offer renders in placement → live event shows countdown*. **This test
  passing is the MVP definition of done.**
- TDD throughout; GitHub Actions CI runs typecheck + tests on every PR; Turborepo
  remote caching keeps it fast.

## 7. Roadmap (post-MVP tiers)

**v1.x**
- Leaderboards, streaks (needs per-user timezone windows), points/XP wallet
- Coupon/promo-code generation and validation
- Retroactive achievement granting (evaluate new definitions against stored events)
- Recurring timed events (recurrence rule on the reserved field)
- Config-as-code: JSON export/import of definitions + CLI (also the Strapi-exit
  migration path)
- React Native SDK wrapper

**v2**
- Segmentation/targeting (extends the `audience` union), analytics dashboards,
  A/B testing on campaigns
- Billing enforcement on the MVP usage counters (Stripe); free tier limits
- Chance mechanics as offer types: prize wheel, raffles, scratch cards
- "Wrapped" year-in-review API (viral loop, generated from the event log)
- Status page with public latency numbers at launch
- Braze/OneSignal/Zapier connectors; email/push on unlock

**v3**
- Cross-promo network between Promocean customers (moderation + rev-share)
- Third-party ad serving (only if demand justifies compliance burden)
- Points-wallet-powered offerwall (owning the wallet enables rev-share offer
  marketplace — a lane no gamification vendor occupies)
- Anti-fraud: redemption velocity caps, score-anomaly detection, device signals
- Native Swift/Kotlin SDKs; ML campaign optimization

## 8. Agile Process

- **Backlog:** GitHub Issues; epic labels `achievements`, `offers`, `timed-events`,
  `platform`. Milestones = sprints (2-week windows, side-project pace).
- **Definition of done:** tests pass, demo app exercises the feature, docs snippet
  written. No feature merges without demo-app usage.
- **Sprint plan:**
  - Sprint 0 — monorepo scaffold, CI, Strapi + Postgres running, key auth skeleton
  - Sprint 1 — event ingestion + achievements vertical slice (definition → track →
    unlock → toast)
  - Sprint 2 — offers slice (definition → placement → impression/click)
  - Sprint 3 — timed events + lifecycle webhooks + multiplier effect
  - Sprint 4 — polish, docs, OpenAPI, MVP e2e green
- **Retros:** notes in `docs/retros/` per sprint; with an AI pair, written retros
  compound as future context.

## 9. Competitive Research Summary (appendix)

Full research conducted 2026-07-06. Key findings that shaped this design:

- **Trophy (trophy.so):** closest gamification competitor. Free→100 MAU, $99/1k,
  $299/10k, active-only billing; 7 server SDKs, MIT UI kit, signed webhooks,
  <1hr integration bar. Explicitly positions *against* promotions — our wedge.
- **GameLayer:** €100–2,500/mo by active users, no feature gating ("pay for size,
  not features"); chance mechanics (raffles, prize wheel).
- **Talon.One (acquired by Adyen):** enterprise promotion rule engine, ~$50k–500k/yr;
  charges for dormant users — actively marketed against.
- **Voucherify:** mid-market promotions API, €600/mo for 25k API calls; multi-project
  environments as paid feature; qualification-API pattern worth borrowing.
- **Open Loyalty / Antavo:** enterprise loyalty engines; active-member billing
  definitions, data-residency options, gamified zero-party data capture.
- **PlayFab / LootLocker:** game-world LiveOps events and leaderboard-reset-with-
  rewards semantics; PlayFab is game-only DNA. AWS GameSparks is dead — the
  games-adjacent web/SaaS niche is orphaned.
- **Smile.io/LoyaltyLion/Yotpo:** widget-first ecommerce loyalty; API access gated at
  $729–999/mo — an opening for a sanely-priced API-first product.
- **Braze/OneSignal/Iterable:** distribution layers, not incentive engines — treat as
  integration targets, not competitors.
- **Market gaps this design exploits:** (1) nobody bundles gamification + promotions +
  offers; (2) timed events as a first-class primitive exist nowhere; (3) mid-market
  promotion-engine vacuum between €600/mo metered and $50k/yr enterprise;
  (4) anti-fraud underweighted market-wide; (5) DX above Trophy's bar (OpenAPI,
  config-as-code, test/live modes free) is open ground.
