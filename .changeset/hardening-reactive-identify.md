---
"@promocean/sdk": minor
"@promocean/widgets": minor
"@promocean/contracts": patch
---

Reactive `identify()`: the SDK gains `onUserChange(cb)`, firing whenever
`identify(userId)` actually changes the current user (never on a no-op
re-identify to the same id). `@promocean/widgets`' `<PromoceanProvider/>`
subscribes to it and exposes the live identified user via the new
`usePromoceanUser()` hook, so `<Leaderboard/>`'s current-user highlight and
`<RewardsStore/>`'s fetch both track the identified user reactively —
re-identifying an existing client to a different user no longer requires
remounting widgets via a React `key` to see them reflect the new identity.

`@promocean/contracts`' `statsQuerySchema` (`from`/`to`) now accepts
offset-ISO datetimes (e.g. `2026-01-01T00:00:00+01:00`), not just UTC `Z`
timestamps — an additive widening of accepted input, not a breaking change.
