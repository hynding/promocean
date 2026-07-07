import { expect, test } from '@playwright/test'

test('offer renders, dismisses, and stays dismissed across reload', async ({ page }) => {
  const user = `e2e-offer-${Date.now()}`
  await page.goto(`/?user=${user}`)
  const banner = page.locator('[data-promocean-placement="homepage-banner"]')
  await expect(banner.getByText('Welcome to Promocean')).toBeVisible()
  await expect(banner.getByRole('link', { name: 'Learn more' })).toBeVisible()
  await banner.getByRole('button', { name: 'Dismiss offer' }).click()
  await expect(banner).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-promocean-placement="homepage-banner"]')).toHaveCount(0)
})
