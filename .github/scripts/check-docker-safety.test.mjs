import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectComposeFiles, findDockerSafetyViolations } from './check-docker-safety.mjs'

const scriptPath = fileURLToPath(new URL('./check-docker-safety.mjs', import.meta.url))

test('rejects fixed Docker host ports and fixed compose ports', () => {
  const fixedPort = [5432, 5432].join(':')
  const name = '"rari-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"'
  const workflow = `docker run --name ${name} --publish=127.0.0.1:${fixedPort} postgres`
  const compose = `services:\n  db:\n    ports:\n      - ${JSON.stringify(fixedPort)}`

  assert.deepEqual(
    findDockerSafetyViolations(workflow).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(`docker run --name ${name} -p ${fixedPort} postgres`).map(
      ({ message }) => message,
    ),
    ['fixed host-port publishing'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      'docker run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" --publish "127.0.0.1:5432:5432" postgres',
    ).map(({ message }) => message),
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
        '"label=ci.task=$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB-${{ toJSON(matrix) }}"',
      ].join(' '),
    ),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      [
        'jobs:',
        '  check:',
        '    strategy:',
        '      matrix:',
        '        os: [linux, windows]',
        '        target: [x86, arm]',
        '    steps:',
        '      - run: docker network prune --filter "label=ci.task=${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}-${{ matrix.target }}"',
      ].join('\n'),
      '.github/workflows/check.yml',
    ).map(({ message }) => message),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      [
        'jobs:',
        '  check:',
        '    strategy:',
        '      matrix:',
        '        os: [linux, windows]',
        '        target: [x86, arm]',
        '    steps:',
        '      - run: docker network prune --filter "label=ci.task=${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}-${{ matrix.os }}-${{ matrix.target }}"',
      ].join('\n'),
      '.github/workflows/check.yml',
    ),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      [
        'jobs:',
        '  check:',
        '    strategy:',
        '      matrix:',
        '        os: [linux, windows]',
        '        target: [x86]',
        '        include:',
        '          - os: linux',
        '            target: x86',
        '            variant: first',
        '          - os: linux',
        '            target: x86',
        '            variant: second',
        '    steps:',
        '      - run: docker network prune --filter "label=ci.task=${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}-${{ matrix.os }}-${{ matrix.target }}"',
      ].join('\n'),
      '.github/workflows/check.yml',
    ).map(({ message }) => message),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      [
        'jobs:',
        '  check:',
        '    strategy:',
        '      matrix:',
        '        os: [linux, windows]',
        '        target: [x86]',
        '        include:',
        '          - os: linux',
        '            target: x86',
        '            variant: first',
        '          - os: linux',
        '            target: x86',
        '            variant: second',
        '    steps:',
        '      - run: docker network prune --filter "label=ci.task=${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}-${{ matrix.os }}-${{ matrix.target }}-${{ matrix.variant }}"',
      ].join('\n'),
      '.github/workflows/check.yml',
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

test('requires Docker container names to include the run, attempt, and job identity', () => {
  assert.deepEqual(
    findDockerSafetyViolations('docker create --name rari-smoke-image alpine').map(
      ({ message }) => message,
    ),
    ['container name is not unique to this job'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker run --name "rari-$GITHUB_RUN_ID-$GITHUB_JOB" alpine').map(
      ({ message }) => message,
    ),
    ['container name is not unique to this job'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      [
        'smoke_container="rari-smoke-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"',
        'docker create --name "$smoke_container" alpine',
      ].join('\n'),
    ),
    [],
  )
  const matrixWorkflow = dimensions =>
    [
      'jobs:',
      '  check:',
      '    strategy:',
      '      matrix:',
      '        os: [linux, windows]',
      '        target: [x86, arm]',
      '    steps:',
      `      - run: docker create --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB-${dimensions}" alpine`,
    ].join('\n')
  assert.deepEqual(
    findDockerSafetyViolations(
      matrixWorkflow('${{ matrix.target }}'),
      '.github/workflows/check.yml',
    ).map(({ message }) => message),
    ['container name is not unique to this job'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      matrixWorkflow('${{ matrix.os }}-${{ matrix.target }}'),
      '.github/workflows/check.yml',
    ),
    [],
  )
})

test('resolves explicit Compose files from commented steps in the step working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-'))
  const subdirectory = join(root, 'services', 'api')
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps: # run steps',
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

test('resolves Compose files using the job default run working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-defaults-'))
  const subdirectory = join(root, 'services', 'api')
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    defaults:',
    '      run:',
    '        working-directory: services/api',
    '    steps:',
    '      - name: Start services',
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

test('fails closed when an explicit Compose file reference is dynamic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-dynamic-compose-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    env:',
    '      COMPOSE_FILE: custom-compose.yml',
    '    steps:',
    '      - name: Start services',
    '        run: docker compose -f "$COMPOSE_FILE" up',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(
      join(root, 'custom-compose.yml'),
      'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"',
    )

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }]),
      /Cannot statically resolve explicit Compose file reference/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails when an explicit Compose file does not exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-missing-compose-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = 'jobs:\n  check:\n    steps:\n      - run: docker compose -f missing.yml up'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }]),
      /Explicit Compose file does not exist/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skips missing files only for default Compose name probes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-default-compose-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = 'jobs:\n  check:\n    steps:\n      - run: docker compose up'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })

    assert.deepEqual(
      await collectComposeFiles(root, [{ path: workflowPath, source: workflow }]),
      [],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI exits nonzero for a violating in-scope workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-cli-'))
  const workflowDirectory = join(root, '.github', 'workflows')

  try {
    await mkdir(workflowDirectory, { recursive: true })
    await writeFile(
      join(workflowDirectory, 'check.yml'),
      [
        'jobs:',
        '  check:',
        '    runs-on: inference-x64',
        '    steps:',
        '      - run: docker run --publish "127.0.0.1:5432:5432" postgres',
      ].join('\n'),
    )

    const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' })

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /check\.yml:5: fixed host-port publishing/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('smoke cleanup exits nonzero when removing the container fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-cleanup-'))

  try {
    const workflow = await readFile(new URL('../workflows/fork-build.yml', import.meta.url), 'utf8')
    const containerCreate = workflow.indexOf('          docker create --name')
    const cleanupStart = workflow.indexOf('          cleanup() {', containerCreate)
    const cleanupEnd = workflow.indexOf('          trap cleanup EXIT', cleanupStart)
    assert.notEqual(cleanupStart, -1)
    assert.notEqual(cleanupEnd, -1)
    const cleanupScript = workflow
      .slice(cleanupStart, cleanupEnd)
      .split('\n')
      .map(line => line.replace(/^ {10}/, ''))
      .join('\n')
    const bin = join(root, 'bin')
    await mkdir(bin)
    const dockerPath = join(bin, 'docker')
    await writeFile(dockerPath, '#!/bin/sh\nexit 17\n')
    await chmod(dockerPath, 0o755)

    const result = spawnSync('bash', ['-c', `${cleanupScript}\ntrap cleanup EXIT\nexit 0`], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        smoke_container: 'rari-smoke-test',
      },
    })

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /Failed to remove smoke container rari-smoke-test/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores dynamic ports and ports opened inside a container', () => {
  const workflow =
    'docker run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" -p 5432 postgres\nserver --port 43819'
  const compose = 'services:\n  db:\n    ports:\n      - "5432"'

  assert.deepEqual(findDockerSafetyViolations(workflow), [])
  assert.deepEqual(findDockerSafetyViolations(compose), [])
})
