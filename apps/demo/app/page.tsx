import { Demo } from './promocean'

export default async function Page({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const { user } = await searchParams
  return <Demo userId={user ?? 'demo-user'} />
}
