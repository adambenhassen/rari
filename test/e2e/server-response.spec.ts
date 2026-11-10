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

  test('recovers at the same URL and caches the first healthy response', async ({ request }) => {
    const url = '/server-response-recovery?case=recovery'
    const unavailableFirst = await request.get(url)
    const unavailableSecond = await request.get(url)
    const recovered = await request.get(url)
    const cachedRecovery = await request.get(url)

    expect(unavailableFirst.status()).toBe(503)
    expect(unavailableFirst.headers()['cache-control']).toBe('no-store')
    expect(unavailableSecond.status()).toBe(503)
    expect(unavailableSecond.headers()['cache-control']).toBe('no-store')

    expect(recovered.status()).toBe(200)
    expect(recovered.headers()['cache-control']).toBe('public, max-age=60')
    expect(recovered.headers()['x-cache']).toBe('MISS')
    expect(cachedRecovery.status()).toBe(200)
    expect(cachedRecovery.headers()['x-cache']).toBe('HIT')
    expect(await cachedRecovery.text()).toBe(await recovered.text())
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

  test('does not cache a late unavailable mark from streaming HTML', async ({ request }) => {
    const first = await request.get('/server-response-delayed')
    const firstBody = await first.text()
    const second = await request.get('/server-response-delayed')
    const secondBody = await second.text()

    expect(first.status()).toBe(200)
    expect(first.headers()['cache-control']).toBe('public, max-age=60')
    expect(first.headers()['x-cache']).not.toBe('HIT')
    expect(second.status()).toBe(200)
    expect(second.headers()['x-cache']).not.toBe('HIT')
    expect(secondBody).not.toBe(firstBody)
    expect(secondBody).toContain('Delayed unavailable content')
  })

  test('does not cache a late unavailable mark from streaming RSC', async ({ request }) => {
    const options = { headers: { Accept: 'text/x-component' } }
    const first = await request.get('/server-response-delayed', options)
    const firstBody = await first.text()
    const second = await request.get('/server-response-delayed', options)
    const secondBody = await second.text()

    expect(first.status()).toBe(200)
    expect(first.headers()['x-cache']).not.toBe('HIT')
    expect(firstBody).toContain('Delayed unavailable content')
    expect(second.status()).toBe(200)
    expect(second.headers()['x-cache']).not.toBe('HIT')
    expect(secondBody).not.toBe(firstBody)
    expect(secondBody).toContain('Delayed unavailable content')
  })

  test('keeps unavailable marks scoped across concurrent streaming renders', async ({ request }) => {
    const [unavailable, healthy] = await Promise.all([
      request.get('/server-response-streaming?mode=unavailable'),
      request.get('/server-response-streaming?mode=healthy'),
    ])

    expect(unavailable.status()).toBe(503)
    expect(healthy.status()).toBe(200)
    expect(unavailable.headers()['cache-control']).toBe('no-store')
    expect(unavailable.headers()['retry-after']).toBe('60')

    const healthyAfter = await request.get('/server-response-streaming?mode=healthy')
    expect(healthyAfter.status()).toBe(200)
    expect(healthyAfter.headers()['cache-control']).toBe('public, max-age=60')
  })

  test('does not cache a fallback render that marks unavailable', async ({ request }) => {
    const first = await request.get('/server-response-fallback')
    const second = await request.get('/server-response-fallback')

    expect(first.status()).toBe(503)
    expect(first.headers()['cache-control']).toBe('no-store')
    expect(second.status()).toBe(503)
    expect(second.headers()['cache-control']).toBe('no-store')
    expect(second.headers()['x-cache']).not.toBe('HIT')
    expect(await second.text()).toContain('Fallback page content')
  })
})
