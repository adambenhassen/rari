import type { Metadata, PageProps } from 'rari'

export function generateStaticParams() {
  return [{ slug: 'slow' }, { slug: 'warmed' }]
}

export async function getData({ params, searchParams }: Readonly<PageProps>) {
  const backend = process.env.RARI_TEST_WARMUP_BACKEND
  if (params.slug !== 'slow' || backend == null || backend === '') {
    return { props: { unavailable: false } }
  }

  const path = String(searchParams.client) === 'yes' ? '/request' : '/warmup'
  const response = await fetch(`${backend}${path}`)
  return { props: { unavailable: !response.ok } }
}

export function generateMetadata({ unavailable }: Readonly<{ unavailable: boolean }>): Metadata {
  if (unavailable) globalThis.markResponseUnavailable(17)
  return { title: 'Warmup isolation' }
}

export default function WarmupIsolationPage() {
  return <h1>Warmup isolation page</h1>
}
