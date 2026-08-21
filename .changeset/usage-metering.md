---
"@promocean/contracts": minor
---

Usage-metering contracts for the new `GET /v1/usage` endpoint and plan-limit
enforcement: `planIdSchema` (`free` | `growth` | `scale` | `enterprise`),
`usageQuerySchema` (`?month=YYYY-MM`), `usageResponseSchema` (month, mau,
events, plan, mauIncluded, percentUsed, overLimit), and the new
`mau_limit_exceeded` error code (returned `402` by `POST /v1/events` only when
a hosted project's plan is over its included live MAU with `USAGE_ENFORCEMENT=block`,
and only for users not already active in the month). Self-hosted projects with
no plan set are unaffected — `plan: null` means unmetered.
