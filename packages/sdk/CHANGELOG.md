# @promocean/sdk

## 0.1.0

### Minor Changes

- 469a85f: Add campaign lifecycle: recurring timed events and retroactive achievement
  backfill.

  - Timed events gain an optional `recurrence: 'daily' | 'weekly' | 'monthly'`
    (default `'none'`) and `recurrenceEndsAt` cutoff. `getLiveEvents()` (and
    the underlying `LiveTimedEvent` shape) additively gains `recurrence` and
    `nextOccurrenceStartsAt` — both default when omitted, so code built
    against an older `@promocean/sdk`/`@promocean/contracts` still parses an
    old-shape or new-shape response either way.
  - New `backfillAchievement(achievementId)` SDK method (secret-key-only,
    same posture as `getStats()`/`validateCoupon()`/`redeemCoupon()`):
    retroactively recomputes an achievement's progress/unlocks/points against
    all historical events of its `eventType`, returning `{ usersEvaluated,
    progressRaised, unlocksGranted, pointsAwarded }`. A retroactive unlock
    pays out its `pointsValue` bonus exactly like a live one — see the root
    README for the full operator flow. The error catalog gains a
    `backfill_in_progress` code (surfaced as `409` when a backfill of the same
    achievement is already running — the endpoint try-locks rather than
    queueing).
  - Webhook payloads for recurring timed-event transitions gain an additive
    `data.occurrence: { startsAt, endsAt }` field (the specific occurrence
    that fired); `data.startsAt`/`data.endsAt` stay the definition's own
    window, unchanged. The HMAC signature and `messageId` dedup semantics are
    unaffected.

  Internal-only, not a version bump here: `WebhookDeliveryStore`'s port
  signature widened to key claims by `occurrenceKey` (`@promocean/core` isn't
  published to npm, so this doesn't affect installed package versions, but is
  worth knowing if you implement your own store against `@promocean/core`'s
  types).

- 2b4c851: Reactive `identify()`: the SDK gains `onUserChange(cb)`, firing whenever
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

- eaecfe0: Add rewards and coupons: reward catalog/claim, coupon validate/redeem
  (`listRewards`, `claimReward`, `validateCoupon`, `redeemCoupon`), the
  `<RewardsStore/>` widget, four new `409` error codes
  (`reward_unavailable`, `claim_limit_reached`, `insufficient_points`,
  `already_redeemed`), and an additive `coupons` count on the erasure
  response. `WalletResponse`'s `recent[].source` gains a `'redemption'`
  value — an older `@promocean/contracts`/`@promocean/sdk` will fail
  zod-parsing a wallet response once a redemption exists in your project, so
  upgrade both packages together before rewards spending goes live.

### Patch Changes

- e2d3502: Add `forbidden` error code and the user-erasure response schema.
- Updated dependencies [469a85f]
- Updated dependencies [e2d3502]
- Updated dependencies [2b4c851]
- Updated dependencies [eaecfe0]
  - @promocean/contracts@0.1.0
