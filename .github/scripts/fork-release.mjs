import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import https from 'node:https'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const giteaRepository = process.env.GITEA_REPOSITORY
const giteaApiUrl = process.env.GITEA_API_URL?.replace(/\/$/, '')
const giteaToken = process.env.GITEA_TOKEN
const version = process.env.RELEASE_VERSION
const sha = process.env.RELEASE_SHA
const deleting = process.env.DELETE_TEST_RELEASE === 'true'
const githubMirrorRepository = 'adambenhassen/rari'
const tag = `build-${version}`
const operationLockTag = `${tag}-operation-lock`

if (!giteaRepository || !giteaApiUrl || !giteaToken || !version) {
  throw new Error('Gitea API URL, repository, job token, and version are required')
}
if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('A valid release commit SHA is required')
if (deleting ? !isTestVersion(version) : !isReleaseVersion(version)) {
  throw new Error(
    deleting
      ? 'Only a test prerelease version can be deleted'
      : 'Version must match 0.17.9-fork.<n> or 0.17.9-fork.<n>-test.<n>',
  )
}

function isReleaseVersion(value) {
  return /^0\.17\.9-fork\.[0-9]+(-test\.[0-9]+)?$/.test(value)
}

function isTestVersion(value) {
  return /^0\.17\.9-fork\.[0-9]+-test\.[0-9]+$/.test(value)
}

function pause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function readResponse(response) {
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function giteaRequest(path, options = {}) {
  const response = await fetch(`${giteaApiUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `token ${giteaToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const data = await readResponse(response)
  return { response, data }
}

function assertOk(response, data, description) {
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data)
    throw new Error(`${description} failed (${response.status}): ${detail}`)
  }
}

export async function waitForGithubMirrorTag({
  shouldExist,
  expectedSha,
  fetchTag = fetch,
  sleepFn = pause,
}) {
  const url = `https://api.github.com/repos/${githubMirrorRepository}/git/ref/tags/${encodeURIComponent(tag)}`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetchTag(url)
    const data = await readResponse(response)
    if (shouldExist && response.ok) {
      const actualSha = data?.object?.sha
      if (actualSha !== expectedSha) {
        throw new Error(`Mirrored tag ${tag} points to an unexpected commit`)
      }
      return
    }
    if (!shouldExist && response.status === 404) return
    if (!shouldExist && response.ok) {
      await sleepFn(30_000)
      continue
    }
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      await sleepFn(30_000)
      continue
    }
    if (response.status !== 404) {
      throw new Error(`GitHub tag lookup failed (${response.status}): ${JSON.stringify(data)}`)
    }
    await sleepFn(30_000)
  }
  throw new Error(`GitHub mirror did not ${shouldExist ? 'receive' : 'remove'} tag ${tag} in time`)
}

async function findGiteaRelease(request = giteaRequest) {
  for (let page = 1; ; page += 1) {
    const path = `/repos/${giteaRepository}/releases?limit=50&page=${page}`
    const { response, data } = await request(path)
    assertOk(response, data, 'Gitea release listing')
    if (!Array.isArray(data)) throw new Error('Gitea release listing was not an array')

    const release = data.find(item => item.tag_name === tag)
    if (release) return release
    if (data.length < 50) return null
  }
}

async function assertGiteaTagCommit(request = giteaRequest) {
  const path = `/repos/${giteaRepository}/tags/${encodeURIComponent(tag)}`
  const { response, data } = await request(path)
  if (response.status === 404) return
  assertOk(response, data, `Gitea tag lookup for ${tag}`)

  const actualSha = data?.commit?.sha
  if (typeof actualSha !== 'string') {
    throw new Error(`Gitea tag ${tag} did not include a commit SHA`)
  }
  if (actualSha.toLowerCase() !== sha.toLowerCase()) {
    throw new Error(`Gitea tag ${tag} points to ${actualSha}, expected ${sha}`)
  }
}

async function withReleaseOperationLock(request, operation, log) {
  const lockTagPath = `/repos/${giteaRepository}/tags/${encodeURIComponent(operationLockTag)}`
  const { response: lockTagResponse, data: lockTagData } = await request(lockTagPath)
  if (lockTagResponse.status !== 404) {
    assertOk(lockTagResponse, lockTagData, `Gitea operation lock tag lookup for ${operationLockTag}`)
    throw new Error(`Gitea operation lock tag ${operationLockTag} already exists`)
  }

  const { response, data } = await request(`/repos/${giteaRepository}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: operationLockTag,
      target_commitish: sha,
      name: operationLockTag,
      body: `Temporary publish or cleanup lock for ${tag}.`,
      draft: true,
      prerelease: true,
    }),
  })
  if (response.status === 409) {
    throw new Error(
      `Another publish or cleanup operation holds ${operationLockTag}; ` +
        'if no workflow is active for this version, remove the stale lock draft and retry',
    )
  }
  assertOk(response, data, `Acquire Gitea operation lock ${operationLockTag}`)
  if (!Number.isSafeInteger(data?.id)) {
    throw new Error(`Gitea operation lock ${operationLockTag} has no valid release ID`)
  }

  let result
  let operationError
  try {
    result = await operation()
  } catch (error) {
    operationError = error
  }

  try {
    const { response: deleteResponse, data: deleteData } = await request(
      `/repos/${giteaRepository}/releases/${data.id}`,
      { method: 'DELETE' },
    )
    if (deleteResponse.status !== 204 && deleteResponse.status !== 404) {
      assertOk(deleteResponse, deleteData, `Release Gitea operation lock ${operationLockTag}`)
    }
  } catch (error) {
    const lockError = new Error(
      `Could not remove Gitea operation lock ${operationLockTag}; ` +
        'remove the stale lock draft after confirming no workflow is active',
      { cause: error },
    )
    if (operationError) {
      log(lockError.message)
      throw operationError
    }
    throw lockError
  }

  if (operationError) throw operationError
  return result
}

async function uploadGiteaAsset(releaseId, filePath) {
  const fileStat = await stat(filePath)
  const url = new URL(`${giteaApiUrl}/repos/${giteaRepository}/releases/${releaseId}/assets`)
  url.searchParams.set('name', basename(filePath))

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Authorization': `token ${giteaToken}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileStat.size,
        },
      },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let data
          try {
            data = text === '' ? null : JSON.parse(text)
          } catch {
            data = text
          }
          if (response.statusCode !== 201) {
            reject(
              new Error(
                `Gitea release asset upload failed (${response.statusCode}): ${JSON.stringify(data)}`,
              ),
            )
            return
          }
          resolve(data)
        })
      },
    )
    request.on('error', reject)
    createReadStream(filePath).on('error', reject).pipe(request)
  })
}

async function listGiteaReleaseAssets(releaseId, request) {
  const path = `/repos/${giteaRepository}/releases/${releaseId}/assets`
  const { response, data } = await request(path)
  assertOk(response, data, 'Gitea release asset listing')
  if (!Array.isArray(data)) throw new Error('Gitea release asset listing was not an array')
  return data
}

async function removeGiteaAsset(releaseId, asset, request) {
  if (!Number.isSafeInteger(asset.id)) {
    throw new Error(`Gitea release asset ${asset.name} has no valid ID`)
  }
  const path = `/repos/${giteaRepository}/releases/${releaseId}/assets/${asset.id}`
  const { response, data } = await request(path, { method: 'DELETE' })
  if (response.status !== 204 && response.status !== 404) {
    assertOk(response, data, `Delete previous Gitea release asset ${asset.name}`)
  }
}

async function sha256Stream(stream) {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadGiteaAsset(asset) {
  if (typeof asset.browser_download_url !== 'string') {
    throw new Error(`Gitea release asset ${asset.name} has no download URL`)
  }
  const url = new URL(asset.browser_download_url)
  if (url.origin !== new URL(giteaApiUrl).origin) {
    throw new Error(`Gitea release asset ${asset.name} has an unexpected download origin`)
  }

  const response = await fetch(url)
  if (!response.ok) {
    const data = await readResponse(response)
    assertOk(response, data, `Download Gitea release asset ${asset.name}`)
  }
  if (!response.body) throw new Error(`Gitea release asset ${asset.name} has no response body`)
  return sha256Stream(response.body)
}

async function verifyReleaseAssets(releaseId, files, request = giteaRequest) {
  const uploadedAssets = await listGiteaReleaseAssets(releaseId, request)
  const missing = []
  for (const file of files) {
    const expectedSize = (await stat(file)).size
    const matchingAsset = uploadedAssets.find(
      asset => asset.name === basename(file) && Number(asset.size) === expectedSize,
    )
    if (!matchingAsset) missing.push(basename(file))
  }
  if (missing.length > 0) {
    throw new Error(`Gitea release is missing complete assets: ${missing.join(', ')}`)
  }
}

async function verifyPublishedTarballs(release, files, request, downloadAsset) {
  if (!Number.isSafeInteger(release.id)) {
    throw new Error(`Gitea published release ${tag} has no valid release ID`)
  }

  const requiredNames = [`rari-linux-x64-${version}.tgz`, `rari-linux-arm64-${version}.tgz`]
  const filesByName = new Map(files.map(file => [basename(file), file]))
  const publishedAssets = await listGiteaReleaseAssets(release.id, request)

  for (const name of requiredNames) {
    const file = filesByName.get(name)
    if (!file) throw new Error(`Current build is missing release tarball ${name}`)

    const matches = publishedAssets.filter(asset => asset.name === name)
    if (matches.length !== 1) {
      throw new Error(`Published Gitea release ${tag} must contain exactly one ${name}`)
    }

    const buildHash = await sha256Stream(createReadStream(file))
    const publishedHash = await downloadAsset(matches[0])
    if (publishedHash !== buildHash) {
      throw new Error(`Published Gitea release asset ${name} does not match this build`)
    }
  }
}

export async function publishRelease(options = {}) {
  const {
    request = giteaRequest,
    checkTagCommit = () => assertGiteaTagCommit(request),
    withOperationLock = (operation, log) => withReleaseOperationLock(request, operation, log),
    log = console.log,
  } = options

  await checkTagCommit()

  return withOperationLock(async () => {
    await checkTagCommit()
    return publishReleaseLocked({ ...options, request, log })
  }, log)
}

async function publishReleaseLocked({
  request = giteaRequest,
  uploadAsset = uploadGiteaAsset,
  downloadAsset = downloadGiteaAsset,
  waitForMirrorTag = waitForGithubMirrorTag,
  assets = [
    `dist-tarballs/rari-linux-x64-${version}.tgz`,
    `dist-tarballs/rari-linux-arm64-${version}.tgz`,
    'release-assets/rari-linux-x64',
    'release-assets/rari-linux-x64.debug',
    'release-assets/rari-linux-arm64',
    'release-assets/rari-linux-arm64.debug',
  ].map(path => join(process.cwd(), path)),
  log = console.log,
} = {}) {
  const existingRelease = await findGiteaRelease(request)
  let release
  if (existingRelease) {
    if (existingRelease.target_commitish !== sha) {
      throw new Error(`Gitea release ${tag} targets a different commit than ${sha}`)
    }
    if (existingRelease.draft === false) {
      await verifyPublishedTarballs(existingRelease, assets, request, downloadAsset)
      await waitForMirrorTag({ shouldExist: true, expectedSha: sha })
      log(`Verified mirrored tag for published Gitea prerelease ${tag}`)
      return
    }
    if (existingRelease.draft !== true) {
      throw new Error(`Gitea release ${tag} is not a draft for commit ${sha}`)
    }
    if (!Number.isSafeInteger(existingRelease.id)) {
      throw new Error(`Gitea draft release ${tag} has no valid release ID`)
    }
    release = existingRelease
  }

  for (const asset of assets) await stat(asset)

  const releaseBody = [
    `Fork prerelease built from commit ${sha}.`,
    '',
    'Includes Linux x64 and ARM64 npm tarballs, binaries, and debug sidecars.',
  ].join('\n')
  if (!release) {
    const { response: createResponse, data: createdRelease } = await request(
      `/repos/${giteaRepository}/releases`,
      {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: sha,
          name: tag,
          body: releaseBody,
          draft: true,
          prerelease: true,
        }),
      },
    )
    assertOk(createResponse, createdRelease, `Create Gitea draft release ${tag}`)
    if (!Number.isSafeInteger(createdRelease?.id)) {
      throw new Error('Gitea draft release response did not include a release ID')
    }
    release = createdRelease
  }

  const currentAssets = await listGiteaReleaseAssets(release.id, request)
  for (const asset of assets) {
    const assetName = basename(asset)
    const sameName = currentAssets.filter(current => current.name === assetName)
    for (const current of sameName) await removeGiteaAsset(release.id, current, request)

    const uploaded = await uploadAsset(release.id, asset)
    log(`Uploaded ${uploaded.name}`)
  }

  await verifyReleaseAssets(release.id, assets, request)

  const { response: publishResponse, data: published } = await request(
    `/repos/${giteaRepository}/releases/${release.id}`,
    { method: 'PATCH', body: JSON.stringify({ draft: false }) },
  )
  assertOk(publishResponse, published, `Publish Gitea release ${tag}`)
  if (published?.draft !== false) throw new Error(`Gitea release ${tag} is still a draft`)
  await waitForMirrorTag({ shouldExist: true, expectedSha: sha })
  log(`Published Gitea prerelease ${tag}`)
}

async function deleteTestReleaseLocked({
  request = giteaRequest,
  waitForMirrorTag = waitForGithubMirrorTag,
  log = console.log,
} = {}) {
  const release = await findGiteaRelease(request)

  if (release) {
    const { response, data } = await request(`/repos/${giteaRepository}/releases/${release.id}`, {
      method: 'DELETE',
    })
    if (response.status !== 204 && response.status !== 404) {
      assertOk(response, data, `Delete Gitea test release ${tag}`)
    }
  }

  const tagPath = `/repos/${giteaRepository}/tags/${encodeURIComponent(tag)}`
  const { response: deleteTagResponse, data: deleteTagData } = await request(tagPath, {
    method: 'DELETE',
  })
  if (!deleteTagResponse.ok && deleteTagResponse.status !== 404) {
    assertOk(deleteTagResponse, deleteTagData, `Delete Gitea test tag ${tag}`)
  }

  await waitForMirrorTag({ shouldExist: false })

  const verification = await findGiteaRelease(request)
  if (verification) {
    throw new Error(`Gitea test release ${tag} still exists after cleanup`)
  }
  log(`Deleted Gitea test release and mirrored tag ${tag}`)
}

export async function deleteTestRelease(options = {}) {
  const {
    request = giteaRequest,
    waitForMirrorTag = waitForGithubMirrorTag,
    withOperationLock = (operation, log) => withReleaseOperationLock(request, operation, log),
    log = console.log,
  } = options

  return withOperationLock(
    () => deleteTestReleaseLocked({ ...options, request, waitForMirrorTag, log }),
    log,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (deleting) await deleteTestRelease()
  else await publishRelease()
}
