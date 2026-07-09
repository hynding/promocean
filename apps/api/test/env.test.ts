import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { envInt } from '../src/env.js'
import { logger } from '../src/logger.js'

describe('envInt', () => {
  const ENV_KEY = 'ENV_INT_TEST_VAR'
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
  })
  afterEach(() => {
    delete process.env[ENV_KEY]
    warnSpy.mockRestore()
  })

  it('parses a valid integer value', () => {
    process.env[ENV_KEY] = '42'
    expect(envInt(ENV_KEY, 7)).toBe(42)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('falls back and warns on a junk (non-numeric) value', () => {
    process.env[ENV_KEY] = 'not-a-number'
    expect(envInt(ENV_KEY, 7)).toBe(7)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      { name: ENV_KEY, raw: 'not-a-number', fallback: 7 },
      expect.any(String),
    )
  })

  it('falls back and warns on an infinite value', () => {
    process.env[ENV_KEY] = 'Infinity'
    expect(envInt(ENV_KEY, 7)).toBe(7)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back silently (no warning) when the var is missing', () => {
    delete process.env[ENV_KEY]
    expect(envInt(ENV_KEY, 7)).toBe(7)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
