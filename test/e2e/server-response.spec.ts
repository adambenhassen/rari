import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { getRariLogPath } from './shared/helpers'

const LOG_FILE = getRariLogPath()

function unavailableLog(offset: number): string {
  if (!existsSync(LOG_FILE)) return ''

  return (
    readFileSync(LOG_FILE, 'utf8')
      .slice(offset)
      .split('\n')
      .find(line => line.includes('/server-response') && line.includes('retry_after_seconds=60')) ??
    ''
  )
}

test('returns a pre-commit mark as an uncacheable 503 response', async ({ request }) => {
  const logOffset = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').length : 0
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

  await expect.poll(() => unavailableLog(logOffset)).not.toBe('')
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
