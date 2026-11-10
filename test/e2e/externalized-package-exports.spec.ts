import { expect, test } from '@playwright/test'

test('renders named exports from externalized packages in production HTML', async ({ request }) => {
  const response = await request.get('/external-package', {
    headers: { accept: 'text/html' },
  })

  expect(response.ok()).toBe(true)

  const html = await response.text()
  expect(html).toMatch(/<svg\b[^>]+class="[^"]*\blucide-search\b[^"]*"[^>]*>/)
})
