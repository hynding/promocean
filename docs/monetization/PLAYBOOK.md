# Monetization playbook: from merged code to first dollar

**Written:** 2026-08-20, at the end of the sprint-12-monetization session.
**How to use this:** work the phases in order. Each phase says what only you can
do (accounts, keys, merges, posts), then gives a ready-to-paste prompt for the
next Claude session. The prompts assume this repo's conventions (sprint branch,
spec in `docs/superpowers/specs/`, TDD per layer, PR for you to merge).

**State as of this writing:** plan entitlements + `GET /v1/usage` + enforcement
gate are implemented on `sprint-12-monetization` (all suites green). Landing
page in `apps/www/` with a Pages workflow. Commercial-license and waitlist
channels exist. Pricing locked: free 1k / $99 10k / $299 50k live MAU.

---

## Phase 0 — Ship what exists (this week, ~1 hour of your time)

Manual steps, no Claude needed:

1. Merge PR #28 (sprint 11), then open/merge the PR for `sprint-12-monetization`.
2. Repo settings → Pages → Source: **GitHub Actions**. The landing page deploys
   on the next push to `main` touching `apps/www/` (or run the workflow manually).
3. Enroll in **GitHub Sponsors** (github.com/sponsors) — `FUNDING.yml` already
   points at `hynding`, the button appears once you're enrolled.
4. Repo settings → make the repo's social preview + description sell:
   "Achievements, offers, and live promotional events for any app — one API.
   Free to 1k MAU."

## Phase 1 — Deploy Promocean Cloud (the revenue prerequisite)

You need: a Fly.io **or** Railway account, a domain (e.g. `promocean.dev`), and
a managed Postgres (Fly Postgres / Neon / Railway PG). Nothing else blocks a
single-tenant-per-project hosted deployment — multi-tenancy is already in the
schema (projectId + environment everywhere).

Paste to Claude:

```
Deploy sprint: take Promocean to production on Fly.io. Write the spec first
(docs/superpowers/specs/YYYY-MM-DD-sprint-13-cloud-deploy-design.md), then
implement: fly.toml files (api, cms) with health checks wired to /readyz,
Dockerfiles reused from docker-compose, secrets documented (DATABASE_URL,
CONFIG_PLANE_SECRET, STRAPI creds, USAGE_ENFORCEMENT=warn), a deploy GitHub
Actions workflow gated on main, and a RUNBOOK.md covering: provisioning a new
customer project + keys in the CMS, setting its plan, rotating secrets, and
reading GET /v1/usage for month-end invoicing. Before webhooks go multi-tenant
self-serve, implement the SSRF guard (block private IP ranges in the webhook
dispatcher) that the README lists as required future work. I have created the
Fly account and will run the actual `fly` commands you give me.
```

**Revenue is possible at the end of this phase**: you can onboard a paying
customer manually (create project in CMS, set plan, invoice monthly from
`GET /v1/usage?month=`). Do not wait for Stripe to charge your first customer.

## Phase 2 — Stripe billing (self-serve payment)

You need: a Stripe account, products/prices created for Growth ($99) and
Scale ($299), and the price IDs.

Paste to Claude:

```
Billing sprint: integrate Stripe subscriptions with Promocean's plan system.
Spec first, then implement as a new GPL package or apps/api module: (1) a
Stripe webhook endpoint (checkout.session.completed,
customer.subscription.updated/deleted) that maps subscription price -> plan
('growth'/'scale') and writes it to the project's `plan` field through the
Strapi config plane; (2) payment-link or Checkout-session generation per
project; (3) a monthly usage-report job that reads GET /v1/usage and pushes
metered overage to Stripe (or flags it for manual invoicing, simpler v1);
(4) docs. Keep the OSS self-host path completely Stripe-free — billing must be
an optional module activated by STRIPE_SECRET_KEY presence. My Stripe price
IDs: [paste them]. TDD throughout; mock Stripe in tests.
```

## Phase 3 — Self-serve signup (removes you from the loop)

The biggest lift; do it after at least one manual customer proves demand.

Paste to Claude:

```
Self-serve sprint: design and implement Promocean Cloud signup. Spec first and
challenge my assumptions before coding. Scope: a minimal apps/portal (Next.js)
where a user signs in (GitHub OAuth), creates a project (provisions the Strapi
project + pk/sk keys via a new config-plane provisioning endpoint guarded by
the config secret), sees their keys once, reads usage (GET /v1/usage), and
gets a Stripe billing link. Explicitly out of scope: teams, roles, SSO. The
provisioning endpoint must be rate-limited and audit-logged.
```

## Phase 4 — Distribution (nobody pays for what they can't find)

Manual, spread over 2-3 weeks; Claude drafts, you post from your accounts:

1. **Show HN** — post the repo once the landing page is live. Title shape:
   "Show HN: Promocean – open-core achievements, offers, and timed events API".
2. **Reddit** r/webdev, r/SaaS, r/selfhosted (self-host angle lands well there).
3. **Product Hunt** once Cloud has self-serve or a concierge signup.
4. **Strapi ecosystem** — the CMS being Strapi is a distribution channel:
   write "How we use Strapi as a config plane" for their showcase/blog.

Paste to Claude (one at a time):

```
Draft my Show HN post for Promocean (title + first comment). The first comment
should cover: what it is, why timed events as a first-class primitive is the
wedge, the open-core split (MIT client / GPL platform), the 15-minute docker
quickstart, honest current limitations (single-instance rate limiting, no
self-serve cloud yet), and pricing intent. Plain text, no hype words, written
in first person as the solo builder.
```

```
Write a comparison page apps/www/compare-trophy.html matching the landing
page's design system: Promocean vs Trophy, honest table (they have 7 server
SDKs and a polished dashboard; we bundle promotions/timed-events/rewards, 10x
free tier, config-as-code, self-hostable). Then the same for Voucherify
(promotions-engine angle, our gamification bundle + price). No fabricated
numbers: pull their public pricing as of today with citations in HTML comments.
```

```
Write docs/blog/strapi-as-config-plane.md: a technical post on using Strapi v5
as the config plane for a runtime API (the two-endpoint protocol, TTL cache
with stale-on-error, why definitions and hot-path state must separate). End
with one paragraph on Promocean. I'll submit it to Strapi's blog/showcase.
```

## Phase 5 — First ten customers (concierge motion)

1. Define the design-partner offer: 6 months of Growth free in exchange for
   feedback + a logo/testimonial. Cap at 5 partners.
2. Hunt where the ICP lives: indie SaaS with engagement problems (education,
   fitness, community products), r/SaaS "how do I add gamification" threads,
   Trophy's public customers who also run promotions.

Paste to Claude:

```
Write the design-partner one-pager (docs/monetization/design-partner.md) and a
short cold-outreach template (not spammy, references something specific about
the recipient's product, offers the design-partner deal plainly). Then draft
replies I can adapt for common objections: "why not build in-house",
"GPL concerns", "you're a solo maintainer".
```

## Phase 6 — Compounding (after first revenue)

In rough priority order, one prompt each when ready:

- **React Native SDK** (the only remaining v1.x roadmap item; unlocks mobile
  gamification, where engagement spend concentrates).
- **Anti-fraud** (the market-wide gap the research found: rate anomaly
  detection on track(), duplicate-device heuristics) — a paid-tier feature
  that doesn't gate the API itself.
- **Hosted dashboard read-models** (owner-facing charts on /v1/stats) to
  reduce CMS-admin dependence.
- **Strapi Marketplace listing** for the CMS plugin surface.

---

## Decision log (why these choices)

- **Cloud-first over license-first:** recurring revenue compounds;
  commercial licenses are opportunistic (channel exists, zero marginal cost).
- **Manual invoicing before Stripe:** `GET /v1/usage?month=` was built
  specifically so a paying customer never waits on billing code.
- **Enforcement defaults to `warn`:** the two competitor-attacked patterns
  (charging dormant users, hard feature gates) are what the market hates;
  never lock out an active user mid-month is encoded in the block path.
- **No paywalling MIT packages, ever:** adoption trust is the moat's
  foundation; hosting convenience + license terms are the products.
