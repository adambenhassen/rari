import type { ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, resolve as resolvePath } from 'node:path'
import process from 'node:process'
import { expect, test } from '@playwright/test'
import { getBinaryPath } from '../../packages/rari/src/cli/platform'
import { close, listen } from './shared/test-server'

test('getData availability and request data preserve shared cache boundaries', async ({
  request,
}) => {
  test.setTimeout(90_000)
  let available = false
  const backend = createServer((_incoming, response) => {
    response.writeHead(available ? 200 : 503)
    response.end()
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
      cwd: resolvePath(import.meta.dirname, '../fixtures/app'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        RARI_ORIGIN: origin,
        RARI_JS_POOL_SIZE: '1',
        RARI_TEST_AVAILABILITY_BACKEND: `http://127.0.0.1:${backendPort}`,
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
    const url = `${origin}/get-data-response-unavailable/${Date.now()}-${Math.random()}`
    const unavailable = await request.get(url)
    expect(unavailable.status()).toBe(503)
    expect(unavailable.headers()['cache-control']).toBe('no-store')
    expect(unavailable.headers()['retry-after']).toBe('17')
    expect(unavailable.headers()['x-cache']).not.toBe('HIT')

    available = true
    const healthy = await request.get(url)
    expect(healthy.status()).toBe(200)
    expect(healthy.headers()['cache-control']).not.toBe('no-store')
    expect(healthy.headers()['x-cache']).toBe('MISS')

    const cachedHealthy = await request.get(url)
    expect(cachedHealthy.status()).toBe(200)
    expect(cachedHealthy.headers()['x-cache']).toBe('HIT')

    available = false
    const unavailableWarm = await request.get(url)
    expect(unavailableWarm.status()).toBe(503)
    expect(unavailableWarm.headers()['cache-control']).toBe('no-store')
    expect(unavailableWarm.headers()['retry-after']).toBe('17')
    expect(unavailableWarm.headers()['x-cache']).not.toBe('HIT')

    const modes: { name: string; headers: Record<string, string> }[] = [
      { name: 'HTML', headers: {} },
      { name: 'RSC', headers: { Accept: 'text/x-component' } },
    ]
    for (const mode of modes) {
      const slug = `${mode.name.toLowerCase()}-${Date.now()}-${Math.random()}`
      const sessionUrl = `${origin}/get-data-session/${slug}`
      const shared = await request.get(sessionUrl, { headers: mode.headers })
      expect.soft(shared.status(), `${mode.name}: shared`).toBe(200)
      expect.soft(shared.headers()['x-cache'], `${mode.name}: shared`).toBe('MISS')
      expect.soft(await shared.text(), `${mode.name}: shared body`).toContain('shared')

      for (const session of ['alice', 'bob']) {
        const personalized = await request.get(sessionUrl, {
          headers: { ...mode.headers, Cookie: `session=${session}` },
        })
        const body = await personalized.text()
        expect.soft(personalized.status(), `${mode.name}: ${session}`).toBe(200)
        expect.soft(personalized.headers()['x-cache'], `${mode.name}: ${session}`).toBe('MISS')
        expect
          .soft(personalized.headers()['cache-control'], `${mode.name}: ${session}`)
          .toBe('no-store')
        expect.soft(body, `${mode.name}: ${session} body`).toContain(session)
        expect
          .soft(body, `${mode.name}: ${session} body`)
          .not.toContain(session === 'alice' ? 'bob' : 'alice')
      }
    }

    const notFoundUrl = `${origin}/get-data-unavailable-not-found/article-${Date.now()}-${Math.random()}`
    const cachedRoute = await request.get(notFoundUrl)
    expect.soft(cachedRoute.status()).toBe(200)
    expect.soft(cachedRoute.headers()['x-cache']).toBe('MISS')
    expect.soft(await cachedRoute.text()).toContain('data-testid="not-found-cache-prime"')

    const unavailableNotFound = await request.get(notFoundUrl)
    expect.soft(unavailableNotFound.status()).toBe(404)
    expect.soft(unavailableNotFound.headers()['cache-control']).toBe('no-store')
    expect.soft(unavailableNotFound.headers()['retry-after']).toBeUndefined()
    expect.soft(unavailableNotFound.headers()['x-cache']).not.toBe('HIT')
    expect.soft(await unavailableNotFound.text()).toContain('data-testid="not-found-page"')

    const uncachedNotFoundUrl = `${origin}/get-data-unavailable-not-found/uncached-${Date.now()}-${Math.random()}`
    const uncachedUnavailableNotFound = await request.get(uncachedNotFoundUrl)
    expect(uncachedUnavailableNotFound.status()).toBe(503)
    expect(uncachedUnavailableNotFound.headers()['cache-control']).toBe('no-store')
    expect(uncachedUnavailableNotFound.headers()['retry-after']).toBe('17')
    expect(uncachedUnavailableNotFound.headers()['x-cache']).not.toBe('HIT')
  } finally {
    child.kill('SIGTERM')
    await exited
    await close(backend)
  }
})

test('Fast hits without getData do not wait for dynamic metadata', async ({ request }) => {
  test.setTimeout(90_000)
  let hold = false
  let calls = 0
  const held: ServerResponse[] = []
  const backend = createServer((_incoming, response) => {
    calls += 1
    if (hold) {
      held.push(response)
      return
    }
    response.end('healthy')
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
      cwd: resolvePath(import.meta.dirname, '../fixtures/app'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        RARI_ORIGIN: origin,
        RARI_JS_POOL_SIZE: '1',
        RARI_TEST_AVAILABILITY_BACKEND: `http://127.0.0.1:${backendPort}`,
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
    const staticCases: { path: string; headers: Record<string, string> }[] = [
      { path: '/cache-static/cookie', headers: { Cookie: 'rari-action-form-state=bnVsbA' } },
      { path: '/cache-static/rsc', headers: { Accept: 'text/x-component' } },
    ]
    for (const { path, headers } of staticCases) {
      const initial = await request.get(`${origin}${path}`, { headers })
      expect(initial.status(), path).toBe(200)
      expect(initial.headers()['x-cache'], path).toBe('MISS')
    }

    const requestDataSlug = `conditional-${Date.now()}-${Math.random()}`
    const requestDataUrl = `${origin}/cache-fast-request-data/${requestDataSlug}`
    const sharedFastResponse = await request.get(requestDataUrl)
    expect(sharedFastResponse.status()).toBe(200)
    expect(sharedFastResponse.headers()['x-cache']).toBe('MISS')
    expect(await sharedFastResponse.text()).toContain('<!-- -->shared<!-- -->)')

    const personalizedFastResponse = await request.get(requestDataUrl, {
      headers: { 'X-Session': 'alice' },
    })
    expect(personalizedFastResponse.status()).toBe(200)
    expect(personalizedFastResponse.headers()['x-cache']).toBe('MISS')
    expect(personalizedFastResponse.headers()['cache-control']).toBe('no-store')
    expect(await personalizedFastResponse.text()).toContain('<!-- -->alice<!-- -->)')

    const renderedSessionSlug = `render-${Date.now()}-${Math.random()}`
    const renderedSessionUrl = `${origin}/cache-render-session/${renderedSessionSlug}`
    const aliceRendered = await request.get(renderedSessionUrl, {
      headers: { 'X-Session': 'alice' },
    })
    expect(aliceRendered.status()).toBe(200)
    expect(aliceRendered.headers()['x-cache']).toBe('MISS')
    expect(aliceRendered.headers()['cache-control']).toBe('no-store')
    expect(await aliceRendered.text()).toContain('Session alice')

    const bobRendered = await request.get(renderedSessionUrl, {
      headers: { 'X-Session': 'bob' },
    })
    expect(bobRendered.status()).toBe(200)
    expect(bobRendered.headers()['x-cache']).toBe('MISS')
    expect(bobRendered.headers()['cache-control']).toBe('no-store')
    const bobRenderedHtml = await bobRendered.text()
    expect(bobRenderedHtml).toContain('Session bob')
    expect(bobRenderedHtml).not.toContain('Session alice')

    const publicMetadataSlug = `public-${Date.now()}-${Math.random()}`
    const publicMetadataUrl = `${origin}/cache-metadata-public-header/${publicMetadataSlug}`
    const initialPublicMetadata = await request.get(publicMetadataUrl, {
      headers: { Accept: 'text/x-component' },
    })
    expect(initialPublicMetadata.status()).toBe(200)
    expect(initialPublicMetadata.headers()['x-cache']).toBe('MISS')

    const cachedPublicMetadata = await request.get(publicMetadataUrl, {
      headers: { 'Accept': 'text/x-component', 'X-Session': 'alice' },
    })
    expect(cachedPublicMetadata.status()).toBe(200)
    expect(cachedPublicMetadata.headers()['x-cache']).toBe('HIT')
    expect(cachedPublicMetadata.headers()['cache-control']).not.toBe('no-store')

    const streamingPublicMetadataSlug = `streaming-public-${Date.now()}-${Math.random()}`
    const streamingPublicMetadataUrl = `${origin}/cache-metadata-streaming-public/${streamingPublicMetadataSlug}`
    // Streamed renders are never stored in the response cache, so assert that a
    // metadata-only header read during streaming does not force `no-store`.
    for (const session of ['alice', 'bob']) {
      const streamed = await request.get(streamingPublicMetadataUrl, {
        headers: { 'X-Session': session },
      })
      expect(streamed.status(), session).toBe(200)
      expect(streamed.headers()['x-render-mode'], session).toBe('streaming')
      expect(streamed.headers()['cache-control'], session).not.toBe('no-store')
      const streamedHtml = await streamed.text()
      expect(streamedHtml, session).toMatch(/<title[^>]*>Shared streamed metadata<\/title>/)
      expect(streamedHtml, session).toContain(
        `Streamed public page: ${streamingPublicMetadataSlug}`,
      )
    }

    const sessionMetadataSlug = `session-${Date.now()}-${Math.random()}`
    const sessionMetadataUrl = `${origin}/cache-metadata-session/${sessionMetadataSlug}`
    const aliceMetadata = await request.get(sessionMetadataUrl, {
      headers: { 'X-Session': 'alice' },
    })
    expect(aliceMetadata.status()).toBe(200)
    expect(aliceMetadata.headers()['x-cache']).toBe('MISS')
    const aliceHtml = await aliceMetadata.text()
    expect(aliceHtml).toMatch(/<title[^>]*>Session alice<\/title>/)

    const bobMetadata = await request.get(sessionMetadataUrl, {
      headers: { 'X-Session': 'bob' },
    })
    expect(bobMetadata.status()).toBe(200)
    expect(bobMetadata.headers()['x-cache']).toBe('MISS')
    expect(bobMetadata.headers()['cache-control']).toBe('no-store')
    const bobHtml = await bobMetadata.text()
    expect(bobHtml).toMatch(/<title[^>]*>Session bob<\/title>/)
    expect(bobHtml).not.toMatch(/<title[^>]*>Session alice<\/title>/)

    const aliceMetadataHit = await request.get(sessionMetadataUrl, {
      headers: { 'X-Session': 'alice' },
    })
    expect(aliceMetadataHit.status()).toBe(200)
    expect(aliceMetadataHit.headers()['x-cache']).toBe('HIT')
    expect(await aliceMetadataHit.text()).toMatch(/<title[^>]*>Session alice<\/title>/)

    hold = true
    const blockingStatic = request.get(`${origin}/cache-availability-metadata/block-static`, {
      timeout: 15_000,
    })
    try {
      await expect.poll(() => held.length, { timeout: 10_000 }).toBe(1)
      for (const { path, headers } of staticCases) {
        const hit = await request
          .get(`${origin}${path}`, { headers, timeout: 3000 })
          .catch(() => null)
        expect.soft(hit, `${path}: response-cache hit timed out`).not.toBeNull()
        if (hit != null) {
          expect(hit.status(), path).toBe(200)
          expect(hit.headers()['x-cache'], path).toBe('HIT')
        }
      }
    } finally {
      hold = false
      for (const response of held.splice(0)) response.end('healthy')
      await blockingStatic
    }
    for (const path of ['/cache-availability-metadata/slow', '/cache-availability-layout/slow']) {
      hold = false
      const url = `${origin}${path}`
      const initial = await request.get(url)
      expect(initial.status(), path).toBe(200)
      expect(initial.headers()['x-cache'], path).toBe('MISS')
      const etag = initial.headers().etag
      expect(etag, path).toBeDefined()
      hold = true
      const blocking = request.get(`${origin}/cache-availability-metadata/block-${calls}`, {
        timeout: 15_000,
      })
      try {
        await expect.poll(() => held.length, { timeout: 10_000 }).toBe(1)
        const callsBeforeHit = calls
        const hit = await request.get(url, { timeout: 3000 }).catch(() => null)
        expect.soft(hit, `${path}: fast hit timed out`).not.toBeNull()
        if (hit == null) continue
        expect(hit.status(), path).toBe(200)
        expect(hit.headers()['x-cache'], path).toBe('HIT')
        const conditional = await request.get(url, {
          headers: { 'If-None-Match': etag },
          timeout: 3000,
        })
        expect(conditional.status(), path).toBe(304)
        expect(calls, path).toBe(callsBeforeHit)
      } finally {
        hold = false
        for (const response of held.splice(0)) response.end('healthy')
        const unblocked = await blocking
        expect(unblocked.status(), path).toBe(200)
      }
    }
  } finally {
    for (const response of held) response.end('healthy')
    child.kill('SIGTERM')
    await exited
    await close(backend)
  }
})

test('Cached getData hits survive unavailable metadata', async ({ request }) => {
  test.setTimeout(90_000)
  let available = true
  let holdNext = false
  let heldResponse: ServerResponse | undefined
  const backend = createServer((_incoming, response) => {
    if (holdNext) {
      holdNext = false
      heldResponse = response
      return
    }
    response.writeHead(available ? 200 : 503)
    response.end(available ? 'healthy' : 'unavailable')
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
      cwd: resolvePath(import.meta.dirname, '../fixtures/app'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        RARI_ORIGIN: origin,
        RARI_JS_POOL_SIZE: '2',
        RARI_JS_POOL_TIMEOUT_MS: '3000',
        RARI_TEST_AVAILABILITY_BACKEND: `http://127.0.0.1:${backendPort}`,
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
    const cases: {
      path: string
      headers: Record<string, string>
      conditional: boolean
      hasGetData: boolean
    }[] = [
      { path: '/cache-availability/fast', headers: {}, conditional: false, hasGetData: true },
      { path: '/cache-availability/fast-etag', headers: {}, conditional: true, hasGetData: true },
      {
        path: '/cache-availability/response',
        headers: { Cookie: 'rari-action-form-state=bnVsbA' },
        conditional: false,
        hasGetData: true,
      },
      {
        path: '/cache-availability/response-etag',
        headers: { Cookie: 'rari-action-form-state=bnVsbA' },
        conditional: true,
        hasGetData: true,
      },
      {
        path: '/cache-availability/rsc',
        headers: { Accept: 'text/x-component' },
        conditional: false,
        hasGetData: true,
      },
      {
        path: '/cache-availability/metadata-timeout',
        headers: {},
        conditional: false,
        hasGetData: true,
      },
      {
        path: '/cache-availability-metadata/page',
        headers: { Cookie: 'rari-action-form-state=bnVsbA' },
        conditional: false,
        hasGetData: false,
      },
      {
        path: '/cache-availability-layout/page',
        headers: { Cookie: 'rari-action-form-state=bnVsbA' },
        conditional: false,
        hasGetData: false,
      },
    ]

    for (const { path, headers, conditional, hasGetData } of cases) {
      const url = `${origin}${path}`
      available = true
      const initial = await request.get(url, { headers })
      expect.soft(initial.status(), `${path}: initial`).toBe(200)
      expect.soft(initial.headers()['x-cache'], `${path}: initial`).toBe('MISS')
      const healthy = await request.get(url, { headers })
      expect.soft(healthy.status(), `${path}: healthy hit`).toBe(200)
      expect.soft(healthy.headers()['x-cache'], `${path}: healthy hit`).toBe('HIT')
      const etag = healthy.headers().etag
      const healthyBody = await healthy.text()
      if (conditional) expect.soft(etag, `${path}: etag`).toBeDefined()

      available = false
      const staleHit = await request.get(url, { headers })
      if (hasGetData) {
        expect.soft(staleHit.status(), `${path}: unavailable`).toBe(200)
        expect.soft(staleHit.headers()['cache-control'], `${path}: unavailable`).toBe('no-store')
        expect.soft(staleHit.headers()['x-cache'], `${path}: unavailable`).toBe('HIT')
        expect.soft(await staleHit.text(), `${path}: cached body`).toBe(healthyBody)
      } else {
        expect.soft(staleHit.status(), `${path}: unavailable`).toBe(503)
        expect.soft(staleHit.headers()['cache-control'], `${path}: unavailable`).toBe('no-store')
        expect.soft(staleHit.headers()['retry-after'], `${path}: unavailable`).toBe('17')
        expect.soft(staleHit.headers()['x-cache'], `${path}: unavailable`).not.toBe('HIT')
      }

      available = true
      const recovered = await request.get(url, { headers })
      expect.soft(recovered.status(), `${path}: recovered`).toBe(200)
      expect.soft(recovered.headers()['x-cache'], `${path}: recovered`).toBe('HIT')
    }

    const actionDir = resolvePath(
      import.meta.dirname,
      '../fixtures/app/dist/server/app/get-data-props/_slug_',
    )
    const actionBundle = (await readdir(actionDir)).find(
      name => name.startsWith('actions_') && name.endsWith('.js'),
    )
    if (actionBundle == null) throw new Error('Action bundle not found')
    const actionId = `app/get-data-props/_slug_/${basename(actionBundle, '.js')}#refreshGetData`
    const races: { path: string; headers: Record<string, string> }[] = [
      { path: '/cache-availability-check/race-fast', headers: {} },
      {
        path: '/cache-availability-check/race-response',
        headers: { Cookie: 'rari-action-form-state=bnVsbA' },
      },
      { path: '/cache-availability-check/race-rsc', headers: { Accept: 'text/x-component' } },
    ]
    for (const { path, headers } of races) {
      const url = `${origin}${path}`
      const initial = await request.get(url, { headers })
      expect(initial.headers()['x-cache']).toBe('MISS')
      const cached = await request.get(url, { headers })
      expect(cached.headers()['x-cache']).toBe('HIT')
      holdNext = true
      const pending = request.get(url, { headers })
      await expect.poll(() => heldResponse != null, { timeout: 10_000 }).toBe(true)
      const action = await request.post(url, {
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'rsc-action-id': actionId,
          'rari-router-state': JSON.stringify({ pathname: path, search: '' }),
          'Origin': origin,
        },
        data: '[]',
        timeout: 15_000,
      })
      expect(action.status()).toBe(200)
      expect(action.headers()['x-action-revalidated-path']).toBe(path)
      if (heldResponse == null) throw new Error('Missing held metadata response')
      heldResponse.writeHead(200)
      heldResponse.end('healthy')
      heldResponse = undefined
      const afterInvalidation = await pending
      expect.soft(afterInvalidation.status(), path).toBe(200)
      expect.soft(afterInvalidation.headers()['x-cache'], path).toBe('MISS')
    }
  } finally {
    if (heldResponse != null && !heldResponse.writableEnded) heldResponse.end('healthy')
    child.kill('SIGTERM')
    await exited
    await close(backend)
  }
})
