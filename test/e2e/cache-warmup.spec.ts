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

  test('does not call getData for static fast-cache hits', async ({ request }) => {
    const cached = await request.get('/get-data-props/fast-cache')
    const probeCase = `${Date.now()}-${Math.random()}`
    const probe = await request.get(`/get-data-props/fast-cache?case=${probeCase}`)
    const probeBody = await probe.text()
    const getDataCallCount = /data-testid="get-data-call-count">(\d+)</.exec(probeBody)?.[1]

    expect(cached.status()).toBe(200)
    expect(cached.headers()['x-cache']).toBe('HIT')
    expect(probe.headers()['x-cache']).not.toBe('HIT')
    expect(getDataCallCount).toBe('2')
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
