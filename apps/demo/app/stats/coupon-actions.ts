'use server'
import { Promocean, PromoceanApiError } from '@promocean/sdk'

// Server action module: constructs the sk (secret-key) SDK client fresh on
// every submit, same posture as StatsPage — reads process.env.PROMOCEAN_SECRET_KEY
// (never NEXT_PUBLIC_*) and never runs in the browser. `validateCoupon`/
// `redeemCoupon` both throw `PromoceanApiError` on a non-2xx response; we
// catch it here and fold it into the returned state so the client component
// has one JSON shape to render for both the success and error cases.
export type CouponCheckState = { result: unknown } | null

function client() {
  return new Promocean({
    publishableKey: '',
    secretKey: process.env.PROMOCEAN_SECRET_KEY!,
    baseUrl: process.env.PROMOCEAN_API_URL ?? process.env.NEXT_PUBLIC_PROMOCEAN_API!,
  })
}

export async function checkCoupon(_prev: CouponCheckState, formData: FormData): Promise<CouponCheckState> {
  const code = String(formData.get('code') ?? '').trim()
  const intent = formData.get('intent') === 'redeem' ? 'redeem' : 'validate'
  if (!code) {
    return { result: { error: { code: 'invalid_payload', message: 'Enter a coupon code.' } } }
  }
  try {
    const result = intent === 'redeem' ? await client().redeemCoupon(code) : await client().validateCoupon(code)
    return { result }
  } catch (err) {
    if (err instanceof PromoceanApiError) {
      return { result: { error: { code: err.code, message: err.message, status: err.status } } }
    }
    return { result: { error: { code: 'internal_error', message: err instanceof Error ? err.message : 'Request failed' } } }
  }
}
