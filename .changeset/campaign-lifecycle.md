---
"@promocean/contracts": minor
"@promocean/sdk": minor
---

Add campaign lifecycle: recurring timed events and retroactive achievement
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
  README for the full operator flow.
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
