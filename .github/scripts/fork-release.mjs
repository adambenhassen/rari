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

async function waitForGithubMirrorTag({ shouldExist, expectedSha }) {
  const url = `https://api.github.com/repos/${githubMirrorRepository}/git/ref/tags/${encodeURIComponent(tag)}`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(url)
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
      await pause(30_000)
      continue
    }
    if (response.status !== 404) {
      throw new Error(`GitHub tag lookup failed (${response.status}): ${JSON.stringify(data)}`)
    }
    await pause(30_000)
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

async function verifyReleaseAssets(releaseId, files, request = giteaRequest) {
  const path = `/repos/${giteaRepository}/releases/${releaseId}/assets`
  const { response, data } = await request(path)
  assertOk(response, data, 'Gitea release asset listing')
  if (!Array.isArray(data)) throw new Error('Gitea release asset listing was not an array')

  const uploadedNames = new Set(data.map(asset => asset.name))
  const missing = files.map(file => basename(file)).filter(name => !uploadedNames.has(name))
  if (missing.length > 0) {
    throw new Error(`Gitea release is missing assets: ${missing.join(', ')}`)
  }
}

export async function publishRelease({
  request = giteaRequest,
  uploadAsset = uploadGiteaAsset,
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
  if (existingRelease) throw new Error(`Gitea release already exists for ${tag}`)

  for (const asset of assets) await stat(asset)

  const releaseBody = [
    `Fork prerelease built from commit ${sha}.`,
    '',
    'Includes Linux x64 and ARM64 npm tarballs, binaries, and debug sidecars.',
  ].join('\n')
  const { response: createResponse, data: release } = await request(
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
  assertOk(createResponse, release, `Create Gitea draft release ${tag}`)
  if (typeof release?.id !== 'number') {
    throw new Error('Gitea draft release response did not include a release ID')
  }

  for (const asset of assets) {
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

export async function deleteTestRelease({
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (deleting) await deleteTestRelease()
  else await publishRelease()
}
