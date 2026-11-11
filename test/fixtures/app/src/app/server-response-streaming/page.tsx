export default async function ServerResponseStreamingPage() {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 250)
  })
  globalThis.markResponseUnavailable(17)

  return (
    <main>
      <h1>Streaming server response state</h1>
      <p>Marked after suspense</p>
    </main>
  )
}
