import type { Metadata, PageProps } from 'rari'

export function getData({ params }: Readonly<PageProps>) {
  return { props: { dataLabel: `stream-${String(params.slug)}` } }
}

export async function generateMetadata({
  dataLabel,
}: Readonly<{ dataLabel: string }>): Promise<Metadata> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 25)
  })
  return { title: `Streaming data ${dataLabel}` }
}

export default function StreamingGetDataPage({ dataLabel }: Readonly<{ dataLabel: string }>) {
  return <p data-testid="streaming-data">{dataLabel}</p>
}
