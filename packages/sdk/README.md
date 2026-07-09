# @promocean/sdk

Runtime client for the Promocean API — event tracking, achievement status,
points/streaks/leaderboards, placement offers, and live timed events.
Framework-agnostic; works in the browser or Node (18+ for global
`fetch`/`crypto.randomUUID`).

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

// Get a user's points wallet: running balance + a short recent ledger.
const { balance, recent } = await promocean.getWallet()

// Get a user's current/longest daily activity streak.
const { current, longest, lastActiveDay } = await promocean.getStreak()

// Get the top users in the project by points (optionally windowed/limited).
const { entries } = await promocean.getLeaderboard({ window: '7d', limit: 10 })

// Get the active offer for a placement slug (or null if none).
const offer = await promocean.getPlacementOffer('homepage-banner')

// Record a click on an offer's CTA (fire-and-forget — never throws).
await promocean.clickOffer(offer.offerId)

// Record an impression beacon for an offer that actually rendered
// (fire-and-forget — never throws; idempotent per impressionId).
await promocean.recordImpression(offer.offerId)

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
| `secretKey` | `string` | no | **Server-side only.** Grants access to secret-key-only endpoints (currently `getStats()`). See "Server-side stats" below. When you only need `secretKey` (no browser-side calls at all from this client instance), pass `publishableKey: ''` — it's never sent unless a call actually needs it. |

### Identifying a user

`identify(userId)` sets the current user. `track()` and `getAchievements()`
throw if called before a user is identified. `getPlacementOffer()` and
`getLiveEvents()` work anonymously (no `userId` required).

### Points, streaks, leaderboards

```ts
promocean.getWallet(): Promise<WalletResponse>       // { balance, recent: [{ delta, source, sourceRef, at }] }
promocean.getStreak(): Promise<StreakResponse>       // { current, longest, lastActiveDay }
promocean.getLeaderboard(opts?): Promise<LeaderboardResponse> // { window, entries: [{ rank, userId, points }] }
```

`getWallet()` and `getStreak()` read the identified user (`identify()`
first, same as `getAchievements()`). `getLeaderboard({ window?, limit? })`
is anonymous — `window` is `'all' | '7d' | '30d'` (default `'all'` on the
server), `limit` defaults to `10` (max `100`). Timed-event multipliers
apply to achievement progress only; point awards are never multiplied.

`track()` sets `tzOffsetMinutes` automatically on every call (minutes east
of UTC, from `-new Date().getTimezoneOffset()`), which is what the server
uses to resolve the event's client-local calendar day for streak
advancement. If you construct the request yourself instead of going through
this SDK and omit it (or send a non-numeric/invalid value), the server falls
back to treating the event as UTC for that one event — streak computation
never fails, it just uses the UTC day boundary instead of the caller's local
one.

**Leaderboard privacy note:** `getLeaderboard()` is callable with a
publishable key and returns every ranked user's external `userId` alongside
their points — anyone holding your `pk_...` key can see it. If your
`userId`s are anything identifying (emails, real names, etc.), pass an
opaque/pseudonymous id to `identify()`/`track()` instead and map it to a
display name in your own app before showing a leaderboard; Promocean has no
notion of identity beyond the id you give it.

### Server-side stats (`secretKey`)

`getStats()` fetches aggregate totals/achievements/offers/timed-events for
your project and requires a **secret key** (`sk_...`), not a publishable
key:

```ts
// app/stats/page.tsx — a Next.js Server Component, for example
const promocean = new Promocean({
  publishableKey: '', // this client only calls getStats(); no pk needed
  secretKey: process.env.PROMOCEAN_SECRET_KEY!, // server env var, NOT NEXT_PUBLIC_*
  baseUrl: process.env.PROMOCEAN_API_URL!,
})

const stats = await promocean.getStats({ from: '2026-01-01T00:00:00.000Z' })
// { range, totals, achievements, offers (with ctr), timedEvents (with participants) }
```

**Never ship a secret key to the browser.** Unlike `publishableKey`, a
`secretKey` must only ever be read from a server-side environment variable
(no `NEXT_PUBLIC_`/`VITE_`/similar client-exposing prefix) and must only be
constructed inside server-only code (a Server Component, an API route/route
handler, a backend service) — never in code that ships to or runs in a
browser. Calling `getStats()` without a configured `secretKey` throws
immediately rather than attempting the request.

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
`OfferCreative`, `UnlockPayload`, `LiveTimedEvent`, `WalletResponse`,
`StreakResponse`, `LeaderboardResponse`, etc.) are re-exported
from `@promocean/contracts` and validated at runtime with zod — a malformed
API response throws rather than silently returning bad data.
