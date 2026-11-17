import type { PageProps } from 'rari'

export function getData({ searchParams }: Readonly<PageProps>) {
  if (String(searchParams.mode) === 'unavailable') {
    globalThis.markResponseUnavailable(17)
  }
  return { props: { slug: String(searchParams.mode) } }
}

export default function GetDataResponseUnavailablePage() {
  return <h1>GetData response availability</h1>
}
