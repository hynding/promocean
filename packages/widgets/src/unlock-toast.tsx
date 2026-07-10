import { useEffect, useRef, useState } from 'react'
import type { UnlockPayload } from '@promocean/contracts'
import { usePromocean } from './provider.js'

// Module-level, monotonic — not Date.now(): two unlocks can share the exact
// same achievementId+unlockedAt millisecond (e.g. a duplicate delivery), which
// would collide both as a derived React key and as a filter/removal token.
// A simple incrementing counter is also deterministic under fake timers.
let nextToastId = 0

type Toast = UnlockPayload & { id: number }

export function UnlockToast({ durationMs = 5000 }: { durationMs?: number }) {
  const client = usePromocean()
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const unsubscribe = client.onUnlock((u) => {
      const id = nextToastId++
      setToasts((t) => [...t, { ...u, id }])
      const timeoutId = setTimeout(() => {
        timers.current.delete(timeoutId)
        setToasts((t) => t.filter((x) => x.id !== id))
      }, durationMs)
      timers.current.add(timeoutId)
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
        <div key={t.id} style={{ background: '#1a1a2e', color: '#fff', borderRadius: 8, padding: '12px 16px', boxShadow: '0 4px 12px rgba(0,0,0,.3)', fontFamily: 'system-ui, sans-serif' }}>
          <strong>🏆 Achievement unlocked</strong>
          <div>{t.name}</div>
        </div>
      ))}
    </div>
  )
}
