'use client'
import { useActionState } from 'react'
import { checkCoupon, type CouponCheckState } from './coupon-actions'

// A single form/action, two submit buttons distinguished by the standard
// `name`/`value` pair on each `<button type="submit">` — the server action
// reads `formData.get('intent')` to pick validate vs redeem. This keeps the
// sk (secret-key) SDK client entirely server-side (coupon-actions.ts);
// the client component below only ever sees the JSON result it returns.
export function CouponCheckForm() {
  const [state, formAction, pending] = useActionState<CouponCheckState, FormData>(checkCoupon, null)

  return (
    <section>
      <h2>Coupon check</h2>
      <form action={formAction} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          name="code"
          placeholder="Coupon code"
          data-testid="coupon-code-input"
          style={{ padding: 4, flex: 1 }}
        />
        <button type="submit" name="intent" value="validate" disabled={pending} data-testid="coupon-validate-button">
          Validate
        </button>
        <button type="submit" name="intent" value="redeem" disabled={pending} data-testid="coupon-redeem-button">
          Redeem
        </button>
      </form>
      {state ? (
        <pre data-testid="coupon-check-result" style={{ background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
          {JSON.stringify(state.result, null, 2)}
        </pre>
      ) : null}
    </section>
  )
}
