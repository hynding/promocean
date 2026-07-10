import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Reward, UnlockPayload } from '@promocean/contracts'
import { PromoceanApiError } from '@promocean/sdk'
import { BadgeCabinet, EventCountdown, Leaderboard, Placement, PromoceanProvider, RewardsStore, UnlockToast, usePromoceanUser } from '../src/index.js'

// RTL's automatic afterEach cleanup only registers when `afterEach` exists as a
// global; this project's vitest config doesn't set `test.globals: true`, so
// DOM from one test otherwise leaks into the next within this file (collides
// once two Placement tests render the same offer content). Clean up explicitly.
afterEach(cleanup)

function fakeClient(achievements: unknown[] = [], offer: unknown = null) {
  const listeners = new Set<(u: UnlockPayload) => void>()
  const userChangeListeners = new Set<(u: string | undefined) => void>()
  const client: any = {
    onUnlock: (cb: (u: UnlockPayload) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
    onUserChange: (cb: (u: string | undefined) => void) => { userChangeListeners.add(cb); return () => userChangeListeners.delete(cb) },
    getAchievements: vi.fn().mockResolvedValue(achievements),
    getPlacementOffer: vi.fn().mockResolvedValue(offer),
    getLiveEvents: vi.fn().mockResolvedValue([]),
    clickOffer: vi.fn().mockResolvedValue(undefined),
    recordImpression: vi.fn().mockResolvedValue(undefined),
    dismissOffer: vi.fn(),
    isOfferDismissed: vi.fn().mockReturnValue(false),
    getLeaderboard: vi.fn().mockResolvedValue({ window: 'all', entries: [] }),
    listRewards: vi.fn().mockResolvedValue([]),
    getWallet: vi.fn().mockResolvedValue({ balance: 0, recent: [] }),
    claimReward: vi.fn().mockResolvedValue({ code: 'CODE-1', rewardSlug: 'r1', claimedAt: '2026-07-06T00:00:00.000Z', pointsSpent: 0 }),
    currentUserId: undefined as string | undefined,
  }
  return {
    client,
    emit: (u: UnlockPayload) => listeners.forEach((cb) => cb(u)),
    // Fires the fake's own onUserChange listeners AND mirrors client.currentUserId,
    // mimicking the real SDK's identify() (including its same-id no-op guard) so
    // provider tests can drive identity changes the same way the real client would.
    identify: (userId: string | undefined) => {
      if (userId === client.currentUserId) return
      client.currentUserId = userId
      userChangeListeners.forEach((cb) => cb(userId))
    },
    // Invokes registered onUserChange listeners DIRECTLY, bypassing identify()'s
    // own same-id guard. Lets tests drive the provider's listener callback
    // (setUserId) with an identical id, so a same-id "no-op" test actually
    // exercises the provider's own state bail-out rather than the fake's guard.
    emitUserChange: (userId: string | undefined) => {
      userChangeListeners.forEach((cb) => cb(userId))
    },
    userChangeListenerCount: () => userChangeListeners.size,
  }
}

function UserIdProbe({ onRender }: { onRender: () => void }) {
  usePromoceanUser()
  onRender()
  return null
}

describe('PromoceanProvider', () => {
  it('a same-id user-change notify is a no-op (no consumer re-render); a different-id notify propagates', async () => {
    const { client, emitUserChange } = fakeClient()
    client.currentUserId = 'u1'
    const onRender = vi.fn()
    render(<PromoceanProvider client={client}><UserIdProbe onRender={onRender} /></PromoceanProvider>)
    const countAfterMount = onRender.mock.calls.length

    // Bypasses the fake's own identify() same-id guard entirely — this proves
    // the provider itself (via useState's identical-primitive bail-out) does
    // not re-render consumers on a same-id notify, not merely that the mock
    // never called the listener.
    act(() => emitUserChange('u1'))
    expect(onRender.mock.calls.length).toBe(countAfterMount)

    // Discriminating control: a genuinely different id DOES propagate, proving
    // the probe is capable of detecting a re-render and the prior assertion
    // wasn't vacuously true.
    act(() => emitUserChange('u2'))
    expect(onRender.mock.calls.length).toBe(countAfterMount + 1)
  })
})

describe('UnlockToast', () => {
  it('renders an unlock in a polite live region and auto-dismisses', async () => {
    vi.useFakeTimers()
    try {
      const { client, emit } = fakeClient()
      render(<PromoceanProvider client={client}><UnlockToast durationMs={1000} /></PromoceanProvider>)
      act(() => emit({ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }))
      expect(screen.getByRole('status')).toHaveTextContent('First Lesson')
      act(() => { vi.advanceTimersByTime(1100) })
      expect(screen.getByRole('status')).not.toHaveTextContent('First Lesson')
    } finally {
      vi.useRealTimers()
    }
  })

  it('two unlocks sharing the same achievementId+unlockedAt millisecond render as two distinct toasts, and each auto-dismisses independently by id', async () => {
    vi.useFakeTimers()
    try {
      const { client, emit } = fakeClient()
      render(<PromoceanProvider client={client}><UnlockToast durationMs={1000} /></PromoceanProvider>)
      const duplicate = { achievementId: 'a1', name: 'Duplicate Unlock', unlockedAt: '2026-07-06T00:00:00.000Z' }
      // Same achievementId+unlockedAt content, but emitted at different fake-clock
      // times — this is the scenario a content-derived key collides on. Staggering
      // the emits (rather than firing both at once) also lets us drive each
      // toast's auto-dismiss independently below.
      act(() => emit(duplicate))
      act(() => { vi.advanceTimersByTime(400) })
      act(() => emit(duplicate))
      const status = screen.getByRole('status')
      expect(status.children).toHaveLength(2)
      // The first toast's 1000ms timer elapses (400 + 600 = 1000ms since it fired);
      // the second toast, emitted 400ms later, still has 400ms left on its own timer.
      act(() => { vi.advanceTimersByTime(600) })
      expect(status.children).toHaveLength(1)
      // The remaining toast is the second one, still mid-flight.
      act(() => { vi.advanceTimersByTime(500) })
      expect(status.children).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('BadgeCabinet', () => {
  it('renders badges with progress and locked state', async () => {
    const { client } = fakeClient([
      { achievementId: 'a1', name: 'First Lesson', description: null, artworkUrl: null, current: 1, target: 1, unlockedAt: '2026-07-06T00:00:00.000Z' },
      { achievementId: 'a2', name: 'Getting Started', description: null, artworkUrl: null, current: 3, target: 10, unlockedAt: null },
    ])
    render(<PromoceanProvider client={client}><BadgeCabinet /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('First Lesson')).toBeDefined())
    expect(screen.getByText('3/10')).toBeDefined()
    expect(screen.getByText('Getting Started').closest('[data-locked]')?.getAttribute('data-locked')).toBe('true')
    expect(screen.getByText('First Lesson').closest('[data-locked]')?.getAttribute('data-locked')).toBe('false')
  })
  it('refetches when an unlock fires', async () => {
    const { client, emit } = fakeClient([])
    render(<PromoceanProvider client={client}><BadgeCabinet /></PromoceanProvider>)
    await waitFor(() => expect(client.getAchievements).toHaveBeenCalledTimes(1))
    act(() => emit({ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }))
    await waitFor(() => expect(client.getAchievements).toHaveBeenCalledTimes(2))
  })
  it('keeps the previously fetched list and warns when the unlock-triggered refetch fails', async () => {
    const { client, emit } = fakeClient([
      { achievementId: 'a1', name: 'First Lesson', description: null, artworkUrl: null, current: 1, target: 1, unlockedAt: '2026-07-06T00:00:00.000Z' },
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      render(<PromoceanProvider client={client}><BadgeCabinet /></PromoceanProvider>)
      await waitFor(() => expect(screen.getByText('First Lesson')).toBeDefined())
      client.getAchievements.mockRejectedValueOnce(new Error('down'))
      act(() => emit({ achievementId: 'a2', name: 'Getting Started', unlockedAt: '2026-07-06T00:00:00.000Z' }))
      await waitFor(() => expect(client.getAchievements).toHaveBeenCalledTimes(2))
      // Stale list stays put — never blanked — and the failure is surfaced via warn.
      expect(screen.getByText('First Lesson')).toBeDefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

const offerCreative = { offerId: 'o1', headline: 'Welcome to Promocean', body: 'Run promos from one API.', imageUrl: null, ctaText: 'Learn more', ctaUrl: 'https://example.com' }

describe('Placement', () => {
  it('renders the resolved offer with CTA and fires clickOffer', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockResolvedValue(offerCreative)
    render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Welcome to Promocean')).toBeDefined())
    const cta = screen.getByRole('link', { name: 'Learn more' })
    expect(cta.getAttribute('href')).toBe('https://example.com/')
    cta.addEventListener('click', (e) => e.preventDefault())
    act(() => { cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(client.clickOffer).toHaveBeenCalledWith('o1')
  })
  it('renders nothing when no offer resolves or fetch fails', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockRejectedValue(new Error('down'))
    const { container } = render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(client.getPlacementOffer).toHaveBeenCalled())
    expect(container.querySelector('[data-promocean-placement]')).toBeNull()
  })
  it('dismiss hides the offer and persists', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockResolvedValue(offerCreative)
    render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Welcome to Promocean')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Dismiss offer' }).click() })
    expect(client.dismissOffer).toHaveBeenCalledWith('o1')
    expect(screen.queryByText('Welcome to Promocean')).toBeNull()
  })
  it('refuses javascript: CTA and image URLs', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockResolvedValue({
      ...offerCreative, ctaUrl: 'javascript:alert(1)', imageUrl: 'javascript:alert(2)',
    })
    render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Welcome to Promocean')).toBeDefined())
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })
  it('fires an impression beacon exactly once when the offer renders', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockResolvedValue(offerCreative)
    render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Welcome to Promocean')).toBeDefined())
    expect(client.recordImpression).toHaveBeenCalledTimes(1)
    expect(client.recordImpression).toHaveBeenCalledWith('o1')
  })
  it('does not fire an impression beacon for a dismissed offer', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockResolvedValue(offerCreative)
    client.isOfferDismissed = vi.fn().mockReturnValue(true)
    const { container } = render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    await waitFor(() => expect(client.getPlacementOffer).toHaveBeenCalled())
    expect(container.querySelector('[data-promocean-placement]')).toBeNull()
    expect(client.recordImpression).not.toHaveBeenCalled()
  })
  it('fires the impression beacon exactly once under StrictMode double-invoked effects', async () => {
    const { client } = fakeClient()
    client.getPlacementOffer = vi.fn().mockResolvedValue(offerCreative)
    render(
      <StrictMode>
        <PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByText('Welcome to Promocean')).toBeDefined())
    expect(client.recordImpression).toHaveBeenCalledTimes(1)
    expect(client.recordImpression).toHaveBeenCalledWith('o1')
  })
  it('does not fire an impression beacon when unmounted before the fetch resolves', async () => {
    const { client } = fakeClient()
    let resolveOffer!: (o: unknown) => void
    client.getPlacementOffer = vi.fn().mockReturnValue(new Promise((resolve) => { resolveOffer = resolve }))
    const { unmount } = render(<PromoceanProvider client={client}><Placement slug="homepage-banner" /></PromoceanProvider>)
    unmount()
    await act(async () => { resolveOffer(offerCreative) })
    expect(client.recordImpression).not.toHaveBeenCalled()
  })
})

describe('EventCountdown', () => {
  it('renders event name and a countdown that changes after a second passes', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-06T00:00:00.000Z'))
      const { client } = fakeClient()
      client.getLiveEvents = vi.fn().mockResolvedValue([
        {
          eventId: 'e1',
          name: 'Summer Sale',
          description: null,
          state: 'live',
          startsAt: '2026-07-05T00:00:00.000Z',
          endsAt: '2026-07-06T02:00:00.000Z',
          multiplier: 2,
          secondsUntilStart: null,
          secondsUntilEnd: 7200,
        },
      ])
      const { container } = render(<PromoceanProvider client={client}><EventCountdown /></PromoceanProvider>)
      await act(async () => { await Promise.resolve() })
      const row = container.querySelector('[data-promocean-event="e1"]')
      expect(row).not.toBeNull()
      expect(row?.textContent).toContain('Summer Sale')
      expect(row?.textContent).toContain('Ends in')
      const before = row?.textContent
      expect(before).toContain('2h 0m 0s')
      act(() => { vi.advanceTimersByTime(1000) })
      const after = row?.textContent
      expect(after).not.toBe(before)
      expect(after).toContain('1h 59m 59s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing when getLiveEvents rejects', async () => {
    const { client } = fakeClient()
    client.getLiveEvents = vi.fn().mockRejectedValue(new Error('down'))
    const { container } = render(<PromoceanProvider client={client}><EventCountdown /></PromoceanProvider>)
    await waitFor(() => expect(client.getLiveEvents).toHaveBeenCalled())
    expect(container.querySelector('[data-promocean-event]')).toBeNull()
  })

  it('clears the interval on unmount', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-06T00:00:00.000Z'))
      const { client } = fakeClient()
      client.getLiveEvents = vi.fn().mockResolvedValue([
        {
          eventId: 'e1',
          name: 'Summer Sale',
          description: null,
          state: 'scheduled',
          startsAt: '2026-07-06T01:00:00.000Z',
          endsAt: '2026-07-06T02:00:00.000Z',
          multiplier: 2,
          secondsUntilStart: 3600,
          secondsUntilEnd: 7200,
        },
      ])
      const { unmount } = render(<PromoceanProvider client={client}><EventCountdown /></PromoceanProvider>)
      await act(async () => { await Promise.resolve() })
      unmount()
      expect(() => { act(() => { vi.advanceTimersByTime(2000) }) }).not.toThrow()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Leaderboard', () => {
  const entries = [
    { rank: 1, userId: 'u1', points: 500 },
    { rank: 2, userId: 'u2', points: 420 },
    { rank: 3, userId: 'u3', points: 100 },
  ]

  it('renders rows from the fake client', async () => {
    const { client } = fakeClient()
    client.getLeaderboard = vi.fn().mockResolvedValue({ window: 'all', entries })
    const { container } = render(<PromoceanProvider client={client}><Leaderboard /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('u1')).toBeDefined())
    expect(screen.getByText('u2')).toBeDefined()
    expect(screen.getByText('u3')).toBeDefined()
    expect(screen.getByText('500')).toBeDefined()
    expect(container.querySelector('[data-promocean-leaderboard]')).not.toBeNull()
  })

  it('highlights the current user\'s row', async () => {
    const { client } = fakeClient()
    client.getLeaderboard = vi.fn().mockResolvedValue({ window: 'all', entries })
    client.currentUserId = 'u2'
    render(<PromoceanProvider client={client}><Leaderboard /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('u2')).toBeDefined())
    const highlighted = screen.getByText('u2').closest('[data-promocean-current-user]')
    expect(highlighted?.getAttribute('data-promocean-current-user')).toBe('true')
    const other = screen.getByText('u1').closest('[data-promocean-current-user]')
    expect(other?.getAttribute('data-promocean-current-user')).toBe('false')
  })

  it('renders nothing when getLeaderboard rejects', async () => {
    const { client } = fakeClient()
    client.getLeaderboard = vi.fn().mockRejectedValue(new Error('down'))
    const { container } = render(<PromoceanProvider client={client}><Leaderboard /></PromoceanProvider>)
    await waitFor(() => expect(client.getLeaderboard).toHaveBeenCalled())
    expect(container.querySelector('[data-promocean-leaderboard]')).toBeNull()
  })

  it('renders nothing when entries are empty', async () => {
    const { client } = fakeClient()
    client.getLeaderboard = vi.fn().mockResolvedValue({ window: 'all', entries: [] })
    const { container } = render(<PromoceanProvider client={client}><Leaderboard /></PromoceanProvider>)
    await waitFor(() => expect(client.getLeaderboard).toHaveBeenCalled())
    expect(container.querySelector('[data-promocean-leaderboard]')).toBeNull()
  })

  it('forwards window and limit to getLeaderboard and refetches on change', async () => {
    const { client } = fakeClient()
    client.getLeaderboard = vi.fn().mockResolvedValue({ window: '7d', entries })
    const { rerender } = render(
      <PromoceanProvider client={client}><Leaderboard window="7d" limit={5} /></PromoceanProvider>,
    )
    await waitFor(() => expect(client.getLeaderboard).toHaveBeenCalledWith({ window: '7d', limit: 5 }))
    rerender(<PromoceanProvider client={client}><Leaderboard window="30d" limit={10} /></PromoceanProvider>)
    await waitFor(() => expect(client.getLeaderboard).toHaveBeenCalledWith({ window: '30d', limit: 10 }))
    expect(client.getLeaderboard).toHaveBeenCalledTimes(2)
  })

  it('renders an optional title', async () => {
    const { client } = fakeClient()
    client.getLeaderboard = vi.fn().mockResolvedValue({ window: 'all', entries })
    render(<PromoceanProvider client={client}><Leaderboard title="Top Learners" /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('u1')).toBeDefined())
    expect(screen.getByText('Top Learners')).toBeDefined()
  })

  it('does not warn on state updates when unmounted before the fetch resolves', async () => {
    const { client } = fakeClient()
    let resolveLeaderboard!: (v: unknown) => void
    client.getLeaderboard = vi.fn().mockReturnValue(new Promise((resolve) => { resolveLeaderboard = resolve }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<PromoceanProvider client={client}><Leaderboard /></PromoceanProvider>)
    unmount()
    await act(async () => { resolveLeaderboard({ window: 'all', entries }) })
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

describe('RewardsStore', () => {
  function reward(overrides: Partial<Reward> = {}): Reward {
    return {
      slug: 'r1', name: 'Sticker Pack', description: 'A pack of stickers.',
      codeType: 'generated', pointsPrice: 100,
      startsAt: null, endsAt: null, perUserLimit: 1, inventory: null, remaining: null,
      ...overrides,
    }
  }

  it('renders rows and balance from the fake client', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward(), reward({ slug: 'r2', name: 'Free Trial', pointsPrice: 0 })])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    const { container } = render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    expect(screen.getByText('Free Trial')).toBeDefined()
    expect(screen.getByText('250')).toBeDefined()
    expect(container.querySelector('[data-promocean-rewards]')).not.toBeNull()
  })

  it('renders nothing when unidentified', async () => {
    const { client } = fakeClient()
    const { container } = render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    expect(container.querySelector('[data-promocean-rewards]')).toBeNull()
    expect(client.listRewards).not.toHaveBeenCalled()
    expect(client.getWallet).not.toHaveBeenCalled()
  })

  it('claiming a reward shows the code inline, keeps the claim button, and refetches wallet + rewards', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward({ perUserLimit: 5 })])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    client.claimReward = vi.fn().mockResolvedValue({ code: 'ABC-123', rewardSlug: 'r1', claimedAt: '2026-07-06T00:00:00.000Z', pointsSpent: 100 })
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(screen.getByText('ABC-123')).toBeDefined())
    expect(client.claimReward).toHaveBeenCalledWith('r1')
    expect(client.listRewards).toHaveBeenCalledTimes(2)
    expect(client.getWallet).toHaveBeenCalledTimes(2)
    // A reward with perUserLimit > 1 must still offer the claim button after
    // a successful claim — the widget can't know the user's claim count, so
    // it can't foreclose legitimate repeat claims itself.
    expect(screen.getByRole('button', { name: 'Claim' })).not.toBeDisabled()
  })

  it('a repeat claim rejected as claim_limit_reached renders the mapped message while the prior code stays visible', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward({ perUserLimit: 5 })])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    client.claimReward = vi.fn()
      .mockResolvedValueOnce({ code: 'ABC-123', rewardSlug: 'r1', claimedAt: '2026-07-06T00:00:00.000Z', pointsSpent: 100 })
      .mockRejectedValueOnce(new PromoceanApiError('claim_limit_reached', 'limit reached', 409))
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(screen.getByText('ABC-123')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Claim limit reached'))
    expect(screen.getByText('ABC-123')).toBeDefined()
    expect(client.claimReward).toHaveBeenCalledTimes(2)
  })

  it('a second successful claim replaces the shown code with the new one', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward({ perUserLimit: 5 })])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    client.claimReward = vi.fn()
      .mockResolvedValueOnce({ code: 'ABC-123', rewardSlug: 'r1', claimedAt: '2026-07-06T00:00:00.000Z', pointsSpent: 100 })
      .mockResolvedValueOnce({ code: 'DEF-456', rewardSlug: 'r1', claimedAt: '2026-07-06T00:05:00.000Z', pointsSpent: 100 })
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(screen.getByText('ABC-123')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(screen.getByText('DEF-456')).toBeDefined())
    expect(screen.queryByText('ABC-123')).toBeNull()
    expect(client.claimReward).toHaveBeenCalledTimes(2)
  })

  it('disables the claim button while a claim is pending, preventing a double-claim', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward()])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    let resolveClaim!: (v: unknown) => void
    client.claimReward = vi.fn().mockReturnValue(new Promise((resolve) => { resolveClaim = resolve }))
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    const button = screen.getByRole('button', { name: 'Claim' })
    act(() => { button.click() })
    expect(screen.getByRole('button', { name: 'Claiming…' })).toBeDisabled()
    act(() => { screen.getByRole('button', { name: 'Claiming…' }).click() })
    expect(client.claimReward).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveClaim({ code: 'ABC-123', rewardSlug: 'r1', claimedAt: '2026-07-06T00:00:00.000Z', pointsSpent: 100 })
    })
    await waitFor(() => expect(screen.getByText('ABC-123')).toBeDefined())
  })

  it('renders the mapped message when claim fails with a PromoceanApiError', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward()])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    client.claimReward = vi.fn().mockRejectedValue(new PromoceanApiError('insufficient_points', 'not enough points', 409))
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not enough points'))
    expect(client.listRewards).toHaveBeenCalledTimes(1) // no refetch on failure
  })

  it('disables claim for insufficient balance and sold-out rewards', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([
      reward({ slug: 'pricey', name: 'Pricey Reward', pointsPrice: 500 }),
      reward({ slug: 'gone', name: 'Sold Out Reward', pointsPrice: 10, remaining: 0 }),
    ])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 50, recent: [] })
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Pricey Reward')).toBeDefined())
    const pricey = screen.getByRole('button', { name: 'Not enough points' })
    expect(pricey).toBeDisabled()
    const soldOut = screen.getByRole('button', { name: 'Sold out' })
    expect(soldOut).toBeDisabled()
  })

  it('does not warn on state updates when unmounted before the fetch resolves', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    let resolveRewards!: (v: unknown) => void
    client.listRewards = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRewards = resolve }))
    client.getWallet = vi.fn().mockResolvedValue({ balance: 0, recent: [] })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    unmount()
    await act(async () => { resolveRewards([reward()]) })
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('populates once identify() fires after mount (reactive provider, not a static prop)', async () => {
    const { client, identify } = fakeClient()
    client.listRewards = vi.fn().mockResolvedValue([reward()])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    const { container } = render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    expect(container.querySelector('[data-promocean-rewards]')).toBeNull()
    expect(client.listRewards).not.toHaveBeenCalled()
    act(() => identify('u1'))
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    expect(client.listRewards).toHaveBeenCalledTimes(1)
    expect(client.getWallet).toHaveBeenCalledTimes(1)
  })

  it('re-identifying to a different user refetches rewards and wallet', async () => {
    const { client, identify } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward()])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(client.listRewards).toHaveBeenCalledTimes(1))
    act(() => identify('u2'))
    await waitFor(() => expect(client.listRewards).toHaveBeenCalledTimes(2))
    expect(client.getWallet).toHaveBeenCalledTimes(2)
  })

  it('re-identifying with the same id is a no-op — no extra refetch (provider does not re-render on a no-op notify)', async () => {
    const { client, identify } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward()])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(client.listRewards).toHaveBeenCalledTimes(1))
    act(() => identify('u1')) // fakeClient.identify() itself no-ops on same id, matching the real SDK
    expect(client.listRewards).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes from onUserChange on unmount', async () => {
    const { client, userChangeListenerCount } = fakeClient()
    const { unmount } = render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    expect(userChangeListenerCount()).toBe(1)
    unmount()
    expect(userChangeListenerCount()).toBe(0)
  })

  it('renders err.message for an unmapped PromoceanApiError code', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward()])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    client.claimReward = vi.fn().mockRejectedValue(new PromoceanApiError('weird_unmapped_code', 'custom server message', 400))
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('custom server message'))
  })

  it('renders a generic message for a non-ApiError claim rejection, not the raw error text', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward()])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    client.claimReward = vi.fn().mockRejectedValue(new Error('ECONNRESET at socket 4'))
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    expect(screen.getByRole('alert')).toHaveTextContent('Claim failed')
    expect(screen.queryByText(/ECONNRESET/)).toBeNull()
  })

  it('does not warn on state updates when unmounted before a claim resolves', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward()])
    client.getWallet = vi.fn().mockResolvedValue({ balance: 250, recent: [] })
    let resolveClaim!: (v: unknown) => void
    client.claimReward = vi.fn().mockReturnValue(new Promise((resolve) => { resolveClaim = resolve }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { unmount } = render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
      await waitFor(() => expect(screen.getByText('Sticker Pack')).toBeDefined())
      act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
      unmount()
      await act(async () => {
        resolveClaim({ code: 'ABC-123', rewardSlug: 'r1', claimedAt: '2026-07-06T00:00:00.000Z', pointsSpent: 100 })
      })
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('a post-claim wallet refetch that drops the balance flips a now-unaffordable reward to disabled "Not enough points"', async () => {
    const { client } = fakeClient()
    client.currentUserId = 'u1'
    client.listRewards = vi.fn().mockResolvedValue([reward({ slug: 'demo_discount', name: 'Demo Discount', pointsPrice: 100 })])
    client.getWallet = vi.fn()
      .mockResolvedValueOnce({ balance: 250, recent: [] })
      .mockResolvedValueOnce({ balance: 50, recent: [] })
    client.claimReward = vi.fn().mockResolvedValue({ code: 'ABC-123', rewardSlug: 'demo_discount', claimedAt: '2026-07-06T00:00:00.000Z', pointsSpent: 200 })
    render(<PromoceanProvider client={client}><RewardsStore /></PromoceanProvider>)
    await waitFor(() => expect(screen.getByText('Demo Discount')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Claim' })).not.toBeDisabled()
    act(() => { screen.getByRole('button', { name: 'Claim' }).click() })
    await waitFor(() => expect(client.getWallet).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Not enough points' })).toBeDisabled())
  })
})
