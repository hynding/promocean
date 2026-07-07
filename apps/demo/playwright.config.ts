import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3002' },
  webServer: { command: 'pnpm dev', url: 'http://localhost:3002', reuseExistingServer: true, timeout: 120_000 },
})
