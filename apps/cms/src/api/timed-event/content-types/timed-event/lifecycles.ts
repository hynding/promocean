import { errors } from '@strapi/utils'

const MS_PER_DAY = 86_400_000
const INTERVAL_MS: Record<string, number> = {
  daily: MS_PER_DAY,
  weekly: 7 * MS_PER_DAY,
  monthly: 28 * MS_PER_DAY,
}

function fail(message: string): never {
  throw new errors.ValidationError(message)
}

// Merge incoming (possibly partial, on update) data over the current row so
// cross-field validation always sees the resulting full record.
async function loadCurrent(event: any): Promise<Record<string, any>> {
  const where = event.params.where
  if (!where) return {}
  const existing = await strapi.db.query('api::timed-event.timed-event').findOne({ where })
  return existing ?? {}
}

function validate(merged: Record<string, any>) {
  const startsAt = merged.startsAt
  const endsAt = merged.endsAt
  const startsAtMs = startsAt != null ? new Date(startsAt).getTime() : null
  const endsAtMs = endsAt != null ? new Date(endsAt).getTime() : null

  if (startsAtMs != null && endsAtMs != null) {
    if (!(endsAtMs > startsAtMs)) {
      fail('endsAt must be after startsAt')
    }
  }

  const recurrence = merged.recurrence ?? 'none'
  if (recurrence !== 'none') {
    const intervalMs = INTERVAL_MS[recurrence]
    if (intervalMs != null && startsAtMs != null && endsAtMs != null) {
      if (endsAtMs - startsAtMs > intervalMs) {
        fail(`endsAt - startsAt must be at most ${intervalMs}ms for recurrence "${recurrence}"`)
      }
    }

    const recurrenceEndsAt = merged.recurrenceEndsAt
    if (recurrenceEndsAt != null && startsAtMs != null) {
      if (!(new Date(recurrenceEndsAt).getTime() > startsAtMs)) {
        fail('recurrenceEndsAt must be after startsAt')
      }
    }
  }
}

export default {
  async beforeCreate(event: any) {
    const merged = { ...event.params.data }
    validate(merged)
  },
  async beforeUpdate(event: any) {
    const current = await loadCurrent(event)
    const merged = { ...current, ...event.params.data }
    validate(merged)
  },
}
