'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Promocean } from '@promocean/sdk'
import {
  BadgeCabinet, EventCountdown, Leaderboard, Placement, PromoceanProvider, RewardsStore, UnlockToast,
  usePromocean, usePromoceanUser,
} from '@promocean/widgets'

function generateUserId(): string {
  return `demo-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Rendered inside <PromoceanProvider/> so it can read the reactive identified-user
// state (usePromoceanUser()) rather than the client's identity at initial mount —
// that's what lets "Switch user" re-identify the *same* client instance and have
// this readout (and the <Leaderboard/> highlight below) live-update with no
// remount/key hack, unlike <RewardsStore/>'s fetch-once-per-mount contract.
function DemoBody() {
  const client = usePromocean()
  const userId = usePromoceanUser()
  const [busy, setBusy] = useState(false)
  const [balance, setBalance] = useState(0)
  const [streak, setStreak] = useState(0)
  // <RewardsStore/> only fetches its rewards/wallet once on mount (same
  // fetch-once-and-remount contract documented for <Leaderboard/> in the
  // widgets README) — bumping this key remounts it after a tracked event so
  // its balance/claim-eligibility reflect newly earned points.
  const [rewardsKey, setRewardsKey] = useState(0)

  // Refreshed on mount, again after every tracked event (points/streak both
  // change inside the same ingestion transaction a track() call awaits), and
  // again whenever the identified user changes (switch-user re-identify) —
  // the userId dependency is what makes this reset reflect the new user's
  // own wallet/streak instead of the previous user's stale numbers.
  const refreshEngagement = useCallback(() => {
    client.getWallet().then((w) => setBalance(w.balance)).catch(() => {})
    client.getStreak().then((s) => setStreak(s.current)).catch(() => {})
  }, [client])

  useEffect(() => { refreshEngagement() }, [refreshEngagement, userId])

  const fire = (type: string) => async () => {
    setBusy(true)
    try {
      await client.track(type)
      refreshEngagement()
      setRewardsKey((k) => k + 1)
    } finally { setBusy(false) }
  }

  // Re-identifies the *same* client to a fresh generated id — no remount, no
  // React key bump. The provider's onUserChange subscription propagates this
  // to every descendant widget (this readout, <Leaderboard/>'s highlight,
  // <RewardsStore/>'s balance) reactively.
  const switchUser = () => { client.identify(generateUserId()) }

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Promocean Demo</h1>
      <p>
        User: <code data-testid="current-user-id">{userId}</code>{' '}
        <button onClick={switchUser}>Switch user</button>
      </p>
      <Placement slug="homepage-banner" />
      <EventCountdown />
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <button disabled={busy} onClick={fire('lesson_completed')}>Complete a lesson</button>
        <button disabled={busy} onClick={fire('profile_completed')}>Complete profile</button>
      </div>
      <p>
        Points: <span data-testid="wallet-balance">{balance}</span> · Streak:{' '}
        <span data-testid="streak-count">{streak}</span> day(s)
      </p>
      <h2>Rewards</h2>
      <RewardsStore key={rewardsKey} title="Rewards store" />
      <h2>Your badges</h2>
      <BadgeCabinet />
      <UnlockToast />
      <h2>Leaderboard</h2>
      <Leaderboard limit={5} title="Top learners" />
    </main>
  )
}

export function Demo({ userId }: { userId: string }) {
  // Constructed once from the page's initial ?user= (or default) and never
  // recreated by a "Switch user" click — that click calls client.identify()
  // directly (see switchUser above) instead of changing the userId prop, so
  // the same client instance persists across an in-page user switch.
  const client = useMemo(() => new Promocean({
    publishableKey: process.env.NEXT_PUBLIC_PROMOCEAN_KEY!,
    baseUrl: process.env.NEXT_PUBLIC_PROMOCEAN_API!,
    userId,
  }), [userId])

  return (
    <PromoceanProvider client={client}>
      <DemoBody />
    </PromoceanProvider>
  )
}
