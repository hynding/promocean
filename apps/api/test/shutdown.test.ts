import type { ServerType } from '@hono/node-server'
import type { Db } from '@promocean/adapter-db'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installShutdownHandlers } from '../src/shutdown.js'

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger
}

function fakeServer(onClose?: (cb: (err?: Error) => void) => void): ServerType {
  return { close: vi.fn(onClose ?? ((cb: (err?: Error) => void) => cb())) } as unknown as ServerType
}

function fakePool(onEnd?: () => Promise<void>): Db['$client'] {
  return { end: vi.fn(onEnd ?? (async () => {})) } as unknown as Db['$client']
}

describe('installShutdownHandlers', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
  })

  it('stops the scheduler before closing the server, and ends the pool after close completes', async () => {
    const order: string[] = []
    const stopScheduler = vi.fn(() => { order.push('scheduler-stopped') })
    const server = fakeServer((cb) => {
      order.push('server-close-start')
      cb()
      order.push('server-close-callback-done')
    })
    const pool = fakePool(async () => { order.push('pool-ended') })
    const logger = fakeLogger()

    const handler = installShutdownHandlers({ stopScheduler, server, pool, logger })
    await handler()

    expect(order).toEqual([
      'scheduler-stopped',
      'server-close-start',
      'server-close-callback-done',
      'pool-ended',
    ])
    expect(stopScheduler).toHaveBeenCalledTimes(1)
    expect(server.close).toHaveBeenCalledTimes(1)
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(process.exit).toHaveBeenCalledWith(0)
  })

  it('waits for an async server.close callback before ending the pool', async () => {
    const order: string[] = []
    const server = fakeServer((cb) => {
      setTimeout(() => {
        order.push('server-closed')
        cb()
      }, 0)
    })
    const pool = fakePool(async () => { order.push('pool-ended') })
    const handler = installShutdownHandlers({ stopScheduler: vi.fn(), server, pool, logger: fakeLogger() })

    await handler()

    expect(order).toEqual(['server-closed', 'pool-ended'])
  })

  it('registers the same handler function for both SIGTERM and SIGINT (no double registration)', () => {
    const onSpy = vi.spyOn(process, 'on')
    const handler = installShutdownHandlers({
      stopScheduler: vi.fn(),
      server: fakeServer(),
      pool: fakePool(),
      logger: fakeLogger(),
    })

    const sigtermCall = onSpy.mock.calls.find((c) => c[0] === 'SIGTERM')
    const sigintCall = onSpy.mock.calls.find((c) => c[0] === 'SIGINT')
    expect(sigtermCall?.[1]).toBe(handler)
    expect(sigintCall?.[1]).toBe(handler)
  })

  it('registers a force-exit timer (10s) that is unref-ed so it cannot keep the process alive', async () => {
    const unref = vi.fn()
    const setTimeoutSpy = vi
      .spyOn(global, 'setTimeout')
      .mockImplementation((() => ({ unref }) as unknown as NodeJS.Timeout) as typeof setTimeout)
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(() => {})

    const handler = installShutdownHandlers({
      stopScheduler: vi.fn(),
      server: fakeServer(),
      pool: fakePool(),
      logger: fakeLogger(),
    })
    await handler()

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000)
    expect(unref).toHaveBeenCalledTimes(1)
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)
  })

  it('logs each phase', async () => {
    const logger = fakeLogger()
    const handler = installShutdownHandlers({
      stopScheduler: vi.fn(),
      server: fakeServer(),
      pool: fakePool(),
      logger,
    })
    await handler()

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('stopping lifecycle scheduler'))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('closing http server'))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('closing db pool'))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('complete'))
  })

  it('reuses the in-flight promise when invoked again before the first resolves (reentrancy guard)', async () => {
    const stopScheduler = vi.fn()
    // Async close so the first invocation is still in-flight when the second call happens.
    const server = fakeServer((cb) => { setTimeout(() => cb(), 0) })
    const pool = fakePool()
    const logger = fakeLogger()

    const handler = installShutdownHandlers({ stopScheduler, server, pool, logger })
    const first = handler()
    const second = handler()

    expect(second).toBe(first)
    await first

    expect(stopScheduler).toHaveBeenCalledTimes(1)
    expect(server.close).toHaveBeenCalledTimes(1)
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already in progress'))
  })

  it('force-exits with code 1 when server.close never completes within FORCE_EXIT_MS', async () => {
    vi.useFakeTimers()
    try {
      const server = fakeServer(() => { /* never calls back — simulates a hung close */ })
      const pool = fakePool()
      const logger = fakeLogger()

      const handler = installShutdownHandlers({ stopScheduler: vi.fn(), server, pool, logger })
      void handler()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(process.exit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
