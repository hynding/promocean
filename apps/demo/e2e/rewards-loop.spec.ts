import { expect, test } from '@playwright/test'

// API base + secret key match the seeded demo project (apps/cms/src/index.ts) and the
// docker-compose.yml default `PROMOCEAN_SECRET_KEY` — host port 3001 is the same one the
// root README's Quickstart points at for `GET /v1/openapi.json`.
const API_BASE = 'http://localhost:3001'
const SECRET_KEY = 'sk_test_demo_1234567890abcdef'

// Seed math (apps/cms/src/index.ts): pointRules.lesson_completed = 10; achievements
// "First Lesson" (eventType lesson_completed, targetCount 1, pointsValue 50) and
// "Getting Started" (eventType lesson_completed, targetCount 10, pointsValue 100); the
// seeded "Double Progress Weekend" timed event (multiplier 2) is always live (its window is
// computed relative to seed time). Ten lesson_completed events therefore earn:
//   rule points:        10 * 10 = 100
//   "First Lesson" bonus (unlocks on event #1, progress 1*2=2 >= target 1):      +50
//   "Getting Started" bonus (unlocks by event #5, progress 5*2=10 >= target 10, awarded once): +100
const LESSON_RULE_POINTS = 10
const LESSONS_TRACKED = 10
const FIRST_LESSON_BONUS = 50
const GETTING_STARTED_BONUS = 100
const EARNED_BEFORE_CLAIM = LESSON_RULE_POINTS * LESSONS_TRACKED + FIRST_LESSON_BONUS + GETTING_STARTED_BONUS // 250
const DEMO_DISCOUNT_PRICE = 100
const BALANCE_AFTER_CLAIM = EARNED_BEFORE_CLAIM - DEMO_DISCOUNT_PRICE // 150

test('claim free + priced rewards, coupon validate/redeem/re-redeem, erasure counts coupons', async ({ page, request }) => {
  const user = `e2e-reward-${Date.now()}`
  await page.goto(`/?user=${user}`)

  const rewardsStore = page.locator('[data-promocean-rewards]')
  const welcome = page.locator('[data-promocean-reward="welcome_coupon"]')
  const demoDiscount = page.locator('[data-promocean-reward="demo_discount"]')

  // Fresh user: welcome_coupon is free (perUserLimit 1) — claim succeeds, static code shows
  // inline, and the wallet balance (re-fetched by the widget after claim) is unchanged at 0.
  await expect(welcome.getByText('Free', { exact: true })).toBeVisible()
  await welcome.getByRole('button', { name: 'Claim' }).click()
  await expect(welcome.locator('code')).toHaveText('WELCOME10')
  await expect(rewardsStore).toContainText('Balance: 0 pts')

  // demo_discount costs 100 points; balance is still 0, so the claim button is disabled and
  // reads "Not enough points" — this is a UI-computed disabled state (no claim attempt fires).
  await expect(demoDiscount.getByRole('button', { name: 'Not enough points' })).toBeDisabled()

  // Earn points: track lesson_completed ten times via the demo's own button.
  const lessonButton = page.getByRole('button', { name: 'Complete a lesson' })
  for (let i = 0; i < LESSONS_TRACKED; i++) {
    await lessonButton.click()
  }
  await expect(page.getByTestId('wallet-balance')).toHaveText(String(EARNED_BEFORE_CLAIM))

  // The rewards store remounts (and re-fetches) after each tracked event, so it now reflects
  // the earned balance and re-enables the demo_discount claim button.
  await expect(rewardsStore).toContainText(`Balance: ${EARNED_BEFORE_CLAIM} pts`)
  await expect(demoDiscount.getByRole('button', { name: 'Claim' })).toBeEnabled()
  await demoDiscount.getByRole('button', { name: 'Claim' }).click()

  const claimedCode = await demoDiscount.locator('code').innerText()
  expect(claimedCode).toMatch(/^DEMO-[A-HJ-NP-Z2-9]{10}$/)
  await expect(rewardsStore).toContainText(`Balance: ${BALANCE_AFTER_CLAIM} pts`)

  // sk-only coupon check, driven through the /stats page's server-action form.
  await page.goto('/stats')
  const codeInput = page.getByTestId('coupon-code-input')
  const result = page.getByTestId('coupon-check-result')

  await codeInput.fill(claimedCode)
  await page.getByTestId('coupon-validate-button').click()
  await expect(result).toContainText('"valid": true')
  await expect(result).toContainText('"status": "claimed"')
  await expect(result).toContainText(`"rewardSlug": "demo_discount"`)

  await codeInput.fill(claimedCode)
  await page.getByTestId('coupon-redeem-button').click()
  await expect(result).toContainText('"redeemed": true')
  await expect(result).toContainText(`"rewardSlug": "demo_discount"`)

  await codeInput.fill(claimedCode)
  await page.getByTestId('coupon-redeem-button').click()
  await expect(result).toContainText('"already_redeemed"')

  // Erasure: DELETE /v1/users/:id (sk only) reports counts, including coupons — this user
  // claimed two coupons (welcome_coupon + demo_discount), so coupons >= 2.
  const eraseRes = await request.delete(`${API_BASE}/v1/users/${encodeURIComponent(user)}`, {
    headers: { authorization: `Bearer ${SECRET_KEY}` },
  })
  expect(eraseRes.ok()).toBeTruthy()
  const eraseBody = await eraseRes.json() as { erased: boolean; counts: { coupons: number } }
  expect(eraseBody.erased).toBe(true)
  expect(eraseBody.counts.coupons).toBeGreaterThanOrEqual(2)
})
