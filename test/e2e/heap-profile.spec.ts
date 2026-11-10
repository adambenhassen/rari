import { expect, test } from '@playwright/test'

test('returns a jemalloc heap profile as pprof bytes', async ({ request }) => {
  const response = await request.get('/_rari/debug/heap', {
    headers: { 'x-rari-profiling-token': 'e2e-profiling-token' },
  })

  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('application/octet-stream')
  expect((await response.body()).byteLength).toBeGreaterThan(0)
})
