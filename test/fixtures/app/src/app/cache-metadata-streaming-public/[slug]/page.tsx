import type { Metadata, PageProps } from 'rari'
import { headers } from 'rari/headers'

export async function generateMetadata(): Promise<Metadata> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 25)
  })
  const session = (await headers()).get('x-session')
  if (session != null) return { title: 'Shared streamed metadata' }
  return { title: 'Shared streamed metadata' }
}

export default function CacheMetadataStreamingPublicPage({ params }: Readonly<PageProps>) {
  return <p>Streamed public page: {String(params.slug)}</p>
}
