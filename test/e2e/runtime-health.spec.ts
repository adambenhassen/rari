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
  await expect
    .poll(
      async () => {
        const response = await request.get('/_rari/health/runtime?timeout_ms=100')
        return response.status()
      },
      { message: 'runtime health detects the occupied executor', timeout: 1500 },
    )
    .toBe(503)

  expect((await blocker).status()).toBe(200)
})

test('runtime health rejects an unparseable timeout', async ({ request }) => {
  const response = await request.get('/_rari/health/runtime?timeout_ms=invalid')

  expect(response.status()).toBe(400)
})

test('runtime health rejects a zero timeout', async ({ request }) => {
  const response = await request.get('/_rari/health/runtime?timeout_ms=0')

  expect(response.status()).toBe(400)
})
