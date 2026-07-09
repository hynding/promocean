import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UnlockPayload } from '@promocean/contracts'
import { BadgeCabinet, EventCountdown, Leaderboard, Placement, PromoceanProvider, UnlockToast } from '../src/index.js'

// RTL's automatic afterEach cleanup only registers when `afterEach` exists as a
// global; this project's vitest config doesn't set `test.globals: true`, so
// DOM from one test otherwise leaks into the next within this file (collides
// once two Placement tests render the same offer content). Clean up explicitly.
afterEach(cleanup)

function fakeClient(achievements: unknown[] = [], offer: unknown = null) {
  const listeners = new Set<(u: UnlockPayload) => void>()
  return {
    client: {
      onUnlock: (cb: (u: UnlockPayload) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
      getAchievements: vi.fn().mockResolvedValue(achievements),
      getPlacementOffer: vi.fn().mockResolvedValue(offer),
      getLiveEvents: vi.fn().mockResolvedValue([]),
      clickOffer: vi.fn().mockResolvedValue(undefined),
      recordImpression: vi.fn().mockResolvedValue(undefined),
      dismissOffer: vi.fn(),
      isOfferDismissed: vi.fn().mockReturnValue(false),
      getLeaderboard: vi.fn().mockResolvedValue({ window: 'all', entries: [] }),
      currentUserId: undefined as string | undefined,
    } as any,
    emit: (u: UnlockPayload) => listeners.forEach((cb) => cb(u)),
  }
}

describe('UnlockToast', () => {
  it('renders an unlock in a polite live region and auto-dismisses', async () => {
    vi.useFakeTimers()
    const { client, emit } = fakeClient()
    render(<PromoceanProvider client={client}><UnlockToast durationMs={1000} /></PromoceanProvider>)
    act(() => emit({ achievementId: 'a1', name: 'First Lesson', unlockedAt: '2026-07-06T00:00:00.000Z' }))
    expect(screen.getByRole('status')).toHaveTextContent('First Lesson')
    act(() => { vi.advanceTimersByTime(1100) })
    expect(screen.getByRole('status')).not.toHaveTextContent('First Lesson')
    vi.useRealTimers()
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
