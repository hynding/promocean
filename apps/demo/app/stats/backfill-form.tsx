'use client'
import { useActionState } from 'react'
import { runBackfill, type BackfillState } from './backfill-actions'

// Operator-facing form/action pair, mirroring CouponCheckForm exactly: the sk
// (secret-key) SDK client stays entirely server-side (backfill-actions.ts); this
// client component only ever sees the JSON result the action returns (the backfill
// summary on success, or an error envelope on failure — same shape either way).
export function BackfillForm() {
  const [state, formAction, pending] = useActionState<BackfillState, FormData>(runBackfill, null)

  return (
    <section>
      <h2>Achievement backfill</h2>
      <form action={formAction} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          name="achievementId"
          placeholder="Achievement id"
          data-testid="backfill-achievement-id-input"
          style={{ padding: 4, flex: 1 }}
        />
        <button type="submit" disabled={pending} data-testid="backfill-submit-button">
          Backfill
        </button>
      </form>
      {state ? (
        <pre data-testid="backfill-result" style={{ background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
          {JSON.stringify(state.result, null, 2)}
        </pre>
      ) : null}
    </section>
  )
}
