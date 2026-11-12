import type { Metadata, PageProps } from 'rari'

type DataPageProps = PageProps & { n: number }

let nextId = 0

export function getData({ searchParams }: PageProps) {
  if (String(searchParams.getDataFailure) === 'throw')
    throw new Error('getData failed')
  if (String(searchParams.getDataFailure) === 'array')
    return { props: ['invalid'] }

  return { props: { n: ++nextId } }
}

export async function generateMetadata({ n }: DataPageProps): Promise<Metadata> {
  await new Promise(resolve => setTimeout(resolve, 25))
  return { title: `Request data ${n}` }
}

export default function GetDataPropsPage({ n }: DataPageProps) {
  return <p data-testid="request-data-id">{n}</p>
}
