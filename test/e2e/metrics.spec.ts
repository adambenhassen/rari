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
