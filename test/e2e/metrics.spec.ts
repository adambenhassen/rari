import { expect, test } from '@playwright/test'

test('exposes allocator, cache, and per-route SSR metrics', async ({ request }) => {
  await request.get('/external-package')
  await request.get('/missing-metrics-route')

  const response = await request.get('/_rari/metrics')

  expect(response.status()).toBe(200)

  const metrics = await response.text()
  expect(metrics).toContain('rari_jemalloc_allocated_bytes')
  expect(metrics).toContain('rari_response_cache_bytes')
  expect(metrics).toContain('rari_response_cache_entries')
  expect(metrics).toContain('rari_layout_cache_bytes')
  expect(metrics).toContain('rari_layout_cache_entries')
  expect(metrics).toMatch(
    /rari_ssr_request_duration_seconds_bucket\{route="\/external-package",le="\+Inf"\}/,
  )
  expect(metrics).toMatch(
    /rari_ssr_request_duration_seconds_bucket\{route="__not_found__",le="\+Inf"\}/,
  )
})

test('increments response cache hits after a repeated request', async ({ request }) => {
  const rscRequest = { headers: { accept: 'text/x-component' } }
  await request.get('/', rscRequest)
  const before = await request.get('/_rari/metrics')
  const beforeMetrics = await before.text()
  const beforeMatch = /^rari_response_cache_hits_total (\d+)$/m.exec(beforeMetrics)
  expect(beforeMatch).not.toBeNull()
  const beforeHits = Number(beforeMatch?.[1])

  const repeated = await request.get('/', rscRequest)
  expect(repeated.status()).toBe(200)
  expect(repeated.headers()['x-cache']).toBe('HIT')

  const after = await request.get('/_rari/metrics')
  const afterMetrics = await after.text()
  const afterMatch = /^rari_response_cache_hits_total (\d+)$/m.exec(afterMetrics)
  expect(afterMatch).not.toBeNull()
  const afterHits = Number(afterMatch?.[1])

  expect(afterHits).toBeGreaterThan(beforeHits)
})
