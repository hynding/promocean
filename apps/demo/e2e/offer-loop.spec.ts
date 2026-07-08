import { expect, test } from '@playwright/test'

test('offer renders, dismisses, and stays dismissed across reload', async ({ page }) => {
  const user = `e2e-offer-${Date.now()}`
  const impressionRequests: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/v1\/offers\/[^/]+\/impression$/.test(req.url())) {
      impressionRequests.push(req.url())
    }
  })

  await page.goto(`/?user=${user}`)
  const banner = page.locator('[data-promocean-placement="homepage-banner"]')
  await expect(banner.getByText('Welcome to Promocean')).toBeVisible()
  await expect(banner.getByRole('link', { name: 'Learn more' })).toBeVisible()

  // The offer actually rendered (not dismissed), so exactly one impression
  // beacon fires for it.
  await expect.poll(() => impressionRequests.length).toBe(1)

  await banner.getByRole('button', { name: 'Dismiss offer' }).click()
  await expect(banner).toHaveCount(0)

  impressionRequests.length = 0
  await page.reload()
  await expect(page.locator('[data-promocean-placement="homepage-banner"]')).toHaveCount(0)
  // The offer is dismissed, so the widget never renders it and never fires
  // the impression beacon — wait for the network to settle, then assert none fired.
  await page.waitForLoadState('networkidle')
  expect(impressionRequests).toHaveLength(0)
})
