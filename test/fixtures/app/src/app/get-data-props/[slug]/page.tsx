import type { Metadata, PageProps } from 'rari'

type DataPageProps = PageProps & { n: number }

let nextId = 0

export function getData() {
  return { props: { n: ++nextId } }
}

export async function generateMetadata({ n }: DataPageProps): Promise<Metadata> {
  await new Promise(resolve => setTimeout(resolve, 25))
  return { title: `Request data ${n}` }
}

export default function GetDataPropsPage({ n }: DataPageProps) {
  return <p data-testid="request-data-id">{n}</p>
}
