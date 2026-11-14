import { expect, test } from '@playwright/test'

const BLOG_HELLO_WORLD_URL = /\/blog\/hello-world$/
const BLOG_TYPESCRIPT_TIPS_URL = /\/blog\/typescript-tips$/
const PRODUCTS_ELECTRONICS_LAPTOP_URL = /\/products\/electronics\/laptop-123$/
const PRODUCTS_BOOKS_NOVEL_URL = /\/products\/books\/novel-456$/

test.describe('Dynamic Routes', () => {
  test.describe('Single Dynamic Segment [slug]', () => {
    test('does not share cached layout HTML between concurrent requests with getData props', async ({
      request,
    }) => {
      const cacheCase = `layout-cache-${Date.now()}-${Math.random()}`
      const primeUrl = `/get-data-props/article?case=${cacheCase}`
      const primeResponse = await request.get(primeUrl)
      const primeBody = await primeResponse.text()
      const primeDataId = /data-testid="request-data-id">(\d+)</.exec(primeBody)?.[1]
      expect(primeResponse.status()).toBe(200)
      expect(primeResponse.headers()['x-cache']).toBe('MISS')
      expect(primeDataId).toBeDefined()
      expect(primeBody).toMatch(new RegExp(`<title[^>]*>Request data ${primeDataId}</title>`))

      const [firstResponse, secondResponse] = await Promise.all([
        request.get(`/get-data-props/%61rticle?case=${cacheCase}`),
        request.get(`/get-data-props/art%69cle?case=${cacheCase}`),
      ])
      const [firstBody, secondBody] = await Promise.all([
        firstResponse.text(),
        secondResponse.text(),
      ])
      expect(firstResponse.status()).toBe(200)
      expect(secondResponse.status()).toBe(200)
      expect(firstResponse.headers()['x-cache']).toBe('MISS')
      expect(secondResponse.headers()['x-cache']).toBe('MISS')

      const dataIds = [firstBody, secondBody].map(
        body => /data-testid="request-data-id">(\d+)</.exec(body)?.[1],
      )
      expect(dataIds[0]).toBeDefined()
      expect(dataIds[1]).toBeDefined()
      expect(new Set(dataIds).size).toBe(2)

      for (const [body, dataId] of [
        [firstBody, dataIds[0]],
        [secondBody, dataIds[1]],
      ]) {
        expect(body).toMatch(new RegExp(`<title[^>]*>Request data ${dataId}</title>`))
      }

      expect(dataIds).not.toContain(primeDataId)

      const cacheHit = await request.get(primeUrl)
      expect(cacheHit.status()).toBe(200)
      expect(cacheHit.headers()['x-cache']).toBe('HIT')
      expect(await cacheHit.text()).toBe(primeBody)
    })

    test('shares getData props with metadata and render for concurrent requests to the same URL', async ({
      request,
    }) => {
      const url = `/get-data-props/article?case=same-url-${Date.now()}-${Math.random()}`
      const [firstResponse, secondResponse] = await Promise.all([
        request.get(url),
        request.get(url),
      ])
      const [firstBody, secondBody] = await Promise.all([
        firstResponse.text(),
        secondResponse.text(),
      ])
      const dataIds = [firstBody, secondBody].map(
        body => /data-testid="request-data-id">(\d+)</.exec(body)?.[1],
      )

      expect(firstResponse.status()).toBe(200)
      expect(secondResponse.status()).toBe(200)
      expect(dataIds[0]).toBeDefined()
      expect(dataIds[1]).toBeDefined()
      expect(new Set(dataIds).size).toBe(2)

      for (const [body, dataId] of [
        [firstBody, dataIds[0]],
        [secondBody, dataIds[1]],
      ]) {
        expect(body).toMatch(new RegExp(`<title[^>]*>Request data ${dataId}</title>`))
      }
    })

    test('does not cache a getData throw or invalid props', async ({ request }) => {
      for (const failure of ['throw', 'array']) {
        const url = `/get-data-props/article?getDataFailure=${failure}&case=${Date.now()}-${Math.random()}`
        const firstResponse = await request.get(url)
        const firstBody = await firstResponse.text()
        const secondResponse = await request.get(url)
        const secondBody = await secondResponse.text()

        expect(firstResponse.status()).toBe(200)
        expect(secondResponse.status()).toBe(200)
        expect(firstResponse.headers()['cache-control']).toBe('no-store')
        expect(secondResponse.headers()['cache-control']).toBe('no-store')
        expect(firstResponse.headers()['x-cache']).not.toBe('HIT')
        expect(secondResponse.headers()['x-cache']).not.toBe('HIT')
        expect(/data-testid="request-data-id">\d+</.test(firstBody)).toBe(false)
        expect(/data-testid="request-data-id">\d+</.test(secondBody)).toBe(false)

        const rscResponse = await request.get(url, { headers: { Accept: 'text/x-component' } })
        expect(rscResponse.status()).toBe(200)
        expect(rscResponse.headers()['cache-control']).toBe('no-store')
      }
    })

    test('serves a cached response when getData fails on the next request', async ({ request }) => {
      const cacheCase = `second-call-${Date.now()}-${Math.random()}`
      const url = `/get-data-props/article?getDataFailure=second-call&case=${cacheCase}`
      const firstResponse = await request.get(url)
      const firstBody = await firstResponse.text()
      const secondResponse = await request.get(url)
      const secondBody = await secondResponse.text()

      expect(firstResponse.status()).toBe(200)
      expect(firstResponse.headers()['x-cache']).toBe('MISS')
      expect(/data-testid="request-data-id">\d+</.test(firstBody)).toBe(true)
      expect(secondResponse.status()).toBe(200)
      expect(secondResponse.headers()['x-cache']).toBe('HIT')
      expect(secondBody).toBe(firstBody)
    })

    test('should render dynamic route with slug parameter', async ({ page }) => {
      await page.goto('/blog/hello-world')

      await expect(page.locator('h1')).toContainText('Blog Post: hello-world')
      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('hello-world')
    })

    test('should handle different slug values', async ({ page }) => {
      await page.goto('/blog/typescript-tips')

      await expect(page.locator('h1')).toContainText('Blog Post: typescript-tips')
      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('typescript-tips')
    })

    test('should handle slugs with special characters', async ({ page }) => {
      await page.goto('/blog/my-post-2024')

      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('my-post-2024')
    })

    test('should update metadata based on slug', async ({ page }) => {
      await page.goto('/blog/hello-world')

      const title = await page.title()
      expect(title).toContain('hello-world')
    })

    test('should navigate between different slugs', async ({ page }) => {
      await page.goto('/blog')
      await page.click('a[href="/blog/hello-world"]')

      await expect(page).toHaveURL(BLOG_HELLO_WORLD_URL)
      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('hello-world')

      await page.click('a[href="/blog"]')
      await page.click('a[href="/blog/typescript-tips"]')

      await expect(page).toHaveURL(BLOG_TYPESCRIPT_TIPS_URL)
      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('typescript-tips')
    })
  })

  test.describe('Multiple Dynamic Segments [category]/[id]', () => {
    test('should render route with multiple dynamic segments', async ({ page }) => {
      await page.goto('/products/electronics/laptop-123')

      await expect(page.locator('h1')).toContainText('Product laptop-123')
      await expect(page.locator('[data-testid="category-value"]')).toHaveText('electronics')
      await expect(page.locator('[data-testid="id-value"]')).toHaveText('laptop-123')
    })

    test('should handle different category and id combinations', async ({ page }) => {
      await page.goto('/products/books/novel-456')

      await expect(page.locator('[data-testid="category-value"]')).toHaveText('books')
      await expect(page.locator('[data-testid="id-value"]')).toHaveText('novel-456')
    })

    test('should update metadata with both params', async ({ page }) => {
      await page.goto('/products/electronics/laptop-123')

      const title = await page.title()
      expect(title).toContain('electronics')
      expect(title).toContain('laptop-123')
    })

    test('should navigate between different param combinations', async ({ page }) => {
      await page.goto('/products')
      await page.click('a[href="/products/electronics/laptop-123"]')

      await expect(page).toHaveURL(PRODUCTS_ELECTRONICS_LAPTOP_URL)
      await expect(page.locator('[data-testid="category-value"]')).toHaveText('electronics')

      await page.click('a[href="/products"]')
      await page.click('a[href="/products/books/novel-456"]')

      await expect(page).toHaveURL(PRODUCTS_BOOKS_NOVEL_URL)
      await expect(page.locator('[data-testid="category-value"]')).toHaveText('books')
    })
  })

  test.describe('Catch-All Routes [...path]', () => {
    test('should render catch-all route with single segment', async ({ page }) => {
      await page.goto('/docs/introduction')

      await expect(page.locator('h1')).toContainText('Docs: introduction')
      await expect(page.locator('[data-testid="path-length"]')).toHaveText('1')
      await expect(page.locator('[data-testid="segment-0"]')).toHaveText('introduction')
    })

    test('should render catch-all route with multiple segments', async ({ page }) => {
      await page.goto('/docs/getting-started/installation')

      await expect(page.locator('h1')).toContainText('Docs: getting-started/installation')
      await expect(page.locator('[data-testid="path-length"]')).toHaveText('2')
      await expect(page.locator('[data-testid="segment-0"]')).toHaveText('getting-started')
      await expect(page.locator('[data-testid="segment-1"]')).toHaveText('installation')
    })

    test('should render catch-all route with deeply nested path', async ({ page }) => {
      await page.goto('/docs/api/components/button/props')

      await expect(page.locator('h1')).toContainText('Docs: api/components/button/props')
      await expect(page.locator('[data-testid="path-length"]')).toHaveText('4')
      await expect(page.locator('[data-testid="segment-0"]')).toHaveText('api')
      await expect(page.locator('[data-testid="segment-1"]')).toHaveText('components')
      await expect(page.locator('[data-testid="segment-2"]')).toHaveText('button')
      await expect(page.locator('[data-testid="segment-3"]')).toHaveText('props')
    })

    test('should handle catch-all with special characters', async ({ page }) => {
      await page.goto('/docs/v2.0/api-reference')

      await expect(page.locator('[data-testid="segment-0"]')).toHaveText('v2.0')
      await expect(page.locator('[data-testid="segment-1"]')).toHaveText('api-reference')
    })

    test('should update metadata with full path', async ({ page }) => {
      await page.goto('/docs/getting-started/installation')

      const title = await page.title()
      expect(title).toContain('getting-started/installation')
    })
  })

  test.describe('Optional Catch-All Routes [[...categories]]', () => {
    test('should render optional catch-all without params', async ({ page }) => {
      await page.goto('/shop')

      await expect(page.locator('h1')).toContainText('Shop')
      await expect(page.locator('[data-testid="no-categories"]')).toBeVisible()
      await expect(page.locator('[data-testid="categories-length"]')).toHaveText('0')
    })

    test('should render optional catch-all with single category', async ({ page }) => {
      await page.goto('/shop/electronics')

      await expect(page.locator('h1')).toContainText('Shop: electronics')
      await expect(page.locator('[data-testid="categories-length"]')).toHaveText('1')
      await expect(page.locator('[data-testid="category-0"]')).toHaveText('electronics')
    })

    test('should render optional catch-all with multiple categories', async ({ page }) => {
      await page.goto('/shop/electronics/laptops')

      await expect(page.locator('h1')).toContainText('Shop: electronics > laptops')
      await expect(page.locator('[data-testid="categories-length"]')).toHaveText('2')
      await expect(page.locator('[data-testid="category-0"]')).toHaveText('electronics')
      await expect(page.locator('[data-testid="category-1"]')).toHaveText('laptops')
    })

    test('should render optional catch-all with deeply nested categories', async ({ page }) => {
      await page.goto('/shop/electronics/computers/laptops/gaming')

      await expect(page.locator('[data-testid="categories-length"]')).toHaveText('4')
      await expect(page.locator('[data-testid="category-0"]')).toHaveText('electronics')
      await expect(page.locator('[data-testid="category-1"]')).toHaveText('computers')
      await expect(page.locator('[data-testid="category-2"]')).toHaveText('laptops')
      await expect(page.locator('[data-testid="category-3"]')).toHaveText('gaming')
    })

    test('should update metadata for optional catch-all', async ({ page }) => {
      await page.goto('/shop/electronics/laptops')

      const title = await page.title()
      expect(title).toContain('electronics')
      expect(title).toContain('laptops')
    })

    test('should navigate between optional catch-all states', async ({ page }) => {
      await page.goto('/shop')
      await expect(page.locator('[data-testid="no-categories"]')).toBeVisible()

      await page.goto('/shop/electronics')
      await expect(page.locator('[data-testid="categories-length"]')).toHaveText('1')

      await page.goto('/shop/electronics/laptops')
      await expect(page.locator('[data-testid="categories-length"]')).toHaveText('2')

      await page.goto('/shop')
      await expect(page.locator('[data-testid="no-categories"]')).toBeVisible()
    })
  })

  test.describe('URL Encoding and Special Cases', () => {
    test('should handle URL-encoded characters in dynamic segments', async ({ page }) => {
      await page.goto('/blog/hello%20world')

      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('hello world')
    })

    test('should handle hyphens and underscores', async ({ page }) => {
      await page.goto('/blog/my-awesome_post')

      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('my-awesome_post')
    })

    test('should handle numeric slugs', async ({ page }) => {
      await page.goto('/blog/12345')

      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('12345')
    })

    test('should handle mixed case slugs', async ({ page }) => {
      await page.goto('/blog/MyBlogPost')

      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('MyBlogPost')
    })
  })

  test.describe('Navigation and State', () => {
    test('should preserve params during client-side navigation', async ({ page }) => {
      await page.goto('/blog')
      await page.waitForLoadState('networkidle')

      await page.click('a[href="/blog/hello-world"]')
      await page.waitForLoadState('networkidle')

      await expect(page).toHaveURL(BLOG_HELLO_WORLD_URL)
      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('hello-world')
    })

    test('should handle back/forward navigation with dynamic routes', async ({ page }) => {
      await page.goto('/blog/hello-world')
      await page.waitForLoadState('networkidle')

      await page.goto('/blog/typescript-tips')
      await page.waitForLoadState('networkidle')

      await page.goBack()
      await expect(page).toHaveURL(BLOG_HELLO_WORLD_URL)
      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('hello-world')

      await page.goForward()
      await expect(page).toHaveURL(BLOG_TYPESCRIPT_TIPS_URL)
      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('typescript-tips')
    })

    test('should reload dynamic route correctly', async ({ page }) => {
      await page.goto('/blog/hello-world')
      await page.waitForLoadState('networkidle')

      await page.reload()
      await page.waitForLoadState('networkidle')

      await expect(page.locator('[data-testid="slug-value"]')).toHaveText('hello-world')
    })
  })

  test.describe('Error Cases', () => {
    test('should handle empty catch-all gracefully', async ({ page }) => {
      const response = await page.goto('/docs/')
      expect(response?.status()).toBe(404)
    })

    test('should handle trailing slashes', async ({ page }) => {
      await page.goto('/blog/hello-world/')

      await expect(page.locator('h1')).toBeVisible()
    })
  })
})
