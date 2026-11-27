import type { PageProps } from 'rari'

const callsBySlug = new Map<string, number>()

export function getData({ params }: Readonly<PageProps>) {
  const slug = String(params.slug)
  const calls = callsBySlug.get(slug) ?? 0
  callsBySlug.set(slug, calls + 1)
  if (slug.startsWith('uncached-') && calls === 0) {
    globalThis.markResponseUnavailable(17)
    return { notFound: true }
  }
  if (calls > 0) {
    globalThis.markResponseUnavailable(17)
    return { notFound: true }
  }
  return { props: { slug } }
}

export default function GetDataUnavailableNotFoundPage({ slug }: Readonly<{ slug: string }>) {
  return <p data-testid="not-found-cache-prime">{slug}</p>
}
