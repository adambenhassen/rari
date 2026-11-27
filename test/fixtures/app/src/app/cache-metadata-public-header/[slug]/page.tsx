import type { Metadata, PageProps } from 'rari'
import { headers } from 'rari/headers'

export async function generateMetadata(): Promise<Metadata> {
  // Request-specific data is read, but the metadata remains public and stable.
  const session = (await headers()).get('x-session')
  if (session != null) return { title: 'Public metadata' }
  return { title: 'Public metadata' }
}

export default function CacheMetadataPublicHeaderPage({ params }: Readonly<PageProps>) {
  return <p>Public page: {String(params.slug)}</p>
}
