import type { Metadata } from 'rari'

export async function getData() {
  const backend = process.env.RARI_TEST_AVAILABILITY_BACKEND
  if (backend == null || backend === '') return { props: { unavailable: false } }
  const response = await fetch(`${backend}/status?nonce=${Math.random()}`)
  return { props: { unavailable: !response.ok } }
}

export async function generateMetadata({
  unavailable,
  params,
}: Readonly<{ unavailable: boolean; params: Readonly<{ slug: string }> }>): Promise<Metadata> {
  if (unavailable) {
    globalThis.markResponseUnavailable(17)
    if (params.slug === 'metadata-timeout') {
      await new Promise<void>(resolve => {
        setTimeout(resolve, 4_000)
      })
    }
  }
  return { title: 'Availability' }
}

export default function AvailabilityPage() {
  return <h1>Availability page</h1>
}
