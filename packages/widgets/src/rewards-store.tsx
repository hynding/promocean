import { useCallback, useEffect, useRef, useState } from 'react'
import type { Reward, WalletResponse } from '@promocean/contracts'
import { PromoceanApiError } from '@promocean/sdk'
import { usePromocean } from './provider.js'

const CLAIM_ERROR_MESSAGES: Record<string, string> = {
  insufficient_points: 'Not enough points',
  claim_limit_reached: 'Claim limit reached',
  reward_unavailable: 'Reward unavailable',
}

export function RewardsStore({ title }: { title?: string }) {
  const client = usePromocean()
  const [rewards, setRewards] = useState<Reward[]>([])
  const [wallet, setWallet] = useState<WalletResponse | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [claimedCodes, setClaimedCodes] = useState<Record<string, string>>({})
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({})

  // Tracks liveness across the async post-claim refetch, which is kicked off
  // from an event handler rather than an effect and so can't rely on an
  // effect-scoped `cancelled` flag the way the initial fetch below does.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const load = useCallback(() => Promise.all([client.listRewards(), client.getWallet()]), [client])

  useEffect(() => {
    if (!client.currentUserId) return
    let cancelled = false
    load().then(([r, w]) => {
      if (!cancelled) { setRewards(r); setWallet(w) }
    }).catch(() => {}) // fail silent-to-empty, matches Leaderboard/Placement pattern
    return () => { cancelled = true }
  }, [client, load])

  if (!client.currentUserId) return null

  const handleClaim = (slug: string) => {
    setPending((p) => ({ ...p, [slug]: true }))
    setClaimErrors((e) => {
      if (!(slug in e)) return e
      const next = { ...e }
      delete next[slug]
      return next
    })
    client.claimReward(slug).then((res) => {
      if (!mountedRef.current) return
      setPending((p) => ({ ...p, [slug]: false }))
      setClaimedCodes((c) => ({ ...c, [slug]: res.code }))
      void load().then(([r, w]) => {
        if (!mountedRef.current) return
        setRewards(r)
        setWallet(w)
      })
      // Post-claim refetch failures are not swallowed silently: they simply
      // leave the previously fetched rewards/balance in place, same as the
      // fail-silent-to-empty read pattern used elsewhere in this file.
    }).catch((err) => {
      if (!mountedRef.current) return
      setPending((p) => ({ ...p, [slug]: false }))
      const message = err instanceof PromoceanApiError
        ? (CLAIM_ERROR_MESSAGES[err.code] ?? err.message)
        : (err instanceof Error ? err.message : 'Claim failed')
      setClaimErrors((e) => ({ ...e, [slug]: message }))
    })
  }

  const copyCode = (code: string) => {
    try { void navigator.clipboard.writeText(code) } catch { /* clipboard unavailable — code is still visible on-screen */ }
  }

  const balance = wallet?.balance ?? 0

  return (
    <div data-promocean-rewards style={{ fontFamily: 'system-ui, sans-serif' }}>
      {title ? <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div> : null}
      <div style={{ fontSize: 14, color: '#555', marginBottom: 12 }}>
        Balance: <strong>{balance}</strong> pts
      </div>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
        {rewards.map((reward) => {
          const soldOut = reward.remaining === 0
          const insufficientPoints = reward.pointsPrice > balance
          const isPending = pending[reward.slug] === true
          const claimedCode = claimedCodes[reward.slug]
          const claimError = claimErrors[reward.slug]
          const disabled = isPending || soldOut || insufficientPoints
          const buttonLabel = isPending
            ? 'Claiming…'
            : soldOut
              ? 'Sold out'
              : insufficientPoints
                ? 'Not enough points'
                : 'Claim'

          return (
            <li key={reward.slug} data-promocean-reward={reward.slug}
                style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
              <div style={{ fontWeight: 600 }}>{reward.name}</div>
              {reward.description ? <div style={{ fontSize: 13, color: '#666' }}>{reward.description}</div> : null}
              <div style={{ fontSize: 13, marginTop: 4 }}>
                {reward.pointsPrice === 0 ? 'Free' : `${reward.pointsPrice} pts`}
                {reward.remaining !== null ? ` · ${reward.remaining} left` : null}
              </div>
              {claimedCode ? (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ background: '#f5f5f5', padding: '2px 6px', borderRadius: 4 }}>{claimedCode}</code>
                  <button onClick={() => copyCode(claimedCode)}>Copy</button>
                </div>
              ) : (
                <div style={{ marginTop: 8 }}>
                  <button disabled={disabled} onClick={() => handleClaim(reward.slug)}>{buttonLabel}</button>
                  {claimError ? (
                    <div role="alert" style={{ fontSize: 13, color: '#b00020', marginTop: 4 }}>{claimError}</div>
                  ) : null}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
