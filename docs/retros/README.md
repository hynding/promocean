# Sprint retros

One-paragraph retro stubs for Sprints 0-5, sourced from the git history and
the implementation plans in `docs/superpowers/plans/`. Full task-by-task
detail lives in `.superpowers/sdd/progress.md`.

## Sprint 0-1 — foundation + achievements

(`docs/superpowers/plans/2026-07-06-sprint-0-1-foundation-achievements.md`,
merged via PR #1.) Shipped the whole MVP skeleton in one pass: the
pnpm/Turborepo monorepo, `@promocean/contracts` (zod schemas), `@promocean/core`
(pure achievement evaluation), `adapter-db` (Postgres via Drizzle), the Strapi
config-plane CMS with API-key auth, the `apps/api` Hono runtime, the
`@promocean/sdk` client, accessible `@promocean/widgets`, and a demo app
proving the full track-to-unlock loop with Playwright e2e. Task-by-task review
caught real issues early (timing-safe key comparison, zod v4 idiom fixes,
pool-error handling). The whole-branch final review hit a session length
limit on the first attempt and had to be re-dispatched fresh — a reminder to
leave headroom before a final review on a large branch.

## Sprint 2 — first-party offers

(`docs/superpowers/plans/2026-07-06-sprint-2-offers.md`, merged via PR #7.)
Added the first-party offers vertical slice end to end: offer/placement
content types in the CMS, a pure resolution function in `core`, a TTL-cached
config-plane client, the placement-offer and click API endpoints, and the
`<Placement/>` widget with dismissal persistence and click tracking. Most
tasks reviewed clean on the first pass. The one real finding was an XSS gap —
`imageUrl`/`ctaUrl` from CMS-authored offer creative were rendered
unsanitized — fixed with an `http(s)`-only scheme allowlist at the widget
layer, a good reminder to treat CMS content as untrusted input at the
rendering boundary, not just at the API boundary.

## Sprint 3 — timed events + lifecycle webhooks

(`docs/superpowers/plans/2026-07-07-sprint-3-timed-events.md`, merged via PR
#9.) Added timed-event progress multipliers, event-gated offers, a signed
webhook dispatcher, a lifecycle scheduler driving `timed_event.live` /
`ending_soon` / `ended` transitions with claim-then-mark delivery and a
dead-letter store, plus a live countdown widget. Most tasks were review-clean
first pass, though Task 4 noted the webhook-endpoint secret was exposed via
the CMS's default REST routes (mirroring an existing api-key pattern). The
final review fixed several issues in one wave — that secret exposure, a
webhook delivery timeout, an orphan-event guard, and a multiplier-
documentation gap — before re-approving; a new issue (#8) was filed for
follow-up work and two existing issues extended in scope.

## Sprint 4 — security completion, observability, OpenAPI, publishing

(`docs/superpowers/plans/2026-07-07-sprint-4-polish.md`, merged via PR #12.)
Closed out the MVP's remaining spec requirements: per-key rate limiting, an
origin allowlist, secret-key-gated GDPR user erasure (the first
`keyType`-enforced endpoint), pino structured logging with request IDs, an
OpenAPI document generated straight from the zod contracts, and a Changesets
publishing setup for the three MIT packages. Nearly every task reviewed clean
first pass. The one lasting cosmetic issue — the erasure changeset also
listed `@promocean/sdk`/`@promocean/widgets`, producing misleading changelog
entries for packages the change didn't touch — was carried forward rather
than fixed in-sprint, and is what Sprint 6's changeset-authoring note now
addresses.

## Sprint 5 — stats endpoint + data integrity

(`docs/superpowers/plans/2026-07-07-sprint-5-stats-integrity.md`, merged via
PR #16.) Fixed two real data-integrity bugs (a dedup/increment race in event
ingestion, and impressions being recorded on every placement fetch instead of
only on actual render) by moving to a single transactional ingestion store
and a dedicated idempotent impression-beacon endpoint, then added a
secret-key-only `/v1/stats` aggregation endpoint and a server-rendered stats
page in the demo app. DoD was verified live against real aggregated data, not
just fakes. The final review's fix wave was small (a fail-open warning
comment, a delta-rounding rationale note) but filed three follow-up issues
(offer-id validation, test hardening, stats polish) — a sign the sprint
correctly deferred polish rather than scope-creeping to absorb it.
