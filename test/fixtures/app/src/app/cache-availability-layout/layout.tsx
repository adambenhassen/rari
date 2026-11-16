import type { Metadata } from 'rari'
import type { ReactNode } from 'react'

export async function generateMetadata(): Promise<Metadata> {
  const backend = process.env.RARI_TEST_AVAILABILITY_BACKEND
  if (backend != null && backend !== '') {
    const response = await fetch(`${backend}/status?nonce=${Math.random()}`)
    if (!response.ok) globalThis.markResponseUnavailable(17)
  }
  return { title: 'Layout availability' }
}

export default function AvailabilityLayout({
  children,
}: Readonly<{ children: ReactNode }>): ReactNode {
  return children
}
