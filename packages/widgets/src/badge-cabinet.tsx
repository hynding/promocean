import { useCallback, useEffect, useState } from 'react'
import type { AchievementStatus } from '@promocean/contracts'
import { usePromocean } from './provider.js'

export function BadgeCabinet() {
  const client = usePromocean()
  const [achievements, setAchievements] = useState<AchievementStatus[]>([])

  const refresh = useCallback(() => {
    client.getAchievements().then(setAchievements).catch(() => {}) // fail silent-to-empty
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
