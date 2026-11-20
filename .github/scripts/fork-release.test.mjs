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
