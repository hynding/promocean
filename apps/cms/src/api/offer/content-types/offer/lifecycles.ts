import { errors } from '@strapi/utils'

const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/

function fail(message: string): never {
  throw new errors.ValidationError(message)
}

// Merge incoming (possibly partial, on update) data over the current row so
// cross-field validation always sees the resulting full record.
async function loadCurrent(event: any): Promise<Record<string, any>> {
  const where = event.params.where
  if (!where) return {}
  const existing = await strapi.db.query('api::offer.offer').findOne({ where, populate: ['project'] })
  return existing ?? {}
}

function validate(merged: Record<string, any>) {
  const slug = merged.slug
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    fail(`slug must match ${SLUG_PATTERN} (got: ${JSON.stringify(slug)})`)
  }
}

// Relation values arrive in whatever shape the caller used: a raw internal
// id, a documentId string, or a { connect/set: [...] } mutation descriptor
// (Content Manager / entityService all take slightly different shapes).
// Resolve any of them down to the project's internal numeric id so it can be
// compared/queried at this (db-level) lifecycle layer.
async function resolveProjectId(raw: any): Promise<number | null> {
  if (raw == null) return null
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const byDocumentId = await strapi.db.query('api::project.project').findOne({ where: { documentId: raw } })
    if (byDocumentId) return byDocumentId.id
    const asNumber = Number(raw)
    return Number.isFinite(asNumber) ? asNumber : null
  }
  if (typeof raw === 'object') {
    const list = raw.connect ?? raw.set
    if (Array.isArray(list) && list.length > 0) {
      const first = list[0]
      return resolveProjectId(typeof first === 'object' ? first.id ?? first.documentId : first)
    }
    if (raw.id != null) return resolveProjectId(raw.id)
    if (raw.documentId != null) return resolveProjectId(raw.documentId)
  }
  return null
}

async function checkSlugUnique(event: any, merged: Record<string, any>) {
  const slug = merged.slug
  const projectId = await resolveProjectId(merged.project)
  if (!slug || projectId == null) return // no project set yet — nothing to scope uniqueness by
  const where: Record<string, any> = { slug, project: projectId }
  const existingId = event.params.where?.id
  if (existingId != null) {
    where.id = { $ne: existingId }
  }
  const count = await strapi.db.query('api::offer.offer').count({ where })
  if (count > 0) {
    fail(`slug "${slug}" is already in use for this project`)
  }
}

export default {
  async beforeCreate(event: any) {
    const merged = { ...event.params.data }
    validate(merged)
    await checkSlugUnique(event, merged)
  },
  async beforeUpdate(event: any) {
    const current = await loadCurrent(event)
    const merged = { ...current, ...event.params.data }
    validate(merged)
    await checkSlugUnique(event, merged)
  },
}
