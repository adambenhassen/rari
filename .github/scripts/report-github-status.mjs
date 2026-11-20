import { readFile } from 'node:fs/promises'

const repository = 'adambenhassen/rari'
const context = 'rari checks'
const eventPath = process.env.GITHUB_EVENT_PATH
const token = process.env.RARI_GITHUB_TOKEN

if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required')
if (!token) throw new Error('RARI_GITHUB_TOKEN is required')

const event = JSON.parse(await readFile(eventPath, 'utf8'))
const run = event.workflow_run
if (!run || run.event !== 'pull_request') {
  console.log('No pull request workflow run to report')
  process.exit(0)
}

const sha = run.head_sha
if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) {
  throw new Error('Workflow run did not provide a valid commit SHA')
}

const status =
  run.conclusion === 'success'
    ? 'success'
    : ['failure', 'timed_out'].includes(run.conclusion)
      ? 'failure'
      : 'error'

const payload = {
  state: status,
  context,
  description: `rari checks ${status}`,
  target_url: `https://github.com/${repository}/commit/${sha}`,
}
const url = `https://api.github.com/repos/${repository}/statuses/${sha}`

for (let attempt = 0; attempt < 30; attempt += 1) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(payload),
  })

  if (response.ok) {
    console.log(`Reported ${status} status for ${sha}`)
    process.exit(0)
  }

  const responseText = await response.text()
  if (![404, 422].includes(response.status) || attempt === 29) {
    throw new Error(`GitHub status request failed (${response.status}): ${responseText}`)
  }

  await new Promise(resolve => setTimeout(resolve, 10_000))
}
