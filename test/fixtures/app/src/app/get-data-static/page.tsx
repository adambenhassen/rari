import type { PageProps } from 'rari'

const callsByCase = new Map<string, number>()

export function getData({ searchParams }: Readonly<PageProps>) {
  const caseKey = String(searchParams.case)
  const count = callsByCase.get(caseKey) ?? 0
  callsByCase.set(caseKey, count + 1)
  if (count > 0) return { notFound: true }
  return { props: { message: 'Static page data' } }
}

export default function StaticGetDataPage({ message }: Readonly<{ message: string }>) {
  return <h1>{message}</h1>
}
