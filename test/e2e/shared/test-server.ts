import type { Server } from 'node:http'

export async function listen(server: Readonly<Server>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('Missing TCP address')
  return address.port
}

export async function close(server: Readonly<Server>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}
