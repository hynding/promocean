'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Promocean } from '@promocean/sdk'
import { BadgeCabinet, EventCountdown, Leaderboard, Placement, PromoceanProvider, UnlockToast } from '@promocean/widgets'

export function Demo({ userId }: { userId: string }) {
  const client = useMemo(() => new Promocean({
    publishableKey: process.env.NEXT_PUBLIC_PROMOCEAN_KEY!,
    baseUrl: process.env.NEXT_PUBLIC_PROMOCEAN_API!,
    userId,
  }), [userId])
  const [busy, setBusy] = useState(false)
  const [balance, setBalance] = useState(0)
  const [streak, setStreak] = useState(0)

  // Refreshed on mount and again after every tracked event — points/streak
  // both change inside the same ingestion transaction a track() call awaits.
  const refreshEngagement = useCallback(() => {
    client.getWallet().then((w) => setBalance(w.balance)).catch(() => {})
    client.getStreak().then((s) => setStreak(s.current)).catch(() => {})
  }, [client])

  useEffect(() => { refreshEngagement() }, [refreshEngagement])

  const fire = (type: string) => async () => {
    setBusy(true)
    try {
      await client.track(type)
      refreshEngagement()
    } finally { setBusy(false) }
  }

  return (
    <PromoceanProvider client={client}>
      <main style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Promocean Demo</h1>
        <p>User: <code>{userId}</code></p>
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
        <h2>Your badges</h2>
        <BadgeCabinet />
        <UnlockToast />
        <h2>Leaderboard</h2>
        <Leaderboard limit={5} title="Top learners" />
      </main>
    </PromoceanProvider>
  )
}
