import type { PageProps } from 'rari'

let unavailableResponsesRemaining = 2
const responseAvailability = globalThis as typeof globalThis & {
  markResponseUnavailable: (retryAfterSeconds?: number) => void
}

export default function ServerResponseRecoveryPage({ searchParams }: PageProps) {
  const scenario = String(searchParams.case)

  if (scenario === 'recovery' && unavailableResponsesRemaining > 0) {
    unavailableResponsesRemaining -= 1
    responseAvailability.markResponseUnavailable()
  }

  return (
    <main>
      <h1>Server response recovery</h1>
      <p data-testid="responses-until-healthy">{unavailableResponsesRemaining}</p>
    </main>
  )
}
