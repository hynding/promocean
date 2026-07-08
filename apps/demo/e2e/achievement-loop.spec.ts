import { expect, test } from '@playwright/test'

test('track → unlock toast → badge cabinet → stats', async ({ page }) => {
  const user = `e2e-${Date.now()}`
  let unlockedAchievementId: string | undefined

  page.on('response', (res) => {
    if (res.request().method() !== 'POST' || !res.url().endsWith('/v1/events') || !res.ok()) return
    res.json()
      .then((body: { unlocks?: Array<{ achievementId: string; name: string }> }) => {
        const unlock = body.unlocks?.find((u) => u.name === 'First Lesson')
        if (unlock) unlockedAchievementId = unlock.achievementId
      })
      .catch(() => {})
  })

  await page.goto(`/?user=${user}`)
  await page.getByRole('button', { name: 'Complete a lesson' }).click()
  await expect(page.getByRole('status')).toContainText('First Lesson')
  const cabinet = page.getByRole('list')
  await expect(cabinet.getByText('First Lesson', { exact: true })).toBeVisible()
  // seeded "Double Progress Weekend" (multiplier 2) is live — one lesson counts double
  await expect(cabinet.getByText('2/10')).toBeVisible()
  await expect(cabinet.locator('[data-locked="false"]').getByText('First Lesson', { exact: true })).toBeVisible()

  await expect.poll(() => unlockedAchievementId).toBeTruthy()

  await page.goto('/stats')
  const totalEvents = Number(await page.getByTestId('stats-total-events').innerText())
  expect(totalEvents).toBeGreaterThanOrEqual(1)

  const unlocksCell = page.getByTestId(`stats-achievement-unlocks-${unlockedAchievementId}`)
  await expect(unlocksCell).toBeVisible()
  const unlockCount = Number(await unlocksCell.innerText())
  expect(unlockCount).toBeGreaterThanOrEqual(1)
})
