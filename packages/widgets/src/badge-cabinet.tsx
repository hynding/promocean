import { useCallback, useEffect, useState } from 'react'
import type { AchievementStatus } from '@promocean/contracts'
import { usePromocean } from './provider.js'

export function BadgeCabinet() {
  const client = usePromocean()
  const [achievements, setAchievements] = useState<AchievementStatus[]>([])

  const refresh = useCallback(() => {
    // A failed refetch (whether the initial load or an unlock-triggered one)
    // never blanks the list: setAchievements simply isn't called, so whatever
    // was previously shown (or the initial empty state) stays put. The
    // failure is still surfaced via console.warn rather than swallowed.
    client.getAchievements().catch((err) => {
      console.warn('[promocean] BadgeCabinet failed to fetch achievements; keeping previous list', err)
      return undefined
    }).then((achievements) => {
      if (achievements) setAchievements(achievements)
    })
  }, [client])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => client.onUnlock(() => refresh()), [client, refresh])

  return (
    <ul style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, listStyle: 'none', padding: 0, fontFamily: 'system-ui, sans-serif' }}>
      {achievements.map((a) => {
        const locked = a.unlockedAt === null
        return (
          <li key={a.achievementId} data-locked={locked ? 'true' : 'false'}
              style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, opacity: locked ? 0.55 : 1 }}>
            <div style={{ fontWeight: 600 }}>{a.name}</div>
            {a.description ? <div style={{ fontSize: 13, color: '#666' }}>{a.description}</div> : null}
            <div style={{ fontSize: 13, marginTop: 4 }}>{a.current}/{a.target}</div>
          </li>
        )
      })}
    </ul>
  )
}
