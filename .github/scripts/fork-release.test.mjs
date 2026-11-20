import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

process.env.GITEA_REPOSITORY = 'adambenhassen/rari'
process.env.GITEA_API_URL = 'https://gitea.example/api/v1'
process.env.GITEA_TOKEN = 'test-token'
process.env.RELEASE_VERSION = '0.17.9-fork.99-test.1'
process.env.RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567'
delete process.env.DELETE_TEST_RELEASE

const { publishRelease } = await import('./fork-release.mjs')

test('creates a draft release, uploads assets, then publishes and waits for its mirrored tag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rari-fork-release-'))
  const asset = join(directory, 'rari-linux-x64.tgz')
  await writeFile(asset, 'test asset')

  const events = []
  const request = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
      events.push('list releases')
      return { response: { ok: true, status: 200 }, data: [] }
    }

    if (method === 'POST' && path.endsWith('/releases')) {
      events.push('create draft')
      assert.deepEqual(JSON.parse(options.body), {
        tag_name: 'build-0.17.9-fork.99-test.1',
        target_commitish: process.env.RELEASE_SHA,
        name: 'build-0.17.9-fork.99-test.1',
        body: `Fork prerelease built from commit ${process.env.RELEASE_SHA}.\n\nIncludes Linux x64 and ARM64 npm tarballs, binaries, and debug sidecars.`,
        draft: true,
        prerelease: true,
      })
      return { response: { ok: true, status: 201 }, data: { id: 42, draft: true } }
    }

    if (method === 'GET' && path.endsWith('/releases/42/assets')) {
      events.push('verify assets')
      return { response: { ok: true, status: 200 }, data: [{ name: basename(asset) }] }
    }

    if (method === 'PATCH' && path.endsWith('/releases/42')) {
      events.push('publish release')
      assert.deepEqual(JSON.parse(options.body), { draft: false })
      return { response: { ok: true, status: 200 }, data: { id: 42, draft: false } }
    }

    assert.fail(`Unexpected Gitea request: ${method} ${path}`)
  }

  try {
    await publishRelease({
      request,
      uploadAsset: async (releaseId, filePath) => {
        events.push(`upload ${releaseId}`)
        assert.equal(filePath, asset)
        return { name: basename(filePath) }
      },
      waitForMirrorTag: async ({ shouldExist, expectedSha }) => {
        events.push('wait for mirrored tag')
        assert.equal(shouldExist, true)
        assert.equal(expectedSha, process.env.RELEASE_SHA)
      },
      assets: [asset],
      log: () => {},
    })

    assert.deepEqual(events, [
      'list releases',
      'create draft',
      'upload 42',
      'verify assets',
      'publish release',
      'wait for mirrored tag',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects deletion of a release version before making a request', async () => {
  const previousVersion = process.env.RELEASE_VERSION
  const previousDelete = process.env.DELETE_TEST_RELEASE
  const previousFetch = globalThis.fetch
  let requestCount = 0

  process.env.RELEASE_VERSION = '0.17.9-fork.100'
  process.env.DELETE_TEST_RELEASE = 'true'
  globalThis.fetch = async () => {
    requestCount += 1
    throw new Error('unexpected request')
  }

  try {
    const guardedModule = new URL('./fork-release.mjs?reject-production-delete', import.meta.url)
    await assert.rejects(
      import(guardedModule.href),
      /Only a test prerelease version can be deleted/,
    )
    assert.equal(requestCount, 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousVersion === undefined) delete process.env.RELEASE_VERSION
    else process.env.RELEASE_VERSION = previousVersion
    if (previousDelete === undefined) delete process.env.DELETE_TEST_RELEASE
    else process.env.DELETE_TEST_RELEASE = previousDelete
  }
})

test('deletes only the selected test release and tag', async () => {
  const previousVersion = process.env.RELEASE_VERSION
  const previousDelete = process.env.DELETE_TEST_RELEASE
  const version = '0.17.9-fork.100-test.2'
  const tag = `build-${version}`
  const testRelease = { id: 42, tag_name: tag }
  const productionRelease = { id: 43, tag_name: 'build-0.17.9-fork.99' }
  const releases = [testRelease, productionRelease]
  const deletedReleaseIds = []
  const deletedTags = []
  const events = []

  process.env.RELEASE_VERSION = version
  process.env.DELETE_TEST_RELEASE = 'true'

  try {
    const cleanupModule = new URL('./fork-release.mjs?delete-test-release', import.meta.url)
    const { deleteTestRelease } = await import(cleanupModule.href)
    const request = async (path, options = {}) => {
      const method = options.method ?? 'GET'
      if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
        events.push('list releases')
        return {
          response: { ok: true, status: 200 },
          data: releases.filter(release => !deletedReleaseIds.includes(release.id)),
        }
      }

      if (method === 'DELETE' && path === '/repos/adambenhassen/rari/releases/42') {
        events.push('delete selected release')
        deletedReleaseIds.push(42)
        return { response: { ok: true, status: 204 }, data: null }
      }

      if (method === 'DELETE' && path === `/repos/adambenhassen/rari/tags/${tag}`) {
        events.push('delete selected tag')
        deletedTags.push(tag)
        return { response: { ok: true, status: 204 }, data: null }
      }

      assert.fail(`Unexpected Gitea request: ${method} ${path}`)
    }

    await deleteTestRelease({
      request,
      waitForMirrorTag: async ({ shouldExist }) => {
        events.push('wait for mirror deletion')
        assert.equal(shouldExist, false)
      },
      log: () => {},
    })

    assert.deepEqual(deletedReleaseIds, [testRelease.id])
    assert.deepEqual(deletedTags, [tag])
    assert.deepEqual(events, [
      'list releases',
      'delete selected release',
      'delete selected tag',
      'wait for mirror deletion',
      'list releases',
    ])
  } finally {
    if (previousVersion === undefined) delete process.env.RELEASE_VERSION
    else process.env.RELEASE_VERSION = previousVersion
    if (previousDelete === undefined) delete process.env.DELETE_TEST_RELEASE
    else process.env.DELETE_TEST_RELEASE = previousDelete
  }
})
