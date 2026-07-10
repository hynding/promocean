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

test('switch user reactively re-identifies: leaderboard highlight leaves the old id, wallet/streak readouts reset — no remount', async ({ page }) => {
  const user = `e2e-switch-${Date.now()}`

  await page.goto(`/?user=${user}`)
  await page.getByRole('button', { name: 'Complete a lesson' }).click()
  await expect(page.getByRole('status')).toContainText('First Lesson')

  // Track a couple more lessons beyond the other specs' single click: this
  // suite runs its files concurrently against the same shared (window: all,
  // limit: 5) leaderboard, and several other specs each track exactly one
  // lesson_completed (also landing at EXPECTED_POINTS) — with enough of them
  // in flight at once, ties broken by userId would risk bumping this test's
  // row out of the fixed top-5 window. Earning strictly more points than the
  // single-lesson group avoids depending on tie-break/timing luck.
  const SWITCH_TEST_LESSONS_TRACKED = 3
  for (let i = 1; i < SWITCH_TEST_LESSONS_TRACKED; i++) {
    await page.getByRole('button', { name: 'Complete a lesson' }).click()
  }
  const switchTestExpectedPoints = LESSON_COMPLETED_RULE_POINTS * SWITCH_TEST_LESSONS_TRACKED + FIRST_LESSON_BONUS_POINTS
  await expect(page.getByTestId('wallet-balance')).toHaveText(String(switchTestExpectedPoints))
  await expect(page.getByTestId('streak-count')).toHaveText('1')

  // Reload once (same fetch-once-on-mount contract as the test above) so
  // <Leaderboard/> picks up this user's row before we switch away from it.
  await page.reload()
  const originalUserRow = page.locator('[data-promocean-leaderboard] tbody tr', { hasText: user })
  await expect(originalUserRow).toBeVisible()
  await expect(originalUserRow).toHaveAttribute('data-promocean-current-user', 'true')

  // Re-identify the *same* client to a fresh generated id via the "Switch
  // user" control — no page reload, no remount. The displayed id (read back
  // from the widget, since it's generated client-side and unpredictable)
  // must differ from the original.
  await page.getByRole('button', { name: 'Switch user' }).click()
  const newUserId = await page.getByTestId('current-user-id').textContent()
  expect(newUserId).toBeTruthy()
  expect(newUserId).not.toBe(user)

  // Reactive readouts: the wallet/streak readouts refetch for the new
  // (never-tracked) user and settle at zero — no reload was involved.
  await expect(page.getByTestId('wallet-balance')).toHaveText('0')
  await expect(page.getByTestId('streak-count')).toHaveText('0')

  // Reactive leaderboard highlight: the previously-highlighted row for the
  // old id is still rendered (the leaderboard itself only fetches once on
  // mount, unchanged) but is no longer marked as the current user — the
  // highlight tracks the identified user reactively, not a stale snapshot
  // taken at the leaderboard's own mount time. Since the fresh id has no
  // points yet, it isn't part of the already-fetched entries, so no row is
  // highlighted at all right now — that absence is itself proof the
  // highlight moved off the old id rather than staying stuck on it.
  await expect(originalUserRow).toHaveAttribute('data-promocean-current-user', 'false')
  await expect(page.locator('[data-promocean-current-user="true"]')).toHaveCount(0)
})
