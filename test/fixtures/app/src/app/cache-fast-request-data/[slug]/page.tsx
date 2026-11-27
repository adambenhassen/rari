import type { PageProps } from 'rari'
import { headers } from 'rari/headers'

const getDataCallsBySlug = new Map<string, number>()

export async function getData({ params }: Readonly<PageProps>) {
  const slug = String(params.slug)
  const calls = getDataCallsBySlug.get(slug) ?? 0
  getDataCallsBySlug.set(slug, calls + 1)

  const session = calls > 0 ? ((await headers()).get('x-session') ?? 'anonymous') : 'shared'

  return { props: { slug, session } }
}

export default function CacheFastRequestDataPage({
  slug,
  session,
}: Readonly<{ slug: string; session: string }>) {
  return (
    <p data-testid="fast-request-data">
      Fast request data page: {slug} ({session})
    </p>
  )
}
