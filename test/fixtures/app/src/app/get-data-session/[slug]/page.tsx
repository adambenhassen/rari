import type { PageProps } from 'rari'
import { cookies } from 'rari/headers'

const callsBySlug = new Map<string, number>()

export async function getData({ params }: Readonly<PageProps>) {
  const slug = String(params.slug)
  const calls = callsBySlug.get(slug) ?? 0
  callsBySlug.set(slug, calls + 1)
  const session = calls === 0 ? 'shared' : ((await cookies()).get('session')?.value ?? 'anonymous')
  return { props: { session } }
}

export default function GetDataSessionPage({ session }: Readonly<{ session: string }>) {
  return <p data-testid="session">{session}</p>
}
