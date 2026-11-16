import type { Metadata, PageProps } from 'rari'

const calls = new Map<string, number>()
// oxlint-disable-next-line import/no-mutable-exports -- exercise a live module export
export let generateMetadata: ((props: Readonly<{ unavailable: boolean }>) => Metadata) | undefined

export function getData({ params }: Readonly<PageProps>) {
  const slug = String(params.slug)
  const count = (calls.get(slug) ?? 0) + 1
  calls.set(slug, count)
  if (count > 1) {
    generateMetadata = ({ unavailable }) => {
      if (unavailable) globalThis.markResponseUnavailable(17)
      return { title: 'Late metadata' }
    }
  }
  return { props: { unavailable: count > 1 } }
}

export default function LateMetadataPage() {
  return <h1>Late metadata page</h1>
}
