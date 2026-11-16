export function generateStaticParams() {
  return [{ slug: 'hit' }]
}

let calls = 0

export function getData() {
  calls += 1
  return { props: { calls } }
}

export default function LoadedPage({ calls }: Readonly<{ calls: number }>) {
  return <p data-testid="loaded-data-calls">{calls}</p>
}
