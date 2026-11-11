import type { PageProps } from 'rari'

export default function ServerResponsePage({ searchParams }: PageProps) {
  const mode = String(searchParams.mode)
  if (mode === 'unavailable') globalThis.markResponseUnavailable()

  return (
    <main>
      <h1>Server response state</h1>
      <p data-testid="response-mode">{mode}</p>
    </main>
  )
}
