import { createContext, useContext, type ReactNode } from 'react'
import type { Promocean } from '@promocean/sdk'

const Ctx = createContext<Promocean | null>(null)

export function PromoceanProvider({ client, children }: { client: Promocean; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>
}

export function usePromocean(): Promocean {
  const client = useContext(Ctx)
  if (!client) throw new Error('usePromocean must be used inside <PromoceanProvider>.')
  return client
}
