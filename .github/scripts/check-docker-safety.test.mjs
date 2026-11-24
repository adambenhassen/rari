import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { collectComposeFiles, findDockerSafetyViolations } from './check-docker-safety.mjs'

test('rejects fixed Docker host ports and fixed compose ports', () => {
  const fixedPort = [5432, 5432].join(':')
  const workflow = `docker run --publish=127.0.0.1:${fixedPort} postgres`
  const compose = `services:\n  db:\n    ports:\n      - ${JSON.stringify(fixedPort)}`

  assert.deepEqual(
    findDockerSafetyViolations(workflow).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(`docker run -p ${fixedPort} postgres`).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker run --publish "127.0.0.1:5432:5432" postgres').map(
      ({ message }) => message,
    ),
    ['fixed host-port publishing'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(compose).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
})

test('rejects global Docker cleanup and filters that are not unique to a job', () => {
  assert.deepEqual(
    findDockerSafetyViolations(['docker', 'system', 'prune', '-af'].join(' ')).map(
      ({ message }) => message,
    ),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      ['docker', 'network', 'prune', '--filter', 'label=ci.task=$GITHUB_RUN_ID'].join(' '),
    ).map(({ message }) => message),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      [
        'docker',
        'network',
        'prune',
        '--filter',
        'label=ci.task=$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB-$MATRIX_ID',
      ].join(' '),
    ),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      'docker network prune --filter "label=ci.task=${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}-${{ matrix.target }}"',
    ),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      'docker network prune --filter "label=ci.task=${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}"',
    ).map(({ message }) => message),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      ['docker', 'network', 'prune', '--filter', 'label=ci.task=$TASK_ID'].join(' '),
    ),
    [],
  )
  const listContainers = ['docker', 'ps', '-aq'].join(' ')
  assert.deepEqual(
    findDockerSafetyViolations(['docker', 'rm', '-f', `$(${listContainers})`].join(' ')).map(
      ({ message }) => message,
    ),
    ['removing every Docker container'],
  )
})

test('resolves explicit Compose files from the step working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-'))
  const subdirectory = join(root, 'services', 'api')
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - name: Start services',
    '        working-directory: services/api',
    '        run: docker compose -f custom-compose.yml up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(subdirectory, { recursive: true })
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'custom-compose.yml'), 'services: {}\n')
    await writeFile(join(subdirectory, 'custom-compose.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(root, [{ path: workflowPath, source: workflow }])

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'services/api/custom-compose.yml')],
    )
    assert.deepEqual(
      composeFiles.flatMap(({ path, source }) =>
        findDockerSafetyViolations(source, path).map(({ message }) => message),
      ),
      ['fixed host-port publishing'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores dynamic ports and ports opened inside a container', () => {
  const workflow = 'docker run -p 5432 postgres\nserver --port 43819'
  const compose = 'services:\n  db:\n    ports:\n      - "5432"'

  assert.deepEqual(findDockerSafetyViolations(workflow), [])
  assert.deepEqual(findDockerSafetyViolations(compose), [])
})
