import type { Metadata, PageProps } from 'rari'
import { headers } from 'rari/headers'

const metadataCallsBySlug = new Map<string, number>()

export async function generateMetadata({ params }: Readonly<PageProps>): Promise<Metadata> {
  const slug = String(params.slug)
  const calls = metadataCallsBySlug.get(slug) ?? 0
  metadataCallsBySlug.set(slug, calls + 1)

  if (calls > 0) {
    // The request header is read, but the metadata remains public and stable.
    const session = (await headers()).get('x-session')
    if (session != null) return { title: 'Public metadata' }
  }

  return { title: 'Public metadata' }
}

export default function CacheMetadataPublicHeaderPage({ params }: Readonly<PageProps>) {
  return <p>Public page: {String(params.slug)}</p>
}
