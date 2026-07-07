import type { TimedEventDefinition, TimedEventState } from './types.js'

export function timedEventState(event: TimedEventDefinition, now: Date): TimedEventState {
  if (!event.enabled) return 'draft'
  if (now < event.startsAt) return 'scheduled'
  if (now >= event.endsAt) return 'ended'
  const msLeft = event.endsAt.getTime() - now.getTime()
  return msLeft <= event.endingSoonMinutes * 60_000 ? 'ending_soon' : 'live'
}

const isActive = (s: TimedEventState) => s === 'live' || s === 'ending_soon'

export function activeMultiplier(events: TimedEventDefinition[], now: Date): number {
  let max = 1
  for (const e of events) if (isActive(timedEventState(e, now)) && e.multiplier > max) max = e.multiplier
  return max
}

export function activeEventIds(events: TimedEventDefinition[], now: Date): Set<string> {
  const ids = new Set<string>()
  for (const e of events) if (isActive(timedEventState(e, now))) ids.add(e.id)
  return ids
}
