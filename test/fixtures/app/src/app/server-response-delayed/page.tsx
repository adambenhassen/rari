import type { PageProps } from 'rari'
import { Suspense } from 'react'

declare global {
  var markResponseUnavailable: (retryAfterSeconds?: number) => void
}

export default function DelayedServerResponsePage(_params: PageProps) {
  return (
    <main>
      <h1>Delayed server response state</h1>
      <Suspense fallback={<p>Checking service state...</p>}>
        <DelayedUnavailableContent />
      </Suspense>
    </main>
  )
}

async function DelayedUnavailableContent() {
  await new Promise(resolve => setTimeout(resolve, 150))
  globalThis.markResponseUnavailable(23)
  return <p>Delayed unavailable content {crypto.randomUUID()}</p>
}
