import { expect, test } from '@playwright/test'

test('returns a pre-commit mark as an uncacheable 503 response', async ({ request }) => {
  const url = '/server-response?mode=unavailable'
  const first = await request.get(url)
  const firstBody = await first.text()

  expect(first.status()).toBe(503)
  expect(first.headers()['cache-control']).toBe('no-store')
  expect(first.headers()['retry-after']).toBe('60')
  expect(firstBody).toContain('<h1>Server response state</h1>')
  expect(first.headers()['x-cache']).not.toBe('HIT')

  const second = await request.get(url)
  const secondBody = await second.text()

  expect(second.status()).toBe(503)
  expect(second.headers()['cache-control']).toBe('no-store')
  expect(second.headers()['retry-after']).toBe('60')
  expect(secondBody).toContain('<h1>Server response state</h1>')
  expect(second.headers()['x-cache']).not.toBe('HIT')
})

test('marks metadata collection unavailable for only its request', async ({ request }) => {
  const caseId = `metadata-${Date.now()}-${Math.random()}`
  const unavailableUrl = `/server-response-metadata?mode=unavailable&case=${caseId}`
  const first = await request.get(unavailableUrl)
  const second = await request.get(unavailableUrl)
  const secondBody = await second.text()

  for (const response of [first, second]) {
    expect(response.status()).toBe(503)
    expect(response.headers()['cache-control']).toBe('no-store')
    expect(response.headers()['retry-after']).toBe('60')
    expect(response.headers()['x-cache']).not.toBe('HIT')
  }
  expect(await first.text()).toContain('<h1>Metadata server response state</h1>')
  expect(secondBody).toContain('<h1>Metadata server response state</h1>')

  const healthyUrl = `/server-response-metadata?mode=healthy&case=${caseId}-healthy`
  const [healthy, unavailableAgain] = await Promise.all([
    request.get(healthyUrl),
    request.get(`/server-response-metadata?mode=unavailable&case=${caseId}-concurrent`),
  ])

  expect(unavailableAgain.status()).toBe(503)
  expect(healthy.status()).toBe(200)
  expect(healthy.headers()['cache-control']).toBe('public, max-age=60')
  expect(healthy.headers()['x-cache']).toBe('MISS')

  const cachedHealthy = await request.get(healthyUrl)
  expect(cachedHealthy.status()).toBe(200)
  expect(cachedHealthy.headers()['x-cache']).toBe('HIT')
})

test('keeps the committed status when marked after headers', async ({ request }) => {
  const url = '/server-response-streaming'
  const first = await request.get(url)
  const firstBody = await first.text()

  expect(first.status()).toBe(200)
  expect(first.headers()['x-render-mode']).toBe('streaming')
  expect(first.headers()['retry-after']).toBeUndefined()
  expect(firstBody).toContain('Marked after suspense')

  const second = await request.get(url)
  const secondBody = await second.text()

  expect(second.status()).toBe(200)
  expect(secondBody).toContain('Marked after suspense')
})
