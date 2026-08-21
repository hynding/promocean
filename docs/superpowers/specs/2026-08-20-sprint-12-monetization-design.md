# Promocean — Monetization Design (Sprint 12)

**Date:** 2026-08-20
**Status:** Approved design (user pre-authorized autonomous execution)
**Author:** Steve Hynding + Claude

## 1. Goal

Turn a code-complete platform into a revenue-generating product. The MVP design
(2026-07-06 spec, §1) already locked the business model — freemium + transparent
MAU-based tiers, billing on active users only — and built the metering counters
(`monthly_active_users`, `usage_counters`). What's missing is everything between
those counters and a paying customer:

1. **Plan semantics + enforcement** — a project has no `plan`; nothing reads the
   counters; there is no usage API and no limit behavior. (Implemented this sprint.)
2. **Demand capture** — no landing page, no pricing page, no waitlist, no
   commercial-license channel. (Implemented this sprint.)
3. **Billing glue + hosting + launch** — Stripe, a deployed Promocean Cloud, and
   distribution. (Requires operator accounts/keys — sequenced as follow-up prompts
   in `docs/monetization/PLAYBOOK.md`.)

## 2. Market validation (re-checked 2026-08-20)

Trophy (closest competitor) still prices Free/100 MAU → $99/1k → $299/10k, active
users only, and still positions *against* promotions. The July research holds:
nobody bundles gamification + promotions + timed events; the mid-market
promotion-engine vacuum (between €600/mo metered and $50k/yr enterprise) is open;
API access gated at $729–999/mo by ecommerce loyalty vendors remains an opening.

## 3. Revenue streams, ranked

| # | Stream | Why this rank | Status after Sprint 12 |
|---|--------|---------------|------------------------|
| 1 | **Promocean Cloud** — hosted SaaS, MAU tiers | The designed path; recurring; the only stream that scales | Plan+usage+enforcement shipped; deploy+billing prompts in playbook |
| 2 | **Commercial licensing** of the GPL platform | Zero marginal cost; GPL creates real demand from legal-averse companies; solo-author repo can dual-license cleanly | `COMMERCIAL-LICENSE.md` + contact channel shipped |
| 3 | **Paid support / integration services** | Bridges revenue while Cloud matures; converts OSS users | Offered on landing page |
| 4 | GitHub Sponsors | Small but free to enable | `FUNDING.yml` shipped (activates when sponsors profile enrolls) |
| 5 | Marketplace angles (Strapi marketplace listing, later Shopify app) | Distribution more than revenue at first | Playbook item |

Explicitly rejected for now: third-party ad serving (compliance burden, per the
MVP spec's roadmap ordering), paywalling existing MIT packages (breaks adoption
trust), charging for dormant users or gating API access to top tiers (the two
competitor-attacked patterns the spec forbids).

## 4. Pricing (locked)

Billing on **active** users only (MAU = distinct external user id with ≥1 tracked
event in the calendar month — already exactly what `monthly_active_users` stores).
Test-environment MAU is free (only `live` counts toward the plan) — "test/live
modes free" is a named DX wedge in the competitive research.

| Plan | Price | Live MAU included | Notes |
|------|-------|-------------------|-------|
| `free` | $0 | 1,000 | 10× Trophy's free tier — the headline acquisition hook |
| `growth` | $99/mo | 10,000 | Same $ as Trophy Starter, 10× the MAU, plus offers/promos/rewards bundled |
| `scale` | $299/mo | 50,000 | 5× Trophy Pro's MAU at the same price |
| `enterprise` | custom | custom | SLA, data residency, commercial license included |

Self-hosted (plan unset) is **unmetered — enforcement activates only when a plan
is set**, mirroring the `registeredEventTypes` opt-in pattern. The OSS product
never nags.

## 5. Sprint 12 implementation (this repo, this sprint)

### 5.1 Plan plumbing (follows the `allowedOrigins` path exactly)

- `packages/contracts`: `planIdSchema` = `'free' | 'growth' | 'scale' | 'enterprise'`;
  `usageResponseSchema`; new error code `mau_limit_exceeded`.
- `packages/core`: `plans.ts` — `PLANS` table (mauIncluded per plan; `enterprise`
  → `null` = custom/unlimited) and pure `evaluateUsage(plan, liveMau)` →
  `{ mauIncluded, percentUsed, overLimit }`. `AuthContext` gains
  `plan: PlanId | null` (null = self-hosted/unmetered).
- `apps/cms`: project content type gains optional `plan` enumeration; config-plane
  `verify-key` response carries it.
- `packages/adapter-strapi`: parse `plan` into `AuthContext` (invalid/absent → null,
  fail-open to unmetered — a config mistake must never take down ingestion).

### 5.2 Usage read model

- `packages/adapter-db`: `UsageReadStore` — `getUsage(scope, month)` → `{ mau,
  events }` (COUNT over `monthly_active_users`, read of `usage_counters`);
  `isUserActive(scope, month, userId)` (EXISTS probe, used only in block mode).
- `apps/api`: `GET /v1/usage` (sk only, like `/v1/stats`): current month's
  `{ month, environment, mau, events, plan, mauIncluded, percentUsed, overLimit }`.
  Optional `?month=YYYY-MM` for history (billing reconciliation reads this).

### 5.3 Enforcement (deliberately gentle)

`USAGE_ENFORCEMENT` env var: `off | warn | block`, default `warn`.

- Plan unset → zero checks, zero overhead (self-host default).
- `warn`: when a plan is set, ingest computes usage and, if over limit, sets an
  `x-promocean-usage` response header (`over-limit; mau=…; included=…`) and logs a
  structured warning. Nothing is rejected.
- `block`: over-limit ingests are rejected `402 mau_limit_exceeded` **only for
  users not already active this month** — existing active users are never locked
  out mid-month (the anti-Talon.One stance, enforced in code).
- Enforcement reads happen inside the ingest request only when `plan` is set, so
  the self-hosted hot path is untouched.

### 5.4 Demand capture

- `apps/www/index.html`: static landing + pricing page (no framework, no build
  step), deployed by `.github/workflows/pages.yml` to GitHub Pages. CTAs: cloud
  waitlist (mailto + GitHub issue template), quickstart (README), commercial
  license contact.
- `COMMERCIAL-LICENSE.md`: dual-licensing offer for the GPL platform.
- `.github/FUNDING.yml`: GitHub Sponsors pointer.
- `.github/ISSUE_TEMPLATE/cloud-waitlist.md`: zero-infrastructure waitlist.

### 5.5 Out of scope (playbook prompts instead)

Stripe integration (needs account/keys), Promocean Cloud deploy (needs Fly.io/
Railway account + domain), launch posts (needs human judgment/accounts), Strapi
marketplace listing, RN SDK. Each has a ready-to-paste prompt in
`docs/monetization/PLAYBOOK.md`.

## 6. Testing

Per repo convention, every layer: core pure-function tests (plan table
boundaries, percent/overLimit math, null-plan short-circuit), adapter-db tests
(usage counts scoped by project/env/month; isUserActive), api route tests
(sk-gating, month validation, warn header, block-mode 402 for new users +
pass-through for active users, plan-null no-op), contracts round-trip. E2e
unchanged (demo project has no plan set → proves the unmetered default).

## 7. Success criteria

- A hosted operator can set `plan` on a project in the CMS and immediately get
  truthful usage + limit signals from `GET /v1/usage` — manual invoicing is
  possible from that day, before any Stripe code exists.
- A self-hosting user sees zero behavior change.
- A visitor can understand what Promocean costs and raise their hand (waitlist /
  license inquiry) without any backend existing yet.
