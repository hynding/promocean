import { useEffect, useRef, useState } from 'react'
import type { UnlockPayload } from '@promocean/contracts'
import { usePromocean } from './provider.js'

export function UnlockToast({ durationMs = 5000 }: { durationMs?: number }) {
  const client = usePromocean()
  const [toasts, setToasts] = useState<UnlockPayload[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const unsubscribe = client.onUnlock((u) => {
      setToasts((t) => [...t, u])
      const id = setTimeout(() => {
        timers.current.delete(id)
        setToasts((t) => t.filter((x) => x !== u))
      }, durationMs)
      timers.current.add(id)
    })
    return () => {
      unsubscribe()
      for (const id of timers.current) clearTimeout(id)
      timers.current.clear()
    }
  }, [client, durationMs])

  return (
    <div role="status" aria-live="polite" style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 2147483647 }}>
      {toasts.map((t) => (
        <div key={`${t.achievementId}-${t.unlockedAt}`} style={{ background: '#1a1a2e', color: '#fff', borderRadius: 8, padding: '12px 16px', boxShadow: '0 4px 12px rgba(0,0,0,.3)', fontFamily: 'system-ui, sans-serif' }}>
          <strong>🏆 Achievement unlocked</strong>
          <div>{t.name}</div>
        </div>
      ))}
    </div>
  )
}
