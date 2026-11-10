const responseAvailability = globalThis as typeof globalThis & {
  markResponseUnavailable: (retryAfterSeconds?: number) => void
}
const rariRuntime = globalThis as typeof globalThis & {
  '~rari'?: { streaming?: { enabled?: boolean } }
}

export default function FallbackServerResponsePage() {
  if (rariRuntime['~rari']?.streaming?.enabled)
    throw new Error('Force static fallback')

  responseAvailability.markResponseUnavailable()

  return (
    <main>
      <h1>Fallback server response state</h1>
      <p>Fallback page content</p>
    </main>
  )
}
