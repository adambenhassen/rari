import type { PageProps } from 'rari'

const responseAvailability = globalThis as typeof globalThis & {
  markResponseUnavailable: (retryAfterSeconds?: number) => void
}

export default function StreamingServerResponsePage({ searchParams }: PageProps) {
  const mode = String(searchParams.mode)

  if (mode === 'unavailable')
    responseAvailability.markResponseUnavailable()

  return (
    <main>
      <h1>Streaming server response state</h1>
      <p data-testid="response-mode">{mode}</p>
    </main>
  )
}
