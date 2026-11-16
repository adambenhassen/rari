import type { Server, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { readdir, rename } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, resolve as resolvePath } from 'node:path'
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

test('Cache warmup cannot overwrite live renders or an action invalidation', async ({
  request,
}) => {
  test.setTimeout(90_000)
  const held = new Map<string, ServerResponse>()
  const seen: string[] = []
  const backend = createServer((incoming, response) => {
    const slug = new URL(incoming.url ?? '/', 'http://localhost').pathname.slice(1)
    if (slug === 'tag-target') {
      response.end('new')
      return
    }
    if (!held.has(slug)) {
      held.set(slug, response)
      seen.push(slug)
    } else {
      response.end('new')
    }
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
        RARI_TEST_RACE_BACKEND: `http://127.0.0.1:${backendPort}`,
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
    await expect.poll(() => seen.length, { timeout: 60_000 }).toBe(1)
    const first = seen.at(0)
    if (first == null) throw new Error('Missing first warmup route')
    const firstUrl = `${origin}/warmup-race/${first}`
    const live = await request.get(firstUrl)
    expect(live.status()).toBe(200)
    expect(live.headers()['x-cache']).toBe('MISS')
    expect(await live.text()).toContain('>new</h1>')
    const liveRsc = await request.get(firstUrl, { headers: { Accept: 'text/x-component' } })
    expect(liveRsc.status()).toBe(200)
    expect(liveRsc.headers()['x-cache']).toBe('MISS')
    expect(await liveRsc.text()).toContain('"new"')
    held.get(first)?.end('old')

    await expect.poll(() => seen.length, { timeout: 60_000 }).toBe(2)
    const second = seen.at(1)
    if (second == null) throw new Error('Missing second warmup route')
    const actionDir = resolvePath(
      import.meta.dirname,
      '../../fixtures/app/dist/server/app/get-data-props/_slug_',
    )
    const actionBundle = (await readdir(actionDir)).find(
      name => name.startsWith('actions_') && name.endsWith('.js'),
    )
    if (actionBundle == null) throw new Error('Action bundle not found')
    const actionId = `app/get-data-props/_slug_/${basename(actionBundle, '.js')}#refreshGetData`
    const refresh = async (path: string) => {
      const action = await request.post(`${origin}${path}`, {
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'rsc-action-id': actionId,
          'rari-router-state': JSON.stringify({ pathname: path, search: '' }),
          'Origin': origin,
        },
        data: '[]',
      })
      expect(action.status()).toBe(200)
      expect(action.headers()['x-action-revalidated']).toBe('2')
      expect(action.headers()['x-action-revalidated-path']).toBe(path)
    }
    const secondPath = `/warmup-race/${second}`
    await refresh(secondPath)
    held.get(second)?.end('old')

    await expect.poll(() => seen.length, { timeout: 60_000 }).toBe(3)
    expect(seen.at(2)).toBe('tagged')
    await refresh('/warmup-race/tag-target')
    held.get('tagged')?.end('old')
    await expect
      .poll(() => logs.includes('Cache warmup: Completed'), { timeout: 60_000 })
      .toBe(true)

    const htmlHit = await request.get(firstUrl)
    expect.soft(htmlHit.headers()['x-cache']).toBe('HIT')
    expect.soft((await htmlHit.text()).includes('>new</h1>'), 'live HTML remains cached').toBe(true)
    const rscHit = await request.get(firstUrl, { headers: { Accept: 'text/x-component' } })
    expect.soft(rscHit.headers()['x-cache']).toBe('HIT')
    expect.soft((await rscHit.text()).includes('"new"'), 'live RSC remains cached').toBe(true)
    const afterInvalidation = await request.get(`${origin}${secondPath}`)
    expect.soft(afterInvalidation.headers()['x-cache']).toBe('MISS')
    expect
      .soft(
        (await afterInvalidation.text()).includes('>new</h1>'),
        'invalidated HTML is rendered again',
      )
      .toBe(true)
    const afterTagInvalidation = await request.get(`${origin}/warmup-race/tagged`)
    expect.soft(afterTagInvalidation.headers()['x-cache']).toBe('MISS')
    expect
      .soft(
        (await afterTagInvalidation.text()).includes('>new</h1>'),
        'tagged HTML is rendered again',
      )
      .toBe(true)
  } finally {
    for (const response of held.values()) {
      if (!response.writableEnded) response.end('old')
    }
    child.kill('SIGTERM')
    await exited
    await close(backend)
  }
})

test('Cache warmup invalidates fast hits by tag after publication', async ({ request }) => {
  test.setTimeout(90_000)
  let version = 'old'
  const backend = createServer((_incoming, response) => {
    response.end(version)
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
        RARI_TEST_RACE_BACKEND: `http://127.0.0.1:${backendPort}`,
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
      .poll(() => logs.includes('Cache warmup: Completed'), { timeout: 60_000 })
      .toBe(true)
    const url = `${origin}/warmup-race/tagged`
    const warmed = await request.get(url)
    expect(warmed.headers()['x-cache']).toBe('HIT')
    expect(await warmed.text()).toContain('>old</h1>')

    const actionDir = resolvePath(
      import.meta.dirname,
      '../../fixtures/app/dist/server/app/get-data-props/_slug_',
    )
    const actionBundle = (await readdir(actionDir)).find(
      name => name.startsWith('actions_') && name.endsWith('.js'),
    )
    if (actionBundle == null) throw new Error('Action bundle not found')
    const actionId = `app/get-data-props/_slug_/${basename(actionBundle, '.js')}#refreshGetData`
    const path = '/warmup-race/tag-target'
    const refresh = async () => {
      const action = await request.post(`${origin}${path}`, {
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'rsc-action-id': actionId,
          'rari-router-state': JSON.stringify({ pathname: path, search: '' }),
          'Origin': origin,
        },
        data: '[]',
      })
      expect(action.status()).toBe(200)
      expect(action.headers()['x-action-revalidated-path']).toBe(path)
    }

    version = 'new'
    await refresh()
    const afterWarmupInvalidation = await request.get(url)
    expect(afterWarmupInvalidation.headers()['x-cache']).toBe('MISS')
    expect(await afterWarmupInvalidation.text()).toContain('>new</h1>')

    version = 'newer'
    await refresh()
    const afterLiveInvalidation = await request.get(url)
    expect(afterLiveInvalidation.headers()['x-cache']).toBe('MISS')
    expect(await afterLiveInvalidation.text()).toContain('>newer</h1>')
  } finally {
    child.kill('SIGTERM')
    await exited
    await close(backend)
  }
})

test('An unavailable unloaded page module does not cache a response and can recover', async ({
  request,
}) => {
  test.setTimeout(90_000)
  const directory = resolvePath(
    import.meta.dirname,
    '../../fixtures/app/dist/server/app/get-data-unloaded/_slug_',
  )
  const pageFile = (await readdir(directory)).find(
    name => name.startsWith('page_') && name.endsWith('.js'),
  )
  if (pageFile == null) throw new Error('Page bundle not found')
  const bundle = resolvePath(directory, pageFile)
  const hidden = `${bundle}.unavailable`
  const reservation = createServer()
  const port = await listen(reservation)
  await close(reservation)
  const origin = `http://127.0.0.1:${port}`
  await rename(bundle, hidden)
  let hiddenBundle = true
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
      .poll(() => logs.includes('Cache warmup: Completed'), { timeout: 60_000 })
      .toBe(true)
    const url = `${origin}/get-data-unloaded/article`
    const unavailable = await request.get(url)
    expect(unavailable.headers()['cache-control']).toBe('no-store')
    expect(unavailable.headers()['x-cache']).not.toBe('HIT')

    await rename(hidden, bundle)
    hiddenBundle = false
    const recovered = await request.get(url)
    expect(recovered.status()).toBe(404)
    expect(recovered.headers()['cache-control']).toBe('no-store')
    expect(recovered.headers()['x-cache']).not.toBe('HIT')
  } finally {
    if (hiddenBundle) await rename(hidden, bundle)
    child.kill('SIGTERM')
    await exited
  }
})
