import { readdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { waitForCacheWarmup } from './shared/cache-warmup-helpers'
import './shared/cache-warmup-concurrency'

test.describe('Cache warmup', () => {
  test.beforeAll(async () => {
    await waitForCacheWarmup()
  })

  test('passes getData props to statically parameterized dynamic routes', async ({ request }) => {
    const response = await request.get('/get-data-props/warmup')
    const body = await response.text()
    const dataId = /data-testid="request-data-id">(\d+)</.exec(body)?.[1]

    expect(response.status()).toBe(200)
    expect(response.headers()['x-cache']).toBe('HIT')
    expect(dataId).toBeDefined()
    expect(body).toMatch(new RegExp(`<title[^>]*>Request data ${dataId}</title>`))
  })

  test('calls getData before serving a static fast-cache hit', async ({ request }) => {
    const probeCase = `${Date.now()}-${Math.random()}`
    const before = await request.get(`/get-data-props/fast-cache?case=${probeCase}-before`)
    const beforeCount = Number(
      /data-testid="get-data-call-count">(\d+)</.exec(await before.text())?.[1],
    )
    const cached = await request.get('/get-data-props/fast-cache')
    const after = await request.get(`/get-data-props/fast-cache?case=${probeCase}-after`)
    const afterCount = Number(
      /data-testid="get-data-call-count">(\d+)</.exec(await after.text())?.[1],
    )

    expect(before.status()).toBe(200)
    expect(before.headers()['x-cache']).not.toBe('HIT')
    expect(cached.status()).toBe(200)
    expect(cached.headers()['x-cache']).toBe('HIT')
    expect(after.status()).toBe(200)
    expect(after.headers()['x-cache']).not.toBe('HIT')
    expect(Number.isSafeInteger(beforeCount)).toBe(true)
    expect(afterCount).toBe(beforeCount + 2)
  })

  test('runs getData on static routes before a cached response', async ({ request }) => {
    const url = `/get-data-static?case=${Date.now()}-${Math.random()}`
    const first = await request.get(url)
    expect(first.status()).toBe(200)
    expect(first.headers()['x-cache']).toBe('MISS')
    expect(await first.text()).toContain('<h1>Static page data</h1>')

    const removed = await request.get(url)
    expect(removed.status()).toBe(404)
    expect(removed.headers()['cache-control']).toBe('no-store')
    expect(removed.headers()['x-cache']).not.toBe('HIT')
  })

  test('checks a metadata export that becomes available after caching', async ({ request }) => {
    const url = `/cache-availability-late/${Date.now()}-${Math.random()}`
    const healthy = await request.get(url)
    expect(healthy.status()).toBe(200)
    expect(healthy.headers()['x-cache']).toBe('MISS')

    const unavailable = await request.get(url)
    expect(unavailable.status()).toBe(503)
    expect(unavailable.headers()['cache-control']).toBe('no-store')
    expect(unavailable.headers()['retry-after']).toBe('17')
    expect(unavailable.headers()['x-cache']).not.toBe('HIT')
  })

  test('runs loaded getData on fast hits without inspecting the bundle', async ({ request }) => {
    const directory = resolve(
      import.meta.dirname,
      '../fixtures/app/dist/server/app/get-data-loaded/_slug_',
    )
    const pageFile = (await readdir(directory)).find(
      name => name.startsWith('page_') && name.endsWith('.js'),
    )
    if (pageFile == null) throw new Error('Page bundle not found')
    const bundle = join(directory, pageFile)
    const hidden = `${bundle}.unavailable`
    const probe = `/get-data-loaded/hit?case=${Date.now()}-${Math.random()}`
    const before = await request.get(`${probe}-before`)
    const beforeCount = Number(
      /data-testid="loaded-data-calls">(\d+)</.exec(await before.text())?.[1],
    )

    await rename(bundle, hidden)
    try {
      const cached = await request.get('/get-data-loaded/hit')
      expect(cached.status()).toBe(200)
      expect(cached.headers()['x-cache']).toBe('HIT')
      expect(cached.headers()['cache-control']).not.toBe('no-store')
    } finally {
      await rename(hidden, bundle)
    }

    const after = await request.get(`${probe}-after`)
    const afterCount = Number(
      /data-testid="loaded-data-calls">(\d+)</.exec(await after.text())?.[1],
    )
    expect(Number.isSafeInteger(beforeCount)).toBe(true)
    expect(afterCount).toBe(beforeCount + 2)
  })

  test('does not cache a page whose bundle cannot be inspected', async ({ request }) => {
    const directory = resolve(
      import.meta.dirname,
      '../fixtures/app/dist/server/app/get-data-recovery/_slug_',
    )
    const pageFile = (await readdir(directory)).find(
      name => name.startsWith('page_') && name.endsWith('.js'),
    )
    if (pageFile == null) throw new Error('Page bundle not found')
    const bundle = join(directory, pageFile)
    const hidden = `${bundle}.unavailable`
    const url = `/get-data-recovery/article?case=${Date.now()}-${Math.random()}`

    await rename(bundle, hidden)
    try {
      const unavailable = await request.get(url)
      expect.soft(unavailable.headers()['cache-control']).toBe('no-store')
      expect.soft(unavailable.headers()['x-cache']).not.toBe('HIT')
    } finally {
      await rename(hidden, bundle)
    }

    const recovered = await request.get(url)
    expect(recovered.status()).toBe(404)
    expect(recovered.headers()['cache-control']).toBe('no-store')
    expect(recovered.headers()['x-cache']).not.toBe('HIT')
  })

  test('does not cache a statically parameterized route whose getData fails in warmup', async ({
    request,
  }) => {
    const response = await request.get('/get-data-props/warmup-failure')

    expect(response.status()).toBe(200)
    expect(response.headers()['x-cache']).not.toBe('HIT')
  })

  test('does not cache a statically parameterized route marked unavailable by metadata', async ({
    request,
  }) => {
    const response = await request.get('/get-data-props/unavailable')

    expect(response.status()).toBe(503)
    expect(response.headers()['cache-control']).toBe('no-store')
    expect(response.headers()['retry-after']).toBe('60')
    expect(response.headers()['x-cache']).not.toBe('HIT')
  })
})
