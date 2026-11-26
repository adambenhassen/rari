import type { Metadata } from 'rari'
import { headers } from 'rari/headers'

export async function generateMetadata(): Promise<Metadata> {
  const session = (await headers()).get('x-session') ?? 'anonymous'
  return { title: `Session ${session}` }
}

export default function CacheMetadataSessionPage() {
  return <p>Session metadata page</p>
}
