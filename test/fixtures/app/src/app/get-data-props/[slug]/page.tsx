import type { Metadata, PageProps } from 'rari'
import RefreshGetDataButton from './RefreshGetDataButton'

const responseAvailability = globalThis as typeof globalThis & {
  markResponseUnavailable: (retryAfterSeconds?: number) => void
}

export function generateStaticParams() {
  return [{ slug: 'warmup' }, { slug: 'unavailable' }]
}

let nextId = 0
const callsByCase = new Map<string, number>()

export function getData({ searchParams }: Readonly<PageProps>) {
  const failure = String(searchParams.getDataFailure)
  if (failure === 'throw') throw new Error('getData failed')
  if (failure === 'array') return { props: ['invalid'] }
  if (failure === 'second-call') {
    const caseKey = String(searchParams.case)
    const callCount = callsByCase.get(caseKey) ?? 0
    callsByCase.set(caseKey, callCount + 1)
    if (callCount === 1) throw new Error('getData failed on second call')
  }

  return { props: { n: ++nextId } }
}

export async function generateMetadata({
  n,
  params,
}: Readonly<{
  n: number
  params: Readonly<{ slug: string }>
}>): Promise<Metadata> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 25)
  })
  if (params.slug === 'unavailable') responseAvailability.markResponseUnavailable()
  return { title: `Request data ${n}` }
}

export default function GetDataPropsPage({ n }: Readonly<{ n: number }>) {
  return (
    <>
      <p data-testid="request-data-id">{n}</p>
      <RefreshGetDataButton />
    </>
  )
}
