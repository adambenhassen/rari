import { expect, test } from '@playwright/test'

test('runtime health checks execute the JavaScript runtime', async ({ request }) => {
  const response = await request.get('/_rari/health/runtime')

  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({
    status: 'ok',
    runtime: 'responsive',
  })
})

test('runtime health reports unavailable when the executor is occupied', async ({ request }) => {
  const blocker = request.get('/runtime-health-blocker?block=1')
  await new Promise(resolve => setTimeout(resolve, 200))

  const response = await request.get('/_rari/health/runtime?timeout_ms=100')

  expect(response.status()).toBe(503)
  expect((await blocker).status()).toBe(200)
})
