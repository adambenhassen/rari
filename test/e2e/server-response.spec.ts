import { expect, test } from '@playwright/test'

test.describe('Server response status', () => {
  test('marks unavailable renders as uncacheable 503 responses', async ({ request }) => {
    const first = await request.get('/server-response?mode=unavailable')
    const firstBody = await first.text()

    expect(first.status()).toBe(503)
    expect(first.headers()['cache-control']).toBe('no-store')
    expect(first.headers()['retry-after']).toBe('60')
    expect(firstBody).toContain('<h1>Server response state</h1>')
    expect(first.headers()['x-cache']).not.toBe('HIT')

    const second = await request.get('/server-response?mode=unavailable')
    const secondBody = await second.text()

    expect(second.status()).toBe(503)
    expect(second.headers()['cache-control']).toBe('no-store')
    expect(second.headers()['retry-after']).toBe('60')
    expect(secondBody).toContain('<h1>Server response state</h1>')
    expect(secondBody).not.toBe(firstBody)
    expect(second.headers()['x-cache']).not.toBe('HIT')

    const custom = await request.get('/server-response?mode=unavailable-custom')
    expect(custom.status()).toBe(503)
    expect(custom.headers()['retry-after']).toBe('17')
  })

  test('keeps the unavailable signal scoped to the request that sets it', async ({ request }) => {
    const [unavailable, healthy] = await Promise.all([
      request.get('/server-response?mode=unavailable&case=concurrent'),
      request.get('/server-response?mode=healthy&case=concurrent'),
    ])

    expect(unavailable.status()).toBe(503)
    expect(healthy.status()).toBe(200)
    expect(healthy.headers()['cache-control']).toBe('public, max-age=60')
    expect(healthy.headers()['x-cache']).toBe('MISS')

    const healthyAfter = await request.get('/server-response?mode=healthy&case=after')
    expect(healthyAfter.status()).toBe(200)
    expect(healthyAfter.headers()['x-cache']).toBe('MISS')
  })

  test('preserves ordinary response caching and getData notFound responses', async ({ request }) => {
    const first = await request.get('/server-response?mode=healthy&case=cached')
    const second = await request.get('/server-response?mode=healthy&case=cached')

    expect(first.status()).toBe(200)
    expect(first.headers()['cache-control']).toBe('public, max-age=60')
    expect(first.headers()['x-cache']).toBe('MISS')
    expect(second.status()).toBe(200)
    expect(second.headers()['cache-control']).toBe('public, max-age=60')
    expect(second.headers()['x-cache']).toBe('HIT')
    expect(await second.text()).toBe(await first.text())

    const notFound = await request.get('/get-data-not-found/missing')
    expect(notFound.status()).toBe(404)
  })

  test('does not cache RSC responses that mark the render unavailable', async ({ request }) => {
    const options = { headers: { Accept: 'text/x-component' } }
    const first = await request.get('/server-response?mode=unavailable', options)
    const second = await request.get('/server-response?mode=unavailable', options)

    expect(first.status()).toBe(503)
    expect(first.headers()['cache-control']).toBe('no-store')
    expect(first.headers()['retry-after']).toBe('60')
    expect(second.status()).toBe(503)
    expect(second.headers()['x-cache']).not.toBe('HIT')
  })
})
