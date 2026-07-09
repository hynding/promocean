---
"@promocean/contracts": minor
"@promocean/sdk": minor
"@promocean/widgets": minor
---

Add rewards and coupons: reward catalog/claim, coupon validate/redeem
(`listRewards`, `claimReward`, `validateCoupon`, `redeemCoupon`), the
`<RewardsStore/>` widget, four new `409` error codes
(`reward_unavailable`, `claim_limit_reached`, `insufficient_points`,
`already_redeemed`), and an additive `coupons` count on the erasure
response. `WalletResponse`'s `recent[].source` gains a `'redemption'`
value — an older `@promocean/contracts`/`@promocean/sdk` will fail
zod-parsing a wallet response once a redemption exists in your project, so
upgrade both packages together before rewards spending goes live.
