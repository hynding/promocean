'use server'
import { Promocean, PromoceanApiError } from '@promocean/sdk'

// Server action module: same posture as coupon-actions.ts — constructs the sk
// (secret-key) SDK client fresh on every submit from process.env.PROMOCEAN_SECRET_KEY
// (never NEXT_PUBLIC_*), never runs in the browser. `backfillAchievement()` throws
// `PromoceanApiError` on a non-2xx response (403 no-secret-key / 404 unknown id); we
// catch it here and fold it into the returned state so the client component has one
// JSON shape to render for both the success summary and the error envelope.
export type BackfillState = { result: unknown } | null

function client() {
  return new Promocean({
    publishableKey: '',
    secretKey: process.env.PROMOCEAN_SECRET_KEY!,
    baseUrl: process.env.PROMOCEAN_API_URL ?? process.env.NEXT_PUBLIC_PROMOCEAN_API!,
  })
}

export async function runBackfill(_prev: BackfillState, formData: FormData): Promise<BackfillState> {
  const achievementId = String(formData.get('achievementId') ?? '').trim()
  if (!achievementId) {
    return { result: { error: { code: 'invalid_payload', message: 'Enter an achievement id.' } } }
  }
  try {
    const result = await client().backfillAchievement(achievementId)
    return { result }
  } catch (err) {
    if (err instanceof PromoceanApiError) {
      return { result: { error: { code: err.code, message: err.message, status: err.status } } }
    }
    return { result: { error: { code: 'internal_error', message: err instanceof Error ? err.message : 'Request failed' } } }
  }
}
