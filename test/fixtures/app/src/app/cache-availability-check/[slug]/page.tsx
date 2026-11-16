import type { Metadata } from 'rari'

export function getData() {
  return { props: {} }
}

export async function generateMetadata(): Promise<Metadata> {
  const backend = process.env.RARI_TEST_AVAILABILITY_BACKEND
  if (backend != null && backend !== '') {
    const response = await fetch(`${backend}/status?nonce=${Math.random()}`)
    if (!response.ok) globalThis.markResponseUnavailable(17)
  }
  return { title: 'Metadata availability check' }
}

export default function MetadataAvailabilityCheckPage() {
  return <h1>Metadata availability check</h1>
}
