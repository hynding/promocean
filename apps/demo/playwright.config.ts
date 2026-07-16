import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3002' },
  webServer: { command: 'pnpm dev', url: 'http://localhost:3002', reuseExistingServer: true, timeout: 120_000 },
  // config-sync.spec.ts mutates shared demo-project config (the seeded first_lesson
  // achievement's pointsValue, plus a new achievement) via the config-plane import
  // endpoint — every other spec's expected point totals assume the seeded values stay
  // constant. `dependencies` makes Playwright run the "default" project to completion
  // before "config-sync" starts, so the mutation never overlaps with a concurrent
  // worker running one of the other specs (config-sync also restores the original
  // values itself once done, but that only protects a *later*, separate suite run —
  // it can't retroactively fix an in-flight race with concurrent tests).
  projects: [
    { name: 'default', testIgnore: '**/config-sync.spec.ts' },
    { name: 'config-sync', testMatch: '**/config-sync.spec.ts', dependencies: ['default'] },
  ],
})
