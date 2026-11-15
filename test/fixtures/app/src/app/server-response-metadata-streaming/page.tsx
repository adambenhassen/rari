import type { Metadata, PageProps } from 'rari'

export async function generateMetadata({ searchParams }: Readonly<PageProps>): Promise<Metadata> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 25)
  })
  if (String(searchParams.mode) === 'unavailable') globalThis.markResponseUnavailable(17)
  return { title: `Streaming metadata ${String(searchParams.mode)}` }
}

export default function StreamingMetadataResponsePage() {
  return <h1>Streaming metadata response</h1>
}
