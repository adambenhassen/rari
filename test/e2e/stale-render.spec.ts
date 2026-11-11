import { expect, test } from '@playwright/test'

test('does not serve a stale element after a composition failure', async ({ request }) => {
  const source = await request.get('/stale-render/source')
  expect(await source.text()).toContain('STALE_RENDER_SOURCE_MARKER')

  const failed = await request.get('/stale-render/failure')
  const failedBody = await failed.text()

  expect(failedBody).not.toContain('STALE_RENDER_SOURCE_MARKER')
  expect(failedBody).not.toContain('FAILED_RENDER_PAGE_MARKER')
})
