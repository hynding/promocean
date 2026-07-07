import { expect, test } from '@playwright/test'

test('live event shows countdown and doubles progress', async ({ page }) => {
  const user = `e2e-event-${Date.now()}`
  await page.goto(`/?user=${user}`)
  const event = page.locator('[data-promocean-event]')
  await expect(event.getByText('Double Progress Weekend')).toBeVisible()
  await expect(event.getByText(/Ends in/)).toBeVisible()
  await page.getByRole('button', { name: 'Complete a lesson' }).click()
  await expect(page.getByRole('status')).toContainText('First Lesson')
  await expect(page.getByText('2/10')).toBeVisible()
})
