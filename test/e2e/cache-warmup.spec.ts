import { expect, test } from '@playwright/test'
import { waitForCacheWarmup } from './shared/cache-warmup-helpers'

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
