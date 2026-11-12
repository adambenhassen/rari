import type { Metadata, PageProps } from 'rari'

const responseAvailability = globalThis as typeof globalThis & {
  markResponseUnavailable: (retryAfterSeconds?: number) => void
}

export function generateMetadata({ searchParams }: PageProps): Metadata {
  const mode = String(searchParams.mode)

  if (mode === 'unavailable')
    responseAvailability.markResponseUnavailable()

  return { title: `Metadata response ${mode}` }
}

export default function MetadataServerResponsePage({ searchParams }: PageProps) {
  return (
    <main>
      <h1>Metadata server response state</h1>
      <p data-testid="response-mode">{String(searchParams.mode)}</p>
    </main>
  )
}
