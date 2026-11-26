import type { Metadata, PageProps } from 'rari'

export async function getData({ params }: Readonly<PageProps>) {
  const backend = process.env.RARI_TEST_AVAILABILITY_BACKEND
  if (backend == null || backend === '') return { props: { slug: String(params.slug) } }
  const response = await fetch(`${backend}/status?nonce=${Math.random()}`)
  return { props: { unavailable: !response.ok, slug: String(params.slug) } }
}

export async function generateMetadata({
  unavailable,
}: Readonly<{ unavailable?: boolean }>): Promise<Metadata> {
  if (unavailable) throw new Error('metadata generation failed without an outage marker')
  return { title: 'Metadata failure fixture' }
}

export default function MetadataFailurePage({ slug }: Readonly<{ slug: string }>) {
  return <h1>{slug}</h1>
}
