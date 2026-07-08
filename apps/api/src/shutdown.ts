import type { ServerType } from '@hono/node-server'
import type { Db } from '@promocean/adapter-db'
import type { Logger } from 'pino'

/** How long server.close() is given to finish draining in-flight requests before the
 * process force-exits. Prevents a stuck connection from hanging shutdown forever. */
const FORCE_EXIT_MS = 10_000

export interface InstallShutdownHandlersOptions {
  /** Stops the lifecycle scheduler's interval (the function `startLifecycleScheduler` returns). */
  stopScheduler: () => void
  server: ServerType
  pool: Db['$client']
  logger: Logger
}

/**
 * Registers one shared SIGTERM/SIGINT handler that shuts the process down in order:
 * stop the lifecycle scheduler, close the HTTP server (falling back to a forced exit if
 * close hangs past FORCE_EXIT_MS), close the db pool, then exit 0. Logs each phase.
 *
 * Returns the handler itself so tests can invoke it directly with fakes instead of
 * sending real OS signals.
 */
export function installShutdownHandlers(opts: InstallShutdownHandlersOptions): () => Promise<void> {
  const { stopScheduler, server, pool, logger } = opts

  const shutdown = async (): Promise<void> => {
    logger.info('shutdown: stopping lifecycle scheduler')
    stopScheduler()

    logger.info('shutdown: closing http server')
    await new Promise<void>((resolve) => {
      const forceExitTimer = setTimeout(() => {
        logger.warn('shutdown: server.close did not complete in time; forcing exit')
        process.exit(1)
      }, FORCE_EXIT_MS)
      forceExitTimer.unref()
      server.close((err) => {
        clearTimeout(forceExitTimer)
        if (err) logger.error({ err }, 'shutdown: error while closing http server')
        resolve()
      })
    })

    logger.info('shutdown: closing db pool')
    await pool.end()

    logger.info('shutdown: complete, exiting')
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return shutdown
}
