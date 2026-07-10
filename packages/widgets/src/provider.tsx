import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Promocean } from '@promocean/sdk'

const Ctx = createContext<{ client: Promocean; userId: string | undefined } | null>(null)

export function PromoceanProvider({ client, children }: { client: Promocean; children: ReactNode }) {
  // Initialized from the client's identity at mount; kept in sync thereafter via
  // onUserChange, which only fires on an actual identity change (never a same-id
  // re-identify), so this never re-renders on a no-op notify.
  const [userId, setUserId] = useState<string | undefined>(() => client.currentUserId)

  useEffect(() => {
    // Resync before subscribing: a client swapped in via props (or an
    // identify() fired between this component's render and this effect
    // running — child effects run first, so a descendant's own mount effect
    // can identify() before we get here) would otherwise leave `userId`
    // stuck on whatever it was initialized/last set to, rather than the
    // client's actual current identity.
    setUserId(client.currentUserId)
    // Subscribing (rather than reading client.currentUserId directly) means
    // widgets re-render on identify() instead of only reflecting whatever the
    // client's identity happened to be at initial mount.
    const unsubscribe = client.onUserChange(setUserId)
    return unsubscribe
  }, [client])

  // Stable across unrelated parent re-renders (as long as client/userId are
  // unchanged) so consumers don't force-propagate on every parent render.
  const value = useMemo(() => ({ client, userId }), [client, userId])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePromocean(): Promocean {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePromocean must be used inside <PromoceanProvider>.')
  return ctx.client
}

export function usePromoceanUser(): string | undefined {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePromoceanUser must be used inside <PromoceanProvider>.')
  return ctx.userId
}
