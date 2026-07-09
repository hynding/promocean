import { expect, test } from '@playwright/test'

// Expected points are computed from the seeded values in apps/cms/src/index.ts, not asserted
// as magic numbers: pointRules.lesson_completed (10) + the "First Lesson" achievement's
// pointsValue (50, targetCount 1 — unlocked by a single lesson_completed event even under the
// seeded "Double Progress Weekend" x2 multiplier, which only doubles achievement progress
// deltas, never point awards). "Getting Started" (targetCount 10) is not reached by one event,
// so it contributes no bonus here.
const LESSON_COMPLETED_RULE_POINTS = 10
const FIRST_LESSON_BONUS_POINTS = 50
const EXPECTED_POINTS = LESSON_COMPLETED_RULE_POINTS + FIRST_LESSON_BONUS_POINTS

test('track → wallet balance + streak readouts → leaderboard row', async ({ page }) => {
  const user = `e2e-engage-${Date.now()}`

  await page.goto(`/?user=${user}`)
  await page.getByRole('button', { name: 'Complete a lesson' }).click()
  await expect(page.getByRole('status')).toContainText('First Lesson')

  await expect(page.getByTestId('wallet-balance')).toHaveText(String(EXPECTED_POINTS))
  await expect(page.getByTestId('streak-count')).toHaveText('1')

  // <Leaderboard/> only fetches once on mount (no live-refresh subscription, unlike
  // <BadgeCabinet/>'s onUnlock hook) — reload to get a fresh mount that picks up this
  // track's points before asserting the leaderboard row.
  await page.reload()
  await expect(page.getByTestId('wallet-balance')).toHaveText(String(EXPECTED_POINTS))
  await expect(page.getByTestId('streak-count')).toHaveText('1')

  const leaderboardRow = page.locator('[data-promocean-leaderboard] tbody tr', { hasText: user })
  await expect(leaderboardRow).toBeVisible()
  await expect(leaderboardRow).toContainText(String(EXPECTED_POINTS))
})
