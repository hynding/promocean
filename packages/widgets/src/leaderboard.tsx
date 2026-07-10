import { useEffect, useState } from 'react'
import type { LeaderboardResponse, LeaderboardWindow } from '@promocean/contracts'
import { usePromocean, usePromoceanUser } from './provider.js'

type LeaderboardEntry = LeaderboardResponse['entries'][number]

export function Leaderboard({
  window,
  limit,
  title,
}: {
  window?: LeaderboardWindow
  limit?: number
  title?: string
}) {
  const client = usePromocean()
  const userId = usePromoceanUser()
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])

  useEffect(() => {
    let cancelled = false
    client.getLeaderboard({ window, limit })
      .then((res) => { if (!cancelled) setEntries(res.entries) })
      .catch(() => {}) // fail silent-to-empty
    return () => { cancelled = true }
  }, [client, window, limit])

  if (entries.length === 0) return null

  return (
    <div data-promocean-leaderboard style={{ fontFamily: 'system-ui, sans-serif' }}>
      {title ? <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div> : null}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', fontSize: 12, color: '#555', padding: '4px 8px' }}>Rank</th>
            <th style={{ textAlign: 'left', fontSize: 12, color: '#555', padding: '4px 8px' }}>User</th>
            <th style={{ textAlign: 'right', fontSize: 12, color: '#555', padding: '4px 8px' }}>Points</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const isCurrentUser = entry.userId === userId
            return (
              <tr key={entry.userId}
                  data-promocean-current-user={isCurrentUser}
                  style={{
                    fontWeight: isCurrentUser ? 700 : 400,
                    background: isCurrentUser ? '#eef6ff' : undefined,
                  }}>
                <td style={{ padding: '4px 8px' }}>{entry.rank}</td>
                <td style={{ padding: '4px 8px' }}>{entry.userId}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{entry.points}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
