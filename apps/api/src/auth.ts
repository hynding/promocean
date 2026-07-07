import type { Context, Next } from 'hono'
import type { ApiKeyStore, AuthContext } from '@promocean/core'

declare module 'hono' {
  interface ContextVariableMap { auth: AuthContext }
}

export function authMiddleware(apiKeyStore: ApiKeyStore) {
  return async (c: Context, next: Next) => {
    const header = c.req.header('authorization') ?? ''
    const rawKey = header.startsWith('Bearer ') ? header.slice(7) : ''
    const auth = rawKey ? await apiKeyStore.verifyKey(rawKey) : null
    if (!auth) {
      return c.json({ error: { code: 'invalid_api_key', message: 'Missing or invalid API key.' } }, 401)
    }
    c.set('auth', auth)
    await next()
  }
}
