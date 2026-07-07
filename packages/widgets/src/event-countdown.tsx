import { useEffect, useState } from 'react'
import type { LiveTimedEvent } from '@promocean/contracts'
import { usePromocean } from './provider.js'

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${h}h ${m}m ${s}s`
}

export function EventCountdown() {
  const client = usePromocean()
  const [events, setEvents] = useState<LiveTimedEvent[]>([])
  const [, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    client.getLiveEvents()
      .then((es) => { if (!cancelled) setEvents(es) })
      .catch(() => {}) // fail silent-to-empty
    return () => { cancelled = true }
  }, [client])

  useEffect(() => {
    const id = setInterval(() => { setTick((t) => t + 1) }, 1000)
    return () => { clearInterval(id) }
  }, [])

  if (events.length === 0) return null

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {events.map((event) => {
        const isScheduled = event.state === 'scheduled'
        const targetDate = isScheduled ? new Date(event.startsAt) : new Date(event.endsAt)
        const remainingMs = targetDate.getTime() - Date.now()
        const label = isScheduled ? 'Starts in' : 'Ends in'
        return (
          <div key={event.eventId} data-promocean-event={event.eventId}
               style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>{event.name}</div>
            <div style={{ fontSize: 14, color: '#555', marginTop: 4 }}>
              {label} {formatDuration(remainingMs)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
