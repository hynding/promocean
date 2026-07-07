'use client'
import { useMemo, useState } from 'react'
import { Promocean } from '@promocean/sdk'
import { BadgeCabinet, EventCountdown, Placement, PromoceanProvider, UnlockToast } from '@promocean/widgets'

export function Demo({ userId }: { userId: string }) {
  const client = useMemo(() => new Promocean({
    publishableKey: process.env.NEXT_PUBLIC_PROMOCEAN_KEY!,
    baseUrl: process.env.NEXT_PUBLIC_PROMOCEAN_API!,
    userId,
  }), [userId])
  const [busy, setBusy] = useState(false)

  const fire = (type: string) => async () => {
    setBusy(true)
    try { await client.track(type) } finally { setBusy(false) }
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
        <h2>Your badges</h2>
        <BadgeCabinet />
        <UnlockToast />
      </main>
    </PromoceanProvider>
  )
}
