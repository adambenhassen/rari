import { headers } from 'rari/headers'

export default async function CacheRenderSessionPage() {
  const session = (await headers()).get('x-session') ?? 'anonymous'
  return <p>{`Session ${session}`}</p>
}
