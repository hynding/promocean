import type { ImportResponse } from '@promocean/contracts'

type Plan = ImportResponse['plan']
type TypePlan = Plan[keyof Plan]

const TYPE_ORDER: Array<keyof Plan> = ['project', 'placements', 'achievements', 'timedEvents', 'offers', 'rewards']
const LABELS: Record<keyof Plan, string> = {
  project: 'project',
  placements: 'placements',
  achievements: 'achievements',
  timedEvents: 'timedEvents',
  offers: 'offers',
  rewards: 'rewards',
}

/** True if any type bucket in the plan has a non-empty create/update/delete list. */
export function planHasChanges(plan: Plan): boolean {
  return TYPE_ORDER.some((type) => {
    const bucket = plan[type] as TypePlan
    return bucket.creates.length > 0 || bucket.updates.length > 0 || bucket.deletes.length > 0
  })
}

function renderBucket(label: string, bucket: TypePlan): string[] {
  const lines: string[] = []
  lines.push(
    `  ${label}: +${bucket.creates.length} created, ~${bucket.updates.length} updated, ` +
      `-${bucket.deletes.length} deleted, ${bucket.unchanged} unchanged`,
  )
  if (bucket.creates.length > 0) lines.push(`    creates: ${bucket.creates.join(', ')}`)
  if (bucket.updates.length > 0) lines.push(`    updates: ${bucket.updates.join(', ')}`)
  if (bucket.deletes.length > 0) lines.push(`    deletes: ${bucket.deletes.join(', ')}`)
  return lines
}

/** Render an ImportResponse as a human-readable plan table. Error (422) info is rendered first and prominently. */
export function renderPlan(response: ImportResponse): string {
  const lines: string[] = []

  if (response.error) {
    lines.push('IMPORT FAILED')
    lines.push(`  stage:   ${response.error.stage}`)
    lines.push(`  message: ${response.error.message}`)
    lines.push('')
  }

  lines.push(response.applied ? 'Applied plan:' : 'Dry-run plan (no changes applied):')
  for (const type of TYPE_ORDER) {
    lines.push(...renderBucket(LABELS[type], response.plan[type] as TypePlan))
  }

  return lines.join('\n')
}
