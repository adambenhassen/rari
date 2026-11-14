import type { Metadata, PageProps } from 'rari'
import RefreshGetDataButton from './RefreshGetDataButton'

const responseAvailability = globalThis as typeof globalThis & {
  markResponseUnavailable: (retryAfterSeconds?: number) => void
}

export function generateStaticParams() {
  return [
    { slug: 'warmup' },
    { slug: 'unavailable' },
    { slug: 'fast-cache' },
    { slug: 'warmup-failure' },
  ]
}

const callsByCase = new Map<string, number>()
const callsBySlug = new Map<string, number>()

export function getData({ params, searchParams }: Readonly<PageProps>) {
  const slug = String(params.slug)
  if (slug === 'warmup-failure') throw new Error('getData failed during warmup')

  let getDataCallCount: number | undefined
  if (slug === 'fast-cache') {
    getDataCallCount = (callsBySlug.get(slug) ?? 0) + 1
    callsBySlug.set(slug, getDataCallCount)
  }

  const failure = String(searchParams.getDataFailure)
  if (failure === 'throw') throw new Error('getData failed')
  if (failure === 'array') return { props: ['invalid'] }
  if (failure === 'second-call') {
    const caseKey = String(searchParams.case)
    const callCount = callsByCase.get(caseKey) ?? 0
    callsByCase.set(caseKey, callCount + 1)
    if (callCount === 1) throw new Error('getData failed on second call')
  }

  const props: { n: number; getDataCallCount?: number } = {
    n: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
  }
  if (getDataCallCount != null) props.getDataCallCount = getDataCallCount

  return { props }
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

export default function GetDataPropsPage({
  n,
  getDataCallCount,
}: Readonly<{ n: number; getDataCallCount?: number }>) {
  return (
    <>
      <p data-testid="request-data-id">{n}</p>
      {getDataCallCount != null && <p data-testid="get-data-call-count">{getDataCallCount}</p>}
      <RefreshGetDataButton />
    </>
  )
}
