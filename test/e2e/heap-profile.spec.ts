import { expect, test } from '@playwright/test'

test('returns a jemalloc heap profile as pprof bytes', async ({ request }) => {
  const response = await request.get('/_rari/debug/heap', {
    headers: { 'x-rari-profiling-token': 'e2e-profiling-token' },
  })

  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('application/octet-stream')
  expect(response.headers()['cache-control']).toBe('no-store')
  const profile = await response.body()
  expect([...profile.subarray(0, 2)]).toEqual([0x1f, 0x8b])
})

test('requires a valid token for heap profile requests', async ({ request }) => {
  const missing = await request.get('/_rari/debug/heap')

  expect(missing.status()).toBe(401)
  expect(missing.headers()['cache-control']).toBe('no-store')

  const invalid = await request.get('/_rari/debug/heap', {
    headers: { 'x-rari-profiling-token': 'invalid-profiling-token' },
  })

  expect(invalid.status()).toBe(401)
  expect(invalid.headers()['cache-control']).toBe('no-store')
})
