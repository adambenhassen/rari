import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

process.env.GITEA_REPOSITORY = 'adambenhassen/rari'
process.env.GITEA_API_URL = 'https://gitea.example/api/v1'
process.env.GITEA_TOKEN = 'test-token'
process.env.RELEASE_VERSION = '0.17.9-fork.99-test.1'
process.env.RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567'
delete process.env.DELETE_TEST_RELEASE

const { deleteTestRelease, publishRelease, waitForGithubMirrorTag } =
  await import('./fork-release.mjs')
const skipTagCheck = async () => {}
const skipOperationLock = operation => operation()

test('builds each release architecture on its assigned runner and publishes combined assets', async () => {
  const workflow = await readFile(new URL('../workflows/fork-build.yml', import.meta.url), 'utf8')
  const build = workflow.slice(
    workflow.indexOf('  build:'),
    workflow.indexOf('  check-snapshot-profile-diagnostic:'),
  )
  assert.match(build, /runs-on: \$\{\{ matrix\.runner \}\}/)
  assert.match(build, /- arch: x64\s+runner: ubuntu-24\.04/)
  assert.match(build, /- arch: arm64\s+runner: arm64/)
  assert.match(build, /timeout-minutes: 175/)
  assert.match(build, /name: fork-release-assets-\$\{\{ matrix\.arch \}\}/)
  assert.match(build, /name: Generate x64 V8 snapshot\s+if: matrix\.arch == 'x64'/)
  assert.match(build, /name: Generate ARM64 V8 snapshot\s+if: matrix\.arch == 'arm64'/)
  assert.match(build, /name: Build Linux ARM64 binary\s+if: matrix\.arch == 'arm64'/)
  assert.doesNotMatch(
    build,
    /qemu-aarch64-static|aarch64-linux-gnu|aarch64-unknown-linux-gnu|PKG_CONFIG_ALLOW_CROSS|CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER/,
  )

  const buildStep = name => {
    const marker = `      - name: ${name}\n`
    const start = build.indexOf(marker)
    assert.notEqual(start, -1, `missing build step "${name}"`)
    const end = build.indexOf('\n      - name: ', start + marker.length)
    return build.slice(start, end === -1 ? undefined : end)
  }

  const x64BinaryBuild = buildStep('Build Linux x64 binary')
  assert.match(x64BinaryBuild, /if: matrix\.arch == 'x64'/)
  assert.match(x64BinaryBuild, /cargo build --release --target x86_64-unknown-linux-gnu --bin rari/)

  const arm64RunnerCheck = buildStep('Verify ARM64 runner architecture')
  assert.match(arm64RunnerCheck, /if: matrix\.arch == 'arm64'/)
  assert.match(arm64RunnerCheck, /uname -m/)
  assert.match(arm64RunnerCheck, /aarch64/)

  const arm64Snapshot = buildStep('Generate ARM64 V8 snapshot')
  assert.match(arm64Snapshot, /if: matrix\.arch == 'arm64'/)
  assert.match(
    arm64Snapshot,
    /cargo run --release --manifest-path tools\/snapshot\/Cargo\.toml -- crates\/rari\/snapshots/,
  )

  const arm64BinaryBuild = buildStep('Build Linux ARM64 binary')
  assert.match(arm64BinaryBuild, /if: matrix\.arch == 'arm64'/)
  assert.match(arm64BinaryBuild, /cargo build --release --bin rari --features ext-full,jemalloc/)
  assert.doesNotMatch(arm64BinaryBuild, /--target/)

  const packageAssets = buildStep('Prepare and package Linux release assets')
  assert.match(packageAssets, /arm64\)\s+binary=target\/release\/rari\s+objcopy=objcopy/)

  const x64SmokeTest = buildStep(
    'Smoke-test packaged Linux x64 binary on the production base image',
  )
  assert.match(x64SmokeTest, /if: matrix\.arch == 'x64'/)
  assert.match(x64SmokeTest, /docker create --platform linux\/amd64/)
  assert.match(x64SmokeTest, /rari-linux-x64-\$\{VERSION\}\.tgz/)
  assert.match(x64SmokeTest, /\/tmp\/rari-package\/bin\/rari --mode production/)
  assert.match(x64SmokeTest, /grep -Fq "Test App Home"/)

  const arm64SmokeTest = buildStep('Smoke-test native Linux ARM64 binary')
  assert.match(arm64SmokeTest, /if: matrix\.arch == 'arm64'/)
  assert.match(arm64SmokeTest, /target\/release\/rari/)
  assert.match(arm64SmokeTest, /"\$binary" --version/)
  assert.match(arm64SmokeTest, /--mode production --host 127\.0\.0\.1 --port 43819/)
  assert.match(arm64SmokeTest, /grep -Fq 'Test App Home'/)
  assert.doesNotMatch(arm64SmokeTest, /qemu-aarch64-static/)

  const publisher = workflow.slice(
    workflow.indexOf('  publish-release:'),
    workflow.indexOf('  validate-cleanup-ref:'),
  )
  assert.match(publisher, /\n    needs: build\n/, 'publisher must wait for every matrix build')
  const x64Assets = publisher.indexOf('name: fork-release-assets-x64')
  const arm64Assets = publisher.indexOf('name: fork-release-assets-arm64')
  const provenance = publisher.indexOf('name: fork-build-provenance-${{ inputs.version }}')
  const release = publisher.indexOf('run: node .github/scripts/fork-release.mjs')
  assert.ok(
    x64Assets >= 0 && arm64Assets >= 0,
    'publisher must download both architecture artifacts',
  )
  assert.ok(provenance > x64Assets && provenance > arm64Assets, 'provenance needs both tarballs')
  assert.ok(release > provenance, 'release publication must follow provenance upload')
})

test('publisher explains how to recover when an architecture artifact is missing from this attempt', async () => {
  const workflow = await readFile(new URL('../workflows/fork-build.yml', import.meta.url), 'utf8')
  const publisher = workflow.slice(
    workflow.indexOf('  publish-release:'),
    workflow.indexOf('  validate-cleanup-ref:'),
  )

  assert.match(
    publisher,
    /name: Download x64 release assets\s+id: download-x64[\s\S]*?continue-on-error: true/,
  )
  assert.match(
    publisher,
    /name: Download ARM64 release assets\s+id: download-arm64[\s\S]*?continue-on-error: true/,
  )
  assert.match(
    publisher,
    /name: Validate release artifacts for this attempt\s+if: always\(\)[\s\S]*?steps\.download-x64\.outcome[\s\S]*?steps\.download-arm64\.outcome[\s\S]*?Re-run all jobs/,
  )
})

function releaseLockFailureRequest({ operationFails }) {
  const logMessages = []
  const request = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    if (method === 'GET' && path.endsWith('/tags/build-0.17.9-fork.99-test.1-operation-lock')) {
      return { response: { ok: false, status: 404 }, data: { message: 'Not Found' } }
    }
    if (method === 'POST' && path.endsWith('/releases')) {
      const body = JSON.parse(options.body)
      if (body.tag_name.endsWith('-operation-lock')) {
        return { response: { ok: true, status: 201 }, data: { id: 90, draft: true } }
      }
      return { response: { ok: true, status: 201 }, data: { id: 42, draft: true } }
    }
    if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
      if (operationFails) {
        return {
          response: { ok: false, status: 502 },
          data: { message: 'release listing failed' },
        }
      }
      return { response: { ok: true, status: 200 }, data: [] }
    }
    if (method === 'GET' && path.endsWith('/releases/42/assets')) {
      return { response: { ok: true, status: 200 }, data: [] }
    }
    if (method === 'PATCH' && path.endsWith('/releases/42')) {
      return { response: { ok: true, status: 200 }, data: { id: 42, draft: false } }
    }
    if (method === 'DELETE' && path.endsWith('/releases/90')) {
      return {
        response: { ok: false, status: 500 },
        data: { message: 'lock delete failed' },
      }
    }
    assert.fail(`Unexpected Gitea request: ${method} ${path}`)
  }

  return { request, logMessages }
}

test('retries GitHub rate limits and server errors while waiting for the mirrored tag', async () => {
  const statuses = [403, 429, 503, 200]
  const waits = []
  let requestCount = 0

  await waitForGithubMirrorTag({
    shouldExist: true,
    expectedSha: process.env.RELEASE_SHA,
    fetchTag: async url => {
      requestCount += 1
      assert.equal(
        url,
        'https://api.github.com/repos/adambenhassen/rari/git/ref/tags/build-0.17.9-fork.99-test.1',
      )
      const status = statuses.shift()
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () =>
          JSON.stringify(
            status === 200 ? { object: { sha: process.env.RELEASE_SHA } } : { message: 'retry' },
          ),
      }
    },
    sleepFn: async milliseconds => waits.push(milliseconds),
  })

  assert.equal(requestCount, 4)
  assert.deepEqual(waits, [30_000, 30_000, 30_000])
})

test('waits for a missing GitHub mirror tag during cleanup', async () => {
  const statuses = [200, 200, 404]
  let requestCount = 0
  const waits = []

  await waitForGithubMirrorTag({
    shouldExist: false,
    fetchTag: async () => {
      requestCount += 1
      const status = statuses.shift()
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () =>
          JSON.stringify({ message: status === 404 ? 'Not Found' : 'still present' }),
      }
    },
    sleepFn: async milliseconds => waits.push(milliseconds),
  })

  assert.equal(requestCount, 3)
  assert.deepEqual(waits, [30_000, 30_000])
})

test('mirror cleanup timeout includes the final HTTP status and body', async () => {
  let requestCount = 0
  let sleepCount = 0

  await assert.rejects(
    waitForGithubMirrorTag({
      shouldExist: false,
      fetchTag: async () => {
        requestCount += 1
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ message: 'tag still exists' }),
        }
      },
      sleepFn: async () => {
        sleepCount += 1
      },
    }),
    error => {
      assert.match(error.message, /did not remove tag/)
      assert.match(error.message, /last HTTP status 200/)
      assert.match(error.message, /tag still exists/)
      return true
    },
  )

  assert.equal(requestCount, 20)
  assert.equal(sleepCount, 20)
})

test('reports a lock deletion failure after a successful release operation', async () => {
  const { request, logMessages } = releaseLockFailureRequest({ operationFails: false })

  await assert.rejects(
    publishRelease({
      request,
      checkTagCommit: skipTagCheck,
      assets: [],
      waitForMirrorTag: async () => {},
      log: message => logMessages.push(message),
    }),
    error => {
      assert.match(error.message, /Could not remove Gitea operation lock/)
      assert.match(error.cause.message, /failed \(500\)/)
      assert.match(error.cause.message, /lock delete failed/)
      return true
    },
  )
})

test('logs a lock deletion failure and preserves the operation error', async () => {
  const { request, logMessages } = releaseLockFailureRequest({ operationFails: true })

  await assert.rejects(
    publishRelease({
      request,
      checkTagCommit: skipTagCheck,
      assets: [],
      waitForMirrorTag: async () => {},
      log: message => logMessages.push(message),
    }),
    /Gitea release listing failed \(502\)/,
  )

  assert.equal(logMessages.length, 1)
  assert.match(logMessages[0], /Could not remove Gitea operation lock/)
  assert.match(logMessages[0], /failed \(500\)/)
  assert.match(logMessages[0], /lock delete failed/)
})

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
      return { response: { ok: true, status: 200 }, data: [{ name: basename(asset), size: 10 }] }
    }

    if (method === 'PATCH' && path.endsWith('/releases/42')) {
      events.push('publish release')
      assert.deepEqual(JSON.parse(options.body), { draft: false })
      return { response: { ok: true, status: 200 }, data: { id: 42, draft: false } }
    }

    assert.fail(`Unexpected Gitea request: ${method} ${path}`)
  }

  try {
    const originalRequest = request
    let assetLists = 0
    await publishRelease({
      checkTagCommit: skipTagCheck,
      withOperationLock: skipOperationLock,
      request: async (path, options = {}) => {
        if ((options.method ?? 'GET') === 'GET' && path.endsWith('/releases/42/assets')) {
          assetLists += 1
          if (assetLists === 1) {
            events.push('list draft assets')
            return { response: { ok: true, status: 200 }, data: [] }
          }
        }
        return originalRequest(path, options)
      },
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
      'list draft assets',
      'upload 42',
      'verify assets',
      'publish release',
      'wait for mirrored tag',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('retry replaces same-size stale assets after a failed upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rari-fork-release-retry-'))
  const x64Asset = join(directory, 'rari-linux-x64.tgz')
  const arm64Asset = join(directory, 'rari-linux-arm64.tgz')
  await writeFile(x64Asset, 'stale x64 asset')
  await writeFile(arm64Asset, 'complete arm64 asset')

  const version = process.env.RELEASE_VERSION
  const sha = process.env.RELEASE_SHA
  const tag = `build-${version}`
  const draft = { id: 42, tag_name: tag, target_commitish: sha, draft: true }
  const remoteAssets = []
  const events = []
  let draftCreated = false
  let arm64UploadAttempts = 0
  let nextAssetId = 1

  const request = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    if (method === 'GET' && path.endsWith(`/tags/${tag}-operation-lock`)) {
      return { response: { ok: false, status: 404 }, data: { message: 'Not Found' } }
    }
    if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
      events.push('list releases')
      return {
        response: { ok: true, status: 200 },
        data: draftCreated ? [draft] : [],
      }
    }
    if (method === 'POST' && path.endsWith('/releases')) {
      const body = JSON.parse(options.body)
      if (body.tag_name === `${tag}-operation-lock`) {
        events.push('acquire lock')
        return { response: { ok: true, status: 201 }, data: { id: 900, draft: true } }
      }
      events.push('create draft')
      draftCreated = true
      return { response: { ok: true, status: 201 }, data: draft }
    }
    if (method === 'DELETE' && path.endsWith('/releases/900')) {
      events.push('release lock')
      return { response: { ok: true, status: 204 }, data: null }
    }
    if (method === 'GET' && path.endsWith('/releases/42/assets')) {
      events.push('list assets')
      return { response: { ok: true, status: 200 }, data: [...remoteAssets] }
    }
    if (method === 'DELETE' && path.startsWith('/repos/adambenhassen/rari/releases/42/assets/')) {
      const assetId = Number(path.split('/').at(-1))
      const asset = remoteAssets.find(current => current.id === assetId)
      events.push(`delete ${asset.name}`)
      const index = remoteAssets.findIndex(current => current.id === assetId)
      if (index >= 0) remoteAssets.splice(index, 1)
      return { response: { ok: true, status: 204 }, data: null }
    }
    if (method === 'PATCH' && path.endsWith('/releases/42')) {
      events.push('publish release')
      assert.deepEqual(JSON.parse(options.body), { draft: false })
      return { response: { ok: true, status: 200 }, data: { ...draft, draft: false } }
    }
    assert.fail(`Unexpected Gitea request: ${method} ${path}`)
  }

  const uploadAsset = async (releaseId, filePath) => {
    assert.equal(releaseId, 42)
    if (filePath === arm64Asset && arm64UploadAttempts++ === 0) {
      events.push('fail arm64 upload')
      remoteAssets.push({ id: nextAssetId++, name: basename(filePath), size: 3 })
      throw new Error('simulated interrupted upload')
    }
    remoteAssets.push({
      id: nextAssetId++,
      name: basename(filePath),
      size: (await stat(filePath)).size,
      sha256: createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex'),
    })
    events.push(`upload ${basename(filePath)}`)
    return { name: basename(filePath) }
  }

  const options = {
    request,
    checkTagCommit: skipTagCheck,
    uploadAsset,
    waitForMirrorTag: async ({ shouldExist, expectedSha }) => {
      events.push('wait for mirrored tag')
      assert.equal(shouldExist, true)
      assert.equal(expectedSha, sha)
    },
    assets: [x64Asset, arm64Asset],
    log: () => {},
  }

  try {
    await assert.rejects(publishRelease(options), /simulated interrupted upload/)
    const firstBuildSize = (await stat(x64Asset)).size
    await writeFile(x64Asset, 'fresh x64 asset')
    assert.equal((await stat(x64Asset)).size, firstBuildSize)
    await publishRelease(options)

    assert.deepEqual(remoteAssets, [
      {
        id: 3,
        name: basename(x64Asset),
        size: 15,
        sha256: createHash('sha256')
          .update(await readFile(x64Asset))
          .digest('hex'),
      },
      {
        id: 4,
        name: basename(arm64Asset),
        size: 20,
        sha256: createHash('sha256')
          .update(await readFile(arm64Asset))
          .digest('hex'),
      },
    ])
    assert.deepEqual(events, [
      'acquire lock',
      'list releases',
      'create draft',
      'list assets',
      'upload rari-linux-x64.tgz',
      'fail arm64 upload',
      'release lock',
      'acquire lock',
      'list releases',
      'list assets',
      'delete rari-linux-x64.tgz',
      'upload rari-linux-x64.tgz',
      'delete rari-linux-arm64.tgz',
      'upload rari-linux-arm64.tgz',
      'list assets',
      'publish release',
      'wait for mirrored tag',
      'release lock',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a published same-commit release verifies both rebuilt tarballs before mirror retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rari-fork-release-published-match-'))
  const tarballs = [
    { name: 'rari-linux-x64-0.17.9-fork.99-test.1.tgz', contents: 'x64 tarball' },
    { name: 'rari-linux-arm64-0.17.9-fork.99-test.1.tgz', contents: 'arm64 tarball' },
  ]
  const files = await Promise.all(
    tarballs.map(async tarball => {
      const file = join(directory, tarball.name)
      await writeFile(file, tarball.contents)
      return file
    }),
  )
  const publishedHashes = new Map(
    tarballs.map(tarball => [
      tarball.name,
      createHash('sha256').update(tarball.contents).digest('hex'),
    ]),
  )
  const publishedAssets = tarballs.map((tarball, index) => ({
    id: index + 1,
    name: tarball.name,
    browser_download_url: `https://gitea.example/adambenhassen/rari/releases/download/${tarball.name}`,
  }))
  const events = []

  try {
    await publishRelease({
      withOperationLock: skipOperationLock,
      request: async (path, options = {}) => {
        const method = options.method ?? 'GET'
        if (method === 'GET' && path.endsWith('/tags/build-0.17.9-fork.99-test.1')) {
          events.push('check tag')
          return {
            response: { ok: true, status: 200 },
            data: { commit: { sha: process.env.RELEASE_SHA } },
          }
        }
        if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
          events.push('list releases')
          return {
            response: { ok: true, status: 200 },
            data: [
              {
                id: 42,
                tag_name: 'build-0.17.9-fork.99-test.1',
                target_commitish: process.env.RELEASE_SHA,
                draft: false,
              },
            ],
          }
        }
        if (method === 'GET' && path.endsWith('/releases/42/assets')) {
          events.push('list assets')
          return { response: { ok: true, status: 200 }, data: publishedAssets }
        }
        assert.fail(`Unexpected Gitea request: ${method} ${path}`)
      },
      downloadAsset: async asset => {
        events.push(`download ${asset.name}`)
        return publishedHashes.get(asset.name)
      },
      uploadAsset: async () => assert.fail('published releases must not upload assets'),
      waitForMirrorTag: async ({ shouldExist, expectedSha }) => {
        events.push('wait for mirror')
        assert.equal(shouldExist, true)
        assert.equal(expectedSha, process.env.RELEASE_SHA)
      },
      assets: files,
      log: () => {},
    })

    assert.deepEqual(events, [
      'check tag',
      'check tag',
      'list releases',
      'list assets',
      `download ${tarballs[0].name}`,
      `download ${tarballs[1].name}`,
      'wait for mirror',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a published same-commit retry rejects a rebuilt tarball with different bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rari-fork-release-published-mismatch-'))
  const tarballs = [
    { name: 'rari-linux-x64-0.17.9-fork.99-test.1.tgz', contents: 'x64 tarball' },
    { name: 'rari-linux-arm64-0.17.9-fork.99-test.1.tgz', contents: 'new arm64 tarball' },
  ]
  const files = await Promise.all(
    tarballs.map(async tarball => {
      const file = join(directory, tarball.name)
      await writeFile(file, tarball.contents)
      return file
    }),
  )
  const publishedHashes = new Map([
    [tarballs[0].name, createHash('sha256').update('x64 tarball').digest('hex')],
    [tarballs[1].name, createHash('sha256').update('original arm64 tarball').digest('hex')],
  ])
  const publishedAssets = tarballs.map((tarball, index) => ({
    id: index + 1,
    name: tarball.name,
    browser_download_url: `https://gitea.example/adambenhassen/rari/releases/download/${tarball.name}`,
  }))
  const events = []

  try {
    await assert.rejects(
      publishRelease({
        checkTagCommit: skipTagCheck,
        withOperationLock: skipOperationLock,
        request: async (path, options = {}) => {
          const method = options.method ?? 'GET'
          if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
            events.push('list releases')
            return {
              response: { ok: true, status: 200 },
              data: [
                {
                  id: 42,
                  tag_name: 'build-0.17.9-fork.99-test.1',
                  target_commitish: process.env.RELEASE_SHA,
                  draft: false,
                },
              ],
            }
          }
          if (method === 'GET' && path.endsWith('/releases/42/assets')) {
            events.push('list assets')
            return { response: { ok: true, status: 200 }, data: publishedAssets }
          }
          assert.fail(`Unexpected Gitea request: ${method} ${path}`)
        },
        downloadAsset: async asset => {
          events.push(`download ${asset.name}`)
          return publishedHashes.get(asset.name)
        },
        uploadAsset: async () => assert.fail('published releases must not upload assets'),
        waitForMirrorTag: async () => events.push('wait for mirror'),
        assets: files,
        log: () => {},
      }),
      /does not match this build/,
    )

    assert.deepEqual(events, [
      'list releases',
      'list assets',
      `download ${tarballs[0].name}`,
      `download ${tarballs[1].name}`,
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a draft for a different commit before uploading assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rari-fork-release-wrong-draft-'))
  const asset = join(directory, 'rari-linux-x64.tgz')
  await writeFile(asset, 'test asset')
  let uploadCount = 0

  try {
    await assert.rejects(
      publishRelease({
        checkTagCommit: skipTagCheck,
        withOperationLock: skipOperationLock,
        request: async (path, options = {}) => {
          const method = options.method ?? 'GET'
          if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
            return {
              response: { ok: true, status: 200 },
              data: [
                {
                  id: 42,
                  tag_name: 'build-0.17.9-fork.99-test.1',
                  target_commitish: 'ffffffffffffffffffffffffffffffffffffffff',
                  draft: true,
                },
              ],
            }
          }
          assert.fail(`Unexpected Gitea request: ${method} ${path}`)
        },
        uploadAsset: async () => {
          uploadCount += 1
        },
        assets: [asset],
        log: () => {},
      }),
      /targets a different commit/,
    )
    assert.equal(uploadCount, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects an existing tag on another commit before creating a draft or uploading assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rari-fork-release-existing-tag-'))
  const asset = join(directory, 'rari-linux-x64.tgz')
  await writeFile(asset, 'test asset')
  const events = []
  let uploadCount = 0

  try {
    await assert.rejects(
      publishRelease({
        request: async (path, options = {}) => {
          const method = options.method ?? 'GET'
          if (method === 'GET' && path.endsWith(`/tags/build-${process.env.RELEASE_VERSION}`)) {
            events.push('check tag')
            return {
              response: { ok: true, status: 200 },
              data: { commit: { sha: 'ffffffffffffffffffffffffffffffffffffffff' } },
            }
          }
          events.push(`${method} ${path}`)
          assert.fail(`Unexpected Gitea request: ${method} ${path}`)
        },
        uploadAsset: async () => {
          uploadCount += 1
        },
        assets: [asset],
        log: () => {},
      }),
      /Gitea tag .* points to .* expected/,
    )
    assert.deepEqual(events, ['check tag'])
    assert.equal(uploadCount, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('serializes publish and cleanup dispatches for the same version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rari-fork-release-lock-'))
  const asset = join(directory, 'rari-linux-x64.tgz')
  await writeFile(asset, 'test asset')

  const lockTag = `build-${process.env.RELEASE_VERSION}-operation-lock`
  const events = []
  let lockHeld = false
  let assetListCount = 0
  let releaseReleaseList
  let releaseListStarted
  const releaseListStartedPromise = new Promise(resolve => {
    releaseListStarted = resolve
  })
  const releaseListGate = new Promise(resolve => {
    releaseReleaseList = resolve
  })

  const request = async (path, options = {}) => {
    const method = options.method ?? 'GET'
    if (method === 'GET' && path.endsWith(`/tags/${lockTag}`)) {
      return { response: { ok: false, status: 404 }, data: { message: 'Not Found' } }
    }
    if (method === 'GET' && path.endsWith(`/tags/build-${process.env.RELEASE_VERSION}`)) {
      events.push('check version tag')
      return { response: { ok: false, status: 404 }, data: { message: 'Not Found' } }
    }
    if (method === 'POST' && path.endsWith('/releases')) {
      const body = JSON.parse(options.body)
      if (body.tag_name === lockTag) {
        events.push('attempt lock')
        if (lockHeld) return { response: { ok: false, status: 409 }, data: { message: 'Conflict' } }
        lockHeld = true
        events.push('acquire lock')
        return { response: { ok: true, status: 201 }, data: { id: 900, draft: true } }
      }
      events.push('create version draft')
      return {
        response: { ok: true, status: 201 },
        data: {
          id: 42,
          tag_name: body.tag_name,
          target_commitish: process.env.RELEASE_SHA,
          draft: true,
        },
      }
    }
    if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
      events.push('list version releases')
      releaseListStarted()
      await releaseListGate
      return { response: { ok: true, status: 200 }, data: [] }
    }
    if (method === 'GET' && path.endsWith('/releases/42/assets')) {
      assetListCount += 1
      return {
        response: { ok: true, status: 200 },
        data:
          assetListCount === 1 ? [] : [{ name: basename(asset), size: (await stat(asset)).size }],
      }
    }
    if (method === 'PATCH' && path.endsWith('/releases/42')) {
      events.push('publish version release')
      return { response: { ok: true, status: 200 }, data: { id: 42, draft: false } }
    }
    if (method === 'DELETE' && path.endsWith('/releases/900')) {
      events.push('release lock')
      lockHeld = false
      return { response: { ok: true, status: 204 }, data: null }
    }
    events.push(`${method} ${path}`)
    assert.fail(`Unexpected Gitea request: ${method} ${path}`)
  }

  try {
    const publishing = publishRelease({
      request,
      uploadAsset: async (_releaseId, filePath) => ({ name: basename(filePath) }),
      assets: [asset],
      waitForMirrorTag: async () => {},
      log: () => {},
    })

    await releaseListStartedPromise
    await assert.rejects(
      deleteTestRelease({ request, waitForMirrorTag: async () => {}, log: () => {} }),
      /Another publish or cleanup operation holds/,
    )
    releaseReleaseList()
    await publishing

    assert.equal(lockHeld, false)
    assert.deepEqual(events, [
      'check version tag',
      'attempt lock',
      'acquire lock',
      'check version tag',
      'list version releases',
      'attempt lock',
      'create version draft',
      'publish version release',
      'release lock',
    ])
  } finally {
    releaseReleaseList()
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
      if (method === 'GET' && path.endsWith(`/tags/${tag}-operation-lock`)) {
        return { response: { ok: false, status: 404 }, data: { message: 'Not Found' } }
      }
      if (method === 'POST' && path.endsWith('/releases')) {
        events.push('acquire cleanup lock')
        assert.equal(JSON.parse(options.body).tag_name, `${tag}-operation-lock`)
        return { response: { ok: true, status: 201 }, data: { id: 90, draft: true } }
      }

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

      if (method === 'DELETE' && path === '/repos/adambenhassen/rari/releases/90') {
        events.push('release cleanup lock')
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
      'acquire cleanup lock',
      'list releases',
      'delete selected release',
      'delete selected tag',
      'wait for mirror deletion',
      'list releases',
      'release cleanup lock',
    ])
  } finally {
    if (previousVersion === undefined) delete process.env.RELEASE_VERSION
    else process.env.RELEASE_VERSION = previousVersion
    if (previousDelete === undefined) delete process.env.DELETE_TEST_RELEASE
    else process.env.DELETE_TEST_RELEASE = previousDelete
  }
})

test('finds and removes a test release on page two', async () => {
  const version = '0.17.9-fork.101-test.1'
  const tag = `build-${version}`
  const previousVersion = process.env.RELEASE_VERSION
  const previousDelete = process.env.DELETE_TEST_RELEASE
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    id: 100 + index,
    tag_name: `build-older-${index}`,
  }))
  const deletedReleaseIds = []
  const events = []
  let pageOneRequests = 0
  let pageTwoRequests = 0

  process.env.RELEASE_VERSION = version
  process.env.DELETE_TEST_RELEASE = 'true'

  try {
    const cleanupModule = new URL('./fork-release.mjs?delete-release-page-two', import.meta.url)
    const { deleteTestRelease } = await import(cleanupModule.href)
    const request = async (path, options = {}) => {
      const method = options.method ?? 'GET'
      if (method === 'GET' && path.endsWith(`/tags/${tag}-operation-lock`)) {
        return { response: { ok: false, status: 404 }, data: { message: 'Not Found' } }
      }
      if (method === 'POST' && path.endsWith('/releases')) {
        events.push('acquire lock')
        return { response: { ok: true, status: 201 }, data: { id: 90, draft: true } }
      }
      if (method === 'GET' && path.endsWith('/releases?limit=50&page=1')) {
        pageOneRequests += 1
        events.push('list page one')
        return { response: { ok: true, status: 200 }, data: firstPage }
      }
      if (method === 'GET' && path.endsWith('/releases?limit=50&page=2')) {
        pageTwoRequests += 1
        events.push('list page two')
        return {
          response: { ok: true, status: 200 },
          data: pageTwoRequests === 1 ? [{ id: 42, tag_name: tag }] : [],
        }
      }
      if (method === 'DELETE' && path.endsWith('/releases/42')) {
        events.push('delete release')
        deletedReleaseIds.push(42)
        return { response: { ok: true, status: 204 }, data: null }
      }
      if (method === 'DELETE' && path.endsWith(`/tags/${tag}`)) {
        events.push('delete tag')
        return { response: { ok: true, status: 204 }, data: null }
      }
      if (method === 'DELETE' && path.endsWith('/releases/90')) {
        events.push('release lock')
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

    assert.deepEqual(deletedReleaseIds, [42])
    assert.equal(pageOneRequests, 2)
    assert.equal(pageTwoRequests, 2)
    assert.deepEqual(events, [
      'acquire lock',
      'list page one',
      'list page two',
      'delete release',
      'delete tag',
      'wait for mirror deletion',
      'list page one',
      'list page two',
      'release lock',
    ])
  } finally {
    if (previousVersion === undefined) delete process.env.RELEASE_VERSION
    else process.env.RELEASE_VERSION = previousVersion
    if (previousDelete === undefined) delete process.env.DELETE_TEST_RELEASE
    else process.env.DELETE_TEST_RELEASE = previousDelete
  }
})
