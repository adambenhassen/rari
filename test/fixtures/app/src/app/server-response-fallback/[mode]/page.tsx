import type { Metadata, PageProps } from 'rari'

export function getData({ params }: Readonly<PageProps>) {
  if (params.mode === 'get-data-failure') throw new Error('Intentional getData failure')
  return { props: {} }
}

export function generateMetadata({ params }: Readonly<PageProps>): Metadata {
  if (params.mode === 'metadata-unavailable') globalThis.markResponseUnavailable(19)
  return { title: 'Fallback response state' }
}

export default function FallbackResponsePage() {
  return <h1>Fallback response page</h1>
}
