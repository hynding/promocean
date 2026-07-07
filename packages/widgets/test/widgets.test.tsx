import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UnlockPayload } from '@promocean/contracts'
import { BadgeCabinet, PromoceanProvider, UnlockToast } from '../src/index.js'

function fakeClient(achievements: unknown[] = []) {
  const listeners = new Set<(u: UnlockPayload) => void>()
  return {
    client: {
      onUnlock: (cb: (u: UnlockPayload) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
      getAchievements: vi.fn().mockResolvedValue(achievements),
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
