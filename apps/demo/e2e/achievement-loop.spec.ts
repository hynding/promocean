import { expect, test } from '@playwright/test'

test('track → unlock toast → badge cabinet', async ({ page }) => {
  const user = `e2e-${Date.now()}`
  await page.goto(`/?user=${user}`)
  await page.getByRole('button', { name: 'Complete a lesson' }).click()
  await expect(page.getByRole('status')).toContainText('First Lesson')
  const cabinet = page.getByRole('list')
  await expect(cabinet.getByText('First Lesson', { exact: true })).toBeVisible()
  await expect(cabinet.getByText('1/10')).toBeVisible()
  await expect(cabinet.locator('[data-locked="false"]').getByText('First Lesson', { exact: true })).toBeVisible()
})
