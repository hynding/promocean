# @promocean/sdk

Runtime client for the Promocean API — event tracking, achievement status,
placement offers, and live timed events. Framework-agnostic; works in the
browser or Node (18+ for global `fetch`/`crypto.randomUUID`).

If you're building a React app, see
[`@promocean/widgets`](../widgets/README.md) instead — it wraps this SDK in
ready-made components.

## Install

    npm i @promocean/sdk

## Quickstart

```ts
import { Promocean } from '@promocean/sdk'

const promocean = new Promocean({
  publishableKey: 'pk_test_...', // use a publishable key client-side; never ship a secret key to the browser
  baseUrl: 'https://api.your-promocean-host.example',
})

promocean.identify('user-123')

// Track an event. Unlocks any achievements it completes.
const { unlocks, progress } = await promocean.track('lesson_completed')
// unlocks: [{ achievementId, name, unlockedAt }]
// progress: [{ achievementId, current, target }]

// Get a user's full achievement status (locked + unlocked).
const achievements = await promocean.getAchievements()

// Get the active offer for a placement slug (or null if none).
const offer = await promocean.getPlacementOffer('homepage-banner')

// Record a click on an offer's CTA (fire-and-forget — never throws).
await promocean.clickOffer(offer.offerId)

// Dismiss an offer; dismissal is remembered (localStorage, falling back to
// an in-memory Set when localStorage is unavailable, e.g. SSR).
promocean.dismissOffer(offer.offerId)
promocean.isOfferDismissed(offer.offerId) // true

// Get currently scheduled/live/ending-soon timed events (progress multipliers).
const liveEvents = await promocean.getLiveEvents()
```

### `new Promocean(options)`

| option | type | required | notes |
| --- | --- | --- | --- |
| `publishableKey` | `string` | yes | Bearer token sent as `Authorization: Bearer <key>`. A publishable key (`pk_...`) is fine for browser use; it's origin-restricted server-side. |
| `baseUrl` | `string` | yes | Base URL of the Promocean API, e.g. `http://localhost:3001` in dev. |
| `userId` | `string` | no | Seed the identified user up front instead of calling `identify()`. |
| `fetchImpl` | `typeof fetch` | no | Override `fetch` (e.g. for testing or non-browser runtimes without a global `fetch`). |
| `maxRetries` | `number` | no | Retries for 5xx/network failures, with exponential backoff. Default `3`. 4xx errors are never retried. |

### Identifying a user

`identify(userId)` sets the current user. `track()` and `getAchievements()`
throw if called before a user is identified. `getPlacementOffer()` and
`getLiveEvents()` work anonymously (no `userId` required).

### Listening for unlocks

```ts
const unsubscribe = promocean.onUnlock((unlock) => {
  console.log(`Unlocked: ${unlock.name}`)
})
// later: unsubscribe()
```

`track()` calls are serialized internally (a call queue), so unlocks fire in
the order events were tracked even if you don't `await` each call.

## Error handling

Non-2xx responses throw `PromoceanApiError`:

```ts
import { PromoceanApiError } from '@promocean/sdk'

try {
  await promocean.track('lesson_completed')
} catch (err) {
  if (err instanceof PromoceanApiError) {
    console.error(err.code, err.status, err.message)
    // e.g. "rate_limited" 429, "invalid_api_key" 401, "invalid_payload" 400
  } else {
    throw err // network error after retries exhausted, etc.
  }
}
```

`err.code` mirrors the API's `error.code` field (see the root README's API
surface table and `GET /v1/openapi.json` for the full error taxonomy).
`clickOffer()` is the one exception: it swallows all errors so a broken
click-tracking call never breaks the host page's navigation.

Retries are built in for 5xx and network failures (exponential backoff,
`maxRetries` attempts). 4xx errors surface immediately as `PromoceanApiError`
without retrying.

## Security note: creative URLs

`getPlacementOffer()` returns raw `imageUrl`/`ctaUrl` strings from your
configured offer creative — the SDK does **not** sanitize them. URL
sanitization (restricting to `http(s)://`) happens at the **widget layer**
only (`@promocean/widgets`' `<Placement/>` component). If you consume
`getPlacementOffer()` directly instead of using `<Placement/>`, apply your
own `http(s)` allowlist before rendering `imageUrl`/`ctaUrl` (e.g. as an
`<img src>` or `<a href>`) to avoid `javascript:`/`data:` URL injection from
misconfigured or compromised CMS content.

## Types

Request/response shapes (`TrackEventResponse`, `AchievementStatus`,
`OfferCreative`, `UnlockPayload`, `LiveTimedEvent`, etc.) are re-exported
from `@promocean/contracts` and validated at runtime with zod — a malformed
API response throws rather than silently returning bad data.
