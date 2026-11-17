import type { PageProps } from 'rari'

export async function getData({ params }: Readonly<PageProps>) {
  const backend = process.env.RARI_TEST_AVAILABILITY_BACKEND
  let available = true
  if (backend != null && backend !== '') {
    const response = await fetch(`${backend}/status?nonce=${Math.random()}`)
    available = response.ok
  }
  if (!available) globalThis.markResponseUnavailable(17)
  return { props: { slug: String(params.slug), unavailable: !available } }
}

export default function GetDataResponseUnavailablePage() {
  return <h1>GetData response availability</h1>
}
