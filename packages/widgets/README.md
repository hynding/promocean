# @promocean/widgets

Ready-made React components for Promocean: unlock toasts, a badge cabinet,
placement offers, live-event countdowns, and a points leaderboard. Built on
top of [`@promocean/sdk`](../sdk/README.md).

## Install

    npm i @promocean/widgets @promocean/sdk

Requires React 18+.

## Quickstart

```tsx
import { Promocean } from '@promocean/sdk'
import {
  PromoceanProvider,
  UnlockToast,
  BadgeCabinet,
  Placement,
  EventCountdown,
  Leaderboard,
} from '@promocean/widgets'

const client = new Promocean({
  publishableKey: process.env.NEXT_PUBLIC_PROMOCEAN_KEY!,
  baseUrl: process.env.NEXT_PUBLIC_PROMOCEAN_API!,
  userId: 'user-123',
})

export function App() {
  return (
    <PromoceanProvider client={client}>
      {/* An offer for this placement slug, if one is active */}
      <Placement slug="homepage-banner" />

      {/* Scheduled/live/ending-soon timed events with a live countdown */}
      <EventCountdown />

      <button onClick={() => client.track('lesson_completed')}>
        Complete a lesson
      </button>

      {/* Locked + unlocked achievements, auto-refreshes on unlock */}
      <BadgeCabinet />

      {/* Toasts on achievement unlock — mount once, near the app root */}
      <UnlockToast />

      {/* Top 5 users by points, highlighting the identified user's row */}
      <Leaderboard limit={5} title="Top learners" />
    </PromoceanProvider>
  )
}
```

Construct one `Promocean` client per user session (e.g. with `useMemo`,
re-created when `userId` changes — see `apps/demo/app/promocean.tsx` in this
repo for a full working example) and pass it to `<PromoceanProvider client={client}>`.
All widgets below must be rendered inside a `PromoceanProvider`; they read
the client via `usePromocean()` and throw if used outside one.

## Components

### `<PromoceanProvider client={client}>`

Makes the `Promocean` SDK instance available to all descendant widgets via
React context. `usePromocean()` is also exported if you want to build custom
widgets against the same client.

### `<UnlockToast durationMs?={5000} />`

Subscribes to `client.onUnlock()` and renders transient toasts
(`role="status" aria-live="polite"`, fixed bottom-right) for each
achievement unlock. Mount once per page.

### `<BadgeCabinet />`

Renders the full achievement grid (locked and unlocked) for the identified
user, with `current`/`target` progress. Fetches on mount and re-fetches
automatically whenever an unlock happens.

### `<Placement slug="homepage-banner" />`

Fetches and renders the active offer creative for a placement slug. Handles
dismissal (persisted — see SSR note below) and click tracking
(`client.clickOffer()`) automatically. Renders nothing if there's no active
offer or the offer has already been dismissed.

**Impression semantics:** fetching the placement offer does **not** by
itself count as an impression — `<Placement/>` fires exactly one
`client.recordImpression()` beacon per mount, and only when the offer is
about to actually render (i.e. it exists and isn't already dismissed). An
already-dismissed offer never renders and never fires the beacon, including
across reloads, so impression counts reflect what a user actually saw, not
every fetch. If you consume `getPlacementOffer()` directly instead of using
`<Placement/>`, you're responsible for calling `recordImpression()` yourself
at the point the offer is actually shown.

`imageUrl`/`ctaUrl` are sanitized here: only `http:`/`https:` URLs are
rendered (anything else, e.g. a malformed or malicious `javascript:` URL, is
dropped). This sanitization is specific to this component — see the SDK
README's security note if you consume `getPlacementOffer()` directly.

### `<EventCountdown />`

Renders a live-updating countdown ("Starts in"/"Ends in") for every
scheduled, live, or ending-soon timed event. Ticks every second; renders
nothing when there are no such events.

### `<Leaderboard window? limit? title? />`

Renders a ranked table (rank, user, points) via `client.getLeaderboard()`.
`window` is `'all' | '7d' | '30d'` (server default `'all'`), `limit`
defaults to the server default (`10`, max `100`) when omitted, and `title`
renders an optional heading above the table. The identified user's own row
(matched by `client.currentUserId`) is bolded and highlighted
(`[data-promocean-current-user="true"]`). Renders nothing while empty or
before the initial fetch resolves. Fetches once on mount — it does not
auto-refresh after a `track()` call the way `<BadgeCabinet/>` does on
unlock, so re-mount it (or otherwise force a re-fetch) if you need it to
reflect points awarded during the current page session.

**Privacy:** the leaderboard shows every ranked user's raw `userId` — see
the SDK README's privacy note before rendering this with identifying user
ids.

## SSR

All widgets are safe to import in an SSR context (e.g. Next.js App Router;
mark the host component `'use client'` since they use hooks and the SDK's
browser APIs). The one SSR-relevant behavior: offer dismissal
(`Placement`'s dismiss button, backed by `client.dismissOffer()`) uses
`localStorage` and falls back to an in-memory `Set` when `localStorage`
isn't available (SSR, privacy modes, storage quota errors) — dismissals in
that fallback mode don't persist across reloads or page loads.

## Styling philosophy

No CSS file to import. Every widget ships with inline styles
(`system-ui` font stack, minimal borders/spacing) so it renders reasonably
out of the box with zero build-tool configuration. There's no theming API
yet — if you need different visuals, either override with your own CSS
targeting the `data-promocean-*` attributes (`[data-promocean-placement]`,
`[data-promocean-event]`, `[data-promocean-leaderboard]`,
`[data-promocean-current-user]`, `[data-locked]` on badge list items) or
compose your own UI directly against `@promocean/sdk` and `usePromocean()`.
