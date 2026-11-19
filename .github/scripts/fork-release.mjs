import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import https from 'node:https'
import { basename, join } from 'node:path'

const giteaRepository = process.env.GITEA_REPOSITORY
const giteaApiUrl = process.env.GITEA_API_URL?.replace(/\/$/, '')
const giteaToken = process.env.GITEA_TOKEN
const githubToken = process.env.GITHUB_RELEASE_TOKEN
const version = process.env.RELEASE_VERSION
const sha = process.env.RELEASE_SHA
const deleting = process.env.DELETE_TEST_RELEASE === 'true'
const githubRepository = 'adambenhassen/rari'
const tag = `build-${version}`

if (!giteaRepository || !giteaApiUrl || !giteaToken || !githubToken || !version) {
  throw new Error('Gitea and GitHub release credentials and a version are required')
}
if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('A valid release commit SHA is required')
if (deleting ? !isTestVersion(version) : !isReleaseVersion(version)) {
  throw new Error(deleting
    ? 'Only a test prerelease version can be deleted'
    : 'Version must match 0.17.9-fork.<n> or 0.17.9-fork.<n>-test.<n>')
}

function isReleaseVersion(value) {
  return /^0\.17\.9-fork\.[0-9]+(-test\.[0-9]+)?$/.test(value)
}

function isTestVersion(value) {
  return /^0\.17\.9-fork\.[0-9]+-test\.[0-9]+$/.test(value)
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const data = await readResponse(response)
  return { response, data }
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

async function waitForGithubTag({ shouldExist, expectedSha }) {
  const path = `/repos/${githubRepository}/git/ref/tags/${encodeURIComponent(tag)}`
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { response, data } = await githubRequest(path)
    if (shouldExist && response.ok) {
      const actualSha = data?.object?.sha
      if (actualSha !== expectedSha) {
        throw new Error(`Mirrored tag ${tag} points to an unexpected commit`)
      }
      return
    }
    if (!shouldExist && response.status === 404) return
    if (response.status !== 404) {
      throw new Error(`GitHub tag lookup failed (${response.status}): ${JSON.stringify(data)}`)
    }
    await pause(10_000)
  }
  throw new Error(`GitHub mirror did not ${shouldExist ? 'receive' : 'remove'} tag ${tag} in time`)
}

async function syncGiteaPushMirror() {
  const path = `/repos/${giteaRepository}/push_mirrors-sync`
  const { response, data } = await giteaRequest(path, { method: 'POST' })
  assertOk(response, data, 'Gitea push mirror sync')
}

async function getGithubRelease() {
  const path = `/repos/${githubRepository}/releases/tags/${encodeURIComponent(tag)}`
  return githubRequest(path)
}

async function uploadAsset(uploadUrl, filePath) {
  const fileStat = await stat(filePath)
  const url = new URL(uploadUrl.replace(/\{\?name,label\}$/, ''))
  url.searchParams.set('name', basename(filePath))

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubToken}`,
        'Content-Type': filePath.endsWith('.tgz') ? 'application/gzip' : 'application/octet-stream',
        'Content-Length': fileStat.size,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch {
          data = text
        }
        if (response.statusCode !== 201) {
          reject(new Error(`GitHub asset upload failed (${response.statusCode}): ${JSON.stringify(data)}`))
          return
        }
        resolve(data)
      })
    })
    request.on('error', reject)
    createReadStream(filePath).on('error', reject).pipe(request)
  })
}

async function verifyTarballDownloads(files) {
  for (const file of files.filter((path) => path.endsWith('.tgz'))) {
    const url = `https://github.com/${githubRepository}/releases/download/${tag}/${basename(file)}`
    let downloaded = false
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await fetch(url, { method: 'GET', redirect: 'follow' })
      if (response.ok) {
        await response.body?.cancel()
        downloaded = true
        break
      }
      await response.body?.cancel()
      if (response.status !== 404) {
        throw new Error(`Tarball URL check failed (${response.status}): ${url}`)
      }
      await pause(5_000)
    }
    if (!downloaded) throw new Error(`Published tarball did not become downloadable: ${url}`)
    console.log(`Verified download URL: ${url}`)
  }
}

async function publishRelease() {
  const existingRelease = await getGithubRelease()
  if (existingRelease.response.ok) throw new Error(`GitHub release already exists for ${tag}`)
  if (existingRelease.response.status !== 404) {
    throw new Error(`GitHub release lookup failed (${existingRelease.response.status})`)
  }

  const createTagPath = `/repos/${giteaRepository}/git/refs`
  const { response: tagResponse, data: tagData } = await giteaRequest(createTagPath, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
  })
  assertOk(tagResponse, tagData, `Create Gitea tag ${tag}`)

  await syncGiteaPushMirror()
  await waitForGithubTag({ shouldExist: true, expectedSha: sha })

  const assets = [
    `dist-tarballs/rari-linux-x64-${version}.tgz`,
    `dist-tarballs/rari-linux-arm64-${version}.tgz`,
    'release-assets/rari-linux-x64',
    'release-assets/rari-linux-x64.debug',
    'release-assets/rari-linux-arm64',
    'release-assets/rari-linux-arm64.debug',
  ].map((path) => join(process.cwd(), path))
  for (const asset of assets) await stat(asset)

  const releaseBody = [
    `Fork prerelease built from commit ${sha}.`,
    '',
    'Includes Linux x64 and ARM64 npm tarballs, binaries, and debug sidecars.',
  ].join('\n')
  const { response: createResponse, data: release } = await githubRequest(
    `/repos/${githubRepository}/releases`,
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
  assertOk(createResponse, release, `Create GitHub draft release ${tag}`)
  if (typeof release?.upload_url !== 'string' || typeof release?.id !== 'number') {
    throw new Error('GitHub draft release response did not include an upload URL and release ID')
  }

  for (const asset of assets) {
    const uploaded = await uploadAsset(release.upload_url, asset)
    console.log(`Uploaded ${uploaded.name}`)
  }

  const { response: publishResponse, data: published } = await githubRequest(
    `/repos/${githubRepository}/releases/${release.id}`,
    { method: 'PATCH', body: JSON.stringify({ draft: false }) },
  )
  assertOk(publishResponse, published, `Publish GitHub release ${tag}`)
  await verifyTarballDownloads(assets)
  console.log(`Published prerelease ${tag}`)
}

async function deleteTestRelease() {
  const { response: releaseResponse, data: release } = await getGithubRelease()
  if (!releaseResponse.ok && releaseResponse.status !== 404) {
    throw new Error(`GitHub release lookup failed (${releaseResponse.status})`)
  }

  const tagPath = `/repos/${giteaRepository}/git/refs/tags/${encodeURIComponent(tag)}`
  const { response: deleteTagResponse, data: deleteTagData } = await giteaRequest(tagPath, {
    method: 'DELETE',
  })
  if (!deleteTagResponse.ok && deleteTagResponse.status !== 404) {
    assertOk(deleteTagResponse, deleteTagData, `Delete Gitea test tag ${tag}`)
  }

  await syncGiteaPushMirror()
  await waitForGithubTag({ shouldExist: false })

  if (releaseResponse.ok) {
    const { response, data } = await githubRequest(
      `/repos/${githubRepository}/releases/${release.id}`,
      { method: 'DELETE' },
    )
    if (response.status !== 204 && response.status !== 404) {
      assertOk(response, data, `Delete GitHub test release ${tag}`)
    }
  }

  const verification = await getGithubRelease()
  if (verification.response.status !== 404) {
    throw new Error(`GitHub test release ${tag} still exists after cleanup`)
  }
  console.log(`Deleted test release and mirrored tag ${tag}`)
}

if (deleting) await deleteTestRelease()
else await publishRelease()
