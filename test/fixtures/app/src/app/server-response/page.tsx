import type { PageProps } from 'rari'

declare global {
  var markResponseUnavailable: (retryAfterSeconds?: number) => void
}

export default function ServerResponsePage({ searchParams }: PageProps) {
  const mode = String(searchParams.mode)

  if (mode === 'unavailable')
    globalThis.markResponseUnavailable()
  else if (mode === 'unavailable-custom')
    globalThis.markResponseUnavailable(17)

  return (
    <main>
      <h1>Server response state</h1>
      <p data-testid="render-token">{crypto.randomUUID()}</p>
      <p data-testid="response-mode">{mode}</p>
    </main>
  )
}
