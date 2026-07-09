import { expect, test } from '@playwright/test'

// API base + pk/sk match the seeded demo project (apps/cms/src/index.ts) and the
// docker-compose.yml defaults — see rewards-loop.spec.ts for the same constants.
const API_BASE = 'http://localhost:3001'
const PUBLISHABLE_KEY = 'pk_test_demo_1234567890abcdef'
const SECRET_KEY = 'sk_test_demo_1234567890abcdef'

// Weekly recurrence has a fixed 7-day interval (apps/core/src/timed-events.ts
// INTERVAL_MS.weekly), so the occurrence AFTER the one reported in startsAt/endsAt
// always starts exactly 7 days after this one's startsAt.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

test.describe('campaign lifecycle', () => {
  test('live feed carries the recurring Weekly Happy Hour with a consistent nextOccurrenceStartsAt', async ({ page, request }) => {
    const liveRes = await request.get(`${API_BASE}/v1/events/live`, {
      headers: { authorization: `Bearer ${PUBLISHABLE_KEY}` },
    })
    expect(liveRes.ok()).toBeTruthy()
    const { events } = await liveRes.json() as {
      events: Array<{
        eventId: string; name: string; state: string; startsAt: string; endsAt: string
        recurrence: string; nextOccurrenceStartsAt: string | null
      }>
    }

    const happyHour = events.find((e) => e.name === 'Weekly Happy Hour')
    expect(happyHour).toBeDefined()
    expect(happyHour!.recurrence).toBe('weekly')
    // Current-or-next occurrence window: a real window, not the definition's own bounds.
    expect(['scheduled', 'live', 'ending_soon']).toContain(happyHour!.state)
    const startsAtMs = new Date(happyHour!.startsAt).getTime()
    const endsAtMs = new Date(happyHour!.endsAt).getTime()
    expect(endsAtMs).toBeGreaterThan(startsAtMs)

    // recurrenceEndsAt is seeded null, so there's always a next occurrence.
    expect(happyHour!.nextOccurrenceStartsAt).not.toBeNull()
    expect(new Date(happyHour!.nextOccurrenceStartsAt!).getTime()).toBe(startsAtMs + SEVEN_DAYS_MS)

    // The demo's <EventCountdown/> section renders it alongside the one-shot event.
    const user = `e2e-lifecycle-${Date.now()}`
    await page.goto(`/?user=${user}`)
    await expect(page.locator('[data-promocean-event]', { hasText: 'Weekly Happy Hour' })).toBeVisible()
  })

  test('backfill is idempotent after a live unlock, and round-trips through the demo form', async ({ page, request }) => {
    const user = `e2e-backfill-${Date.now()}`
    await page.goto(`/?user=${user}`)

    // A single lesson_completed event unlocks the seeded target-1 "First Lesson"
    // achievement live (see engagement-loop.spec.ts for the same seed math).
    await page.getByRole('button', { name: 'Complete a lesson' }).click()
    await expect(page.getByRole('status')).toContainText('First Lesson')

    const achievementsRes = await request.get(`${API_BASE}/v1/users/${encodeURIComponent(user)}/achievements`, {
      headers: { authorization: `Bearer ${PUBLISHABLE_KEY}` },
    })
    expect(achievementsRes.ok()).toBeTruthy()
    const { achievements } = await achievementsRes.json() as {
      achievements: Array<{ achievementId: string; name: string; unlockedAt: string | null }>
    }
    const firstLesson = achievements.find((a) => a.name === 'First Lesson')
    expect(firstLesson).toBeDefined()
    expect(firstLesson!.unlockedAt).not.toBeNull()

    // Retroactive backfill of an achievement this user already unlocked LIVE grants nothing new
    // — this proves the endpoint works and is idempotent. TRUE retroactivity (a definition
    // created AFTER events already existed) is covered by adapter-db/api tests plus the DoD's
    // hand-verified live backfill against a mid-flight-created achievement.
    const backfillRes = await request.post(
      `${API_BASE}/v1/achievements/${encodeURIComponent(firstLesson!.achievementId)}/backfill`,
      { headers: { authorization: `Bearer ${SECRET_KEY}` } },
    )
    expect(backfillRes.ok()).toBeTruthy()
    const summary = await backfillRes.json() as {
      usersEvaluated: number; progressRaised: number; unlocksGranted: number; pointsAwarded: number
    }
    expect(summary.usersEvaluated).toBeGreaterThanOrEqual(1)
    expect(summary.unlocksGranted).toBe(0)
    expect(summary.pointsAwarded).toBe(0)

    // The demo's operator-facing backfill form (stats page) round-trips the same call.
    await page.goto('/stats')
    await page.getByTestId('backfill-achievement-id-input').fill(firstLesson!.achievementId)
    await page.getByTestId('backfill-submit-button').click()
    const result = page.getByTestId('backfill-result')
    await expect(result).toContainText('"usersEvaluated"')
    await expect(result).toContainText('"unlocksGranted": 0')
    await expect(result).toContainText('"pointsAwarded": 0')
  })
})
