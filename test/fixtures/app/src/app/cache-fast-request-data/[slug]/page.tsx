import type { Metadata, PageProps } from 'rari'
import { headers } from 'rari/headers'

const metadataCallsBySlug = new Map<string, number>()

export function getData({ params }: Readonly<PageProps>) {
  return { props: { slug: String(params.slug) } }
}

export async function generateMetadata({ params }: Readonly<PageProps>): Promise<Metadata> {
  const slug = String(params.slug)
  const calls = metadataCallsBySlug.get(slug) ?? 0
  metadataCallsBySlug.set(slug, calls + 1)

  if (calls > 0) {
    const session = (await headers()).get('x-session') ?? 'anonymous'
    return { title: `Fast metadata ${session}` }
  }

  return { title: 'Fast metadata shared' }
}

export default function CacheFastRequestDataPage({ slug }: Readonly<{ slug: string }>) {
  return <p data-testid="fast-request-data">Fast request data page: {slug}</p>
}
