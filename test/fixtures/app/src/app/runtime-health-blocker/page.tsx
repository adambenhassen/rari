import type { PageProps } from 'rari'

function occupyRuntime() {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    // Keep the single JS runtime occupied while the health probe runs.
  }
}

export default function RuntimeHealthBlockerPage({ searchParams }: PageProps) {
  if (String(searchParams.block) === '1') {
    occupyRuntime()
  }

  return (
    <main>
      <h1>Runtime executor blocker</h1>
    </main>
  )
}
