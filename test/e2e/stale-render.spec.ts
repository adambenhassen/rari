import { existsSync, readFileSync, statSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { getRariLogPath } from './shared/helpers'

const LOG_FILE = getRariLogPath()

function readNewLogs(offset: number): string {
  if (!existsSync(LOG_FILE)) return ''

  return readFileSync(LOG_FILE, 'utf8').slice(offset)
}

test('does not serve a stale element after a composition failure', async ({ request }) => {
  const logOffset = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0
  const source = await request.get('/stale-render/source')
  expect(await source.text()).toContain('STALE_RENDER_SOURCE_MARKER')

  const failed = await request.get('/stale-render/failure')
  const failedBody = await failed.text()

  expect(failedBody).not.toContain('STALE_RENDER_SOURCE_MARKER')
  expect(failedBody).not.toContain('FAILED_RENDER_PAGE_MARKER')

  await expect.poll(() => readNewLogs(logOffset)).toContain('Static document render failed')
  expect(readNewLogs(logOffset)).toContain('Intentional root layout composition failure')

  const recovered = await request.get('/stale-render/source')
  expect(await recovered.text()).toContain('STALE_RENDER_SOURCE_MARKER')
})
