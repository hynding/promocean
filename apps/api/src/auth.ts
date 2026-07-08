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
    if (auth.keyType === 'publishable' && auth.allowedOrigins?.length) {
      const origin = c.req.header('origin')
      if (origin && !auth.allowedOrigins.includes(origin)) {
        return c.json({ error: { code: 'origin_not_allowed', message: 'Origin not allowed for this key.' } }, 403)
      }
    }
    c.set('auth', auth)
    await next()
  }
}
