import type { Server } from 'node:http'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import process from 'node:process'
import { expect, test } from '@playwright/test'
import { getBinaryPath } from '../../../packages/rari/src/cli/platform'

async function listen(server: Readonly<Server>): Promise<number> {
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

async function close(server: Readonly<Server>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

test('Cache warmup does not delay a slow request', async ({ request }) => {
  test.setTimeout(90_000)
  let warmupStarted = false
  let releaseWarmup = () => {}
  let releaseRequest = () => {}
  let requestCount = 0
  let warmupTimer: NodeJS.Timeout | undefined
  const backend = createServer((incoming, response) => {
    if (incoming.url === '/warmup') {
      warmupStarted = true
      releaseWarmup = () => {
        if (!response.writableEnded) response.end('ready')
      }
      warmupTimer = setTimeout(releaseWarmup, 6000)
      return
    }
    requestCount += 1
    const finishRequest = () => {
      if (response.writableEnded) return
      response.writeHead(503)
      response.end('unavailable')
    }
    if (requestCount === 3) releaseRequest = finishRequest
    else setTimeout(finishRequest, 600)
  })
  const backendPort = await listen(backend)

  const reservation = createServer()
  const port = await listen(reservation)
  await close(reservation)

  const origin = `http://127.0.0.1:${port}`
  const child = spawn(
    getBinaryPath(),
    ['--mode', 'production', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: resolvePath(import.meta.dirname, '../../fixtures/app'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        RARI_ORIGIN: origin,
        RARI_JS_POOL_SIZE: '1',
        RARI_TEST_WARMUP_BACKEND: `http://127.0.0.1:${backendPort}`,
        RUST_LOG: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let logs = ''
  child.stdout.on('data', chunk => {
    logs += String(chunk)
  })
  child.stderr.on('data', chunk => {
    logs += String(chunk)
  })
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => {
      resolve()
    })
    child.once('error', error => {
      logs += String(error)
      resolve()
    })
  })

  try {
    await expect
      .poll(() => warmupStarted, { timeout: 60_000, message: 'warmup reached the slow upstream' })
      .toBe(true)
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`${origin}/test-fetch.json`)).ok
          } catch {
            return false
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    const url = `${origin}/warmup-isolation/slow?client=yes`
    const duringStart = performance.now()
    const during = await request.get(url)
    const duringMs = performance.now() - duringStart
    releaseWarmup()
    if (warmupTimer) clearTimeout(warmupTimer)
    await expect
      .poll(() => logs.includes('Cache warmup: Completed'), { timeout: 60_000 })
      .toBe(true)

    const afterStart = performance.now()
    const after = await request.get(url)
    const afterMs = performance.now() - afterStart
    expect(during.status(), `during ${duringMs}ms; after ${afterMs}ms; ${logs}`).toBe(503)
    expect(after.status(), `during ${duringMs}ms; after ${afterMs}ms; ${logs}`).toBe(503)
    expect(during.headers()['cache-control']).toBe('no-store')
    expect(after.headers()['cache-control']).toBe('no-store')
    expect(duringMs).toBeLessThanOrEqual(afterMs + 800)

    const warmed = await request.get(`${origin}/warmup-isolation/warmed`)
    expect(warmed.status()).toBe(200)
    expect(warmed.headers()['x-cache']).toBe('HIT')

    const pending = request.get(url).then(response => response.status())
    try {
      await expect.poll(() => requestCount).toBe(3)
      const staticHit = await request.get(`${origin}/about`, { timeout: 3000 })
      expect(staticHit.status()).toBe(200)
      expect(staticHit.headers()['x-cache']).toBe('HIT')
    } finally {
      releaseRequest()
      expect(await pending).toBe(503)
    }
  } finally {
    if (warmupTimer) clearTimeout(warmupTimer)
    releaseWarmup()
    releaseRequest()
    child.kill('SIGTERM')
    await exited
    await close(backend)
  }
})
