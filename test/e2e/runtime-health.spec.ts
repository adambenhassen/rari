import { expect, test } from '@playwright/test'

test('runtime health checks execute the JavaScript runtime', async ({ request }) => {
  const response = await request.get('/_rari/health/runtime')

  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({
    status: 'ok',
    runtime: 'responsive',
  })
})

test('runtime health reports unavailable when the runtime misses its deadline', async ({
  request,
}) => {
  const response = await request.get('/_rari/health/runtime?timeout_ms=0')

  expect(response.status()).toBe(503)
})
