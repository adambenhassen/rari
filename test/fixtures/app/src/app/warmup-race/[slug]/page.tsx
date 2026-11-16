import type { PageProps } from 'rari'
import { cacheTag } from '@rari/use-cache/runtime/cache-wrapper'

export function generateStaticParams() {
  return [{ slug: 'live' }, { slug: 'invalidate' }, { slug: 'tagged' }]
}

export async function getData({ params }: Readonly<PageProps>) {
  const backend = process.env.RARI_TEST_RACE_BACKEND
  if (backend == null || backend === '') return { props: { version: 'baseline' } }
  const response = await fetch(`${backend}/${String(params.slug)}?nonce=${Math.random()}`)
  return { props: { version: await response.text() } }
}

// oxlint-disable-next-line typescript/require-await async is required for the 'use cache' transform
async function taggedVersion(version: string) {
  'use cache'
  cacheTag('/warmup-race/tag-target')
  return version
}

export default async function WarmupRacePage({
  version,
  params,
}: Readonly<{ version: string; params: Readonly<{ slug: string }> }>) {
  const displayed = params.slug === 'tagged' ? await taggedVersion(version) : version
  return <h1 data-testid="warmup-race-version">{displayed}</h1>
}
