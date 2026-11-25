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
    findDockerSafetyViolations(`docker run --name ${name} -dp ${fixedPort} postgres`).map(
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
    findDockerSafetyViolations('docker buildx prune -af').map(({ message }) => message),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker --context remote system prune -af').map(
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
    findDockerSafetyViolations('docker --context remote run --name fixed alpine').map(
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
      'docker run --name "rari-\\$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" alpine',
    ).map(({ message }) => message),
    ['container name is not unique to this job'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      "docker create --name 'rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB' alpine",
    ).map(({ message }) => message),
    ['container name is not unique to this job'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      [
        "smoke_container='rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB'",
        'docker create --name "$smoke_container" alpine',
      ].join('\n'),
    ).map(({ message }) => message),
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

test('does not reuse container name assignments from another workflow job', () => {
  const workflow = [
    'jobs:',
    '  first:',
    '    steps:',
    '      - run: |',
    '          c="rari-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"',
    '          docker create --name "$c" alpine',
    '  second:',
    '    steps:',
    '      - run: |',
    '          c=fixed',
    '          docker create --name "$c" alpine',
  ].join('\n')
  const violations = findDockerSafetyViolations(workflow, '.github/workflows/check.yml')

  assert.ok(
    violations.some(
      violation =>
        violation.line === 11 && violation.message === 'container name is not unique to this job',
    ),
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

test('scans a Compose file passed as an attached -f argument', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-attached-compose-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  substitution:',
    '    steps:',
    '      - run: $(docker compose -f custom.yml up)',
    '  subshell:',
    '    steps:',
    '      - run: (docker compose -fcustom.yml up)',
    '  absolute:',
    '    steps:',
    '      - run: /usr/bin/docker compose --file=custom.yml up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'custom.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(
      root,
      [{ path: workflowPath, source: workflow }],
      {},
    )

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'custom.yml')],
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

test('scans Compose files after Docker root options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-docker-root-option-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: docker --context remote compose -f custom.yml up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'custom.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(root, [{ path: workflowPath, source: workflow }])

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'custom.yml')],
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

test('scans Compose files after shell line continuations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-continuation-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: |',
    '          docker compose \\',
    '            -f custom.yml up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'custom.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(
      root,
      [{ path: workflowPath, source: workflow }],
      {},
    )

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'custom.yml')],
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

test('scans Compose files after global options with values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-global-option-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: docker compose --context remote -f custom.yml up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'custom.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(root, [{ path: workflowPath, source: workflow }])

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'custom.yml')],
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

test('scans every Compose invocation after a single ampersand and inside substitutions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-ampersand-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: docker compose -f first.yml up & docker compose -f second.yml up',
    '      - run: echo "$(docker compose -f third.yml up) $(docker compose -f fourth.yml up)"',
  ].join('\n')
  const emptyCompose = 'services: {}\n'
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'first.yml'), emptyCompose)
    await writeFile(join(root, 'second.yml'), fixedCompose)
    await writeFile(join(root, 'third.yml'), emptyCompose)
    await writeFile(join(root, 'fourth.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(root, [{ path: workflowPath, source: workflow }])

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      ['first.yml', 'second.yml', 'third.yml', 'fourth.yml'].map(file => resolve(root, file)),
    )
    assert.deepEqual(
      composeFiles.flatMap(({ path, source }) =>
        findDockerSafetyViolations(source, path).map(({ message }) => message),
      ),
      ['fixed host-port publishing', 'fixed host-port publishing'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores apostrophe comments when finding subsequent Compose commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-comment-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: |',
    "          # don't treat this apostrophe as shell quoting",
    '          docker compose -f first.yml up',
    '          docker compose -f second.yml up',
  ].join('\n')
  const emptyCompose = 'services: {}\n'
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'first.yml'), emptyCompose)
    await writeFile(join(root, 'second.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(root, [{ path: workflowPath, source: workflow }])

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'first.yml'), resolve(root, 'second.yml')],
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

test('ignores unrelated shell flags before a Compose command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-unrelated-shell-flags-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: curl -fsSL https://example.test/x | sh && docker compose up',
    '      - run: docker compose rm -f',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    assert.deepEqual(
      await collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      [],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when a Compose -f option has no file value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-missing-compose-option-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = 'jobs:\n  check:\n    steps:\n      - run: docker compose -f'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      /Cannot statically resolve explicit Compose file option/,
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

test('fails closed for a dynamic workflow working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-dynamic-working-directory-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - name: Start services',
    '        working-directory: ${{ env.DIR }}',
    '        run: docker compose up',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(
      join(root, 'compose.yaml'),
      'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"',
    )

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      /Cannot statically resolve workflow working directory/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scans Compose files selected by a job COMPOSE_FILE environment value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-env-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    env:',
    '      COMPOSE_FILE: "services/api/custom-compose.yml" # compose file selected',
    '    steps:',
    '      - run: docker compose up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await mkdir(join(root, 'services', 'api'), { recursive: true })
    await writeFile(join(root, 'services', 'api', 'custom-compose.yml'), fixedCompose)

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

test('scans Compose files selected by shell COMPOSE_FILE assignments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-shell-compose-env-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  inline:',
    '    steps:',
    '      - run: COMPOSE_FILE=inline-compose.yml docker compose up',
    '  exported:',
    '    steps:',
    '      - run: | # compose setup',
    '          export COMPOSE_FILE=exported-compose.yml',
    '          docker compose up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'inline-compose.yml'), fixedCompose)
    await writeFile(join(root, 'exported-compose.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(
      root,
      [{ path: workflowPath, source: workflow }],
      {},
    )

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'inline-compose.yml'), resolve(root, 'exported-compose.yml')],
    )
    assert.deepEqual(
      composeFiles.flatMap(({ path, source }) =>
        findDockerSafetyViolations(source, path).map(({ message }) => message),
      ),
      ['fixed host-port publishing', 'fixed host-port publishing'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when a shell COMPOSE_FILE assignment is dynamic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-dynamic-shell-compose-env-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: |',
    '          export COMPOSE_FILE="$CONFIG_FILE"',
    '          docker compose up',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      /Cannot statically resolve COMPOSE_FILE/,
    )

    const unsupportedAssignment = [
      'jobs:',
      '  check:',
      '    steps:',
      '      - run: if COMPOSE_FILE="$CONFIG_FILE" docker compose up',
    ].join('\n')
    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: unsupportedAssignment }], {}),
      /Cannot statically resolve shell COMPOSE_FILE assignment/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when a previous step writes COMPOSE_FILE to GITHUB_ENV', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-github-env-compose-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: |',
    '          cat >> "$GITHUB_ENV" <<EOF',
    '          COMPOSE_FILE=custom.yml',
    '          EOF',
    '      - run: docker compose up',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      /Cannot statically resolve COMPOSE_FILE written to GITHUB_ENV/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scans every Compose file selected by COMPOSE_FILE in the working directory .env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-dotenv-'))
  const workingDirectory = join(root, 'services', 'api')
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    defaults:',
    '      run:',
    '        working-directory: services/api',
    '    steps:',
    '      - run: docker compose up',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await mkdir(workingDirectory, { recursive: true })
    await writeFile(
      join(workingDirectory, '.env'),
      "COMPOSE_FILE='base.yml:unsafe.yml' # compose files\n",
    )
    await writeFile(join(workingDirectory, 'base.yml'), 'services: {}\n')
    await writeFile(
      join(workingDirectory, 'unsafe.yml'),
      'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"',
    )

    const composeFiles = await collectComposeFiles(
      root,
      [{ path: workflowPath, source: workflow }],
      {},
    )

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(workingDirectory, 'base.yml'), resolve(workingDirectory, 'unsafe.yml')],
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

test('scans Compose files selected by the runner COMPOSE_FILE environment value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-runner-compose-env-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = 'jobs:\n  check:\n    steps:\n      - run: docker compose up'
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'runner-compose.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(
      root,
      [{ path: workflowPath, source: workflow }],
      { COMPOSE_FILE: 'runner-compose.yml' },
    )

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'runner-compose.yml')],
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

test('fails closed for a dynamic workflow COMPOSE_FILE value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-dynamic-compose-env-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    env:',
    '      COMPOSE_FILE: ${{ vars.COMPOSE_FILE }}',
    '    steps:',
    '      - run: docker compose up',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      /Cannot statically resolve COMPOSE_FILE/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when COMPOSE_FILE in .env cannot be resolved statically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-dynamic-dotenv-compose-env-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = ['jobs:', '  check:', '    steps:', '      - run: docker compose up'].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, '.env'), 'COMPOSE_FILE=$COMPOSE_CONFIG\n')

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      /Cannot statically resolve COMPOSE_FILE/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails when a COMPOSE_FILE environment value does not identify a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-missing-compose-env-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    env:',
    '      COMPOSE_FILE: missing-compose.yml',
    '    steps:',
    '      - run: docker compose up',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      /Explicit Compose file does not exist/,
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
    assert.notEqual(containerCreate, -1)
    const cleanupStart = workflow.indexOf('          cleanup() {', containerCreate)
    const cleanupEnd = workflow.indexOf('          trap cleanup EXIT', cleanupStart)
    assert.notEqual(cleanupStart, -1)
    assert.notEqual(cleanupEnd, -1)
    const cleanupScript = workflow
      .slice(cleanupStart, cleanupEnd)
      .split('\n')
      .map(line => line.replace(/^ {10}/, ''))
      .join('\n')
    assert.match(cleanupScript, /docker rm --force/)
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

test('reads the uppercase -H root option before the subcommand', async () => {
  assert.deepEqual(
    findDockerSafetyViolations('docker -H tcp://host run --name fixed alpine').map(
      ({ message }) => message,
    ),
    ['container name is not unique to this job'],
  )

  const root = await mkdtemp(join(tmpdir(), 'docker-safety-uppercase-host-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: docker -H host compose -f custom.yml up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'custom.yml'), fixedCompose)

    const composeFiles = await collectComposeFiles(root, [{ path: workflowPath, source: workflow }])

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'custom.yml')],
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

test('reads the subcommand after container, image, volume, network and system groups', () => {
  const nameViolation = ['container name is not unique to this job']
  assert.deepEqual(
    findDockerSafetyViolations('docker container run --name fixed alpine').map(
      ({ message }) => message,
    ),
    nameViolation,
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker container create --name fixed alpine').map(
      ({ message }) => message,
    ),
    nameViolation,
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      'docker container run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" alpine',
    ),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker network create rari-fixed').map(({ message }) => message),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker container prune -f').map(({ message }) => message),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker container rm -f $(docker container ls -aq)').map(
      ({ message }) => message,
    ),
    ['removing every Docker container'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker container remove -f $(docker container list -aq)').map(
      ({ message }) => message,
    ),
    ['removing every Docker container'],
  )
})

test('requires an every-container listing that emits identifiers for global removal', () => {
  for (const listing of ['docker ps -a -q', 'docker ps -qa', 'docker container ls -a -q']) {
    assert.deepEqual(
      findDockerSafetyViolations(`docker rm -f $(${listing})`).map(({ message }) => message),
      ['removing every Docker container'],
      listing,
    )
  }
  assert.deepEqual(
    findDockerSafetyViolations('docker rm -f $(docker ps -q)').map(({ message }) => message),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker rm $(docker ps -aq)').map(({ message }) => message),
    ['removing every Docker container'],
  )
  assert.deepEqual(
    findDockerSafetyViolations("docker rm -f $(docker ps -a --format '{{.ID}}')").map(
      ({ message }) => message,
    ),
    ['removing every Docker container'],
  )
})

test('detects global container removal across lines in a shell script', () => {
  for (const script of [
    ['ids=$(docker ps -aq)', 'docker rm -f $ids'].join('\n'),
    ['docker rm -f $(', '  docker ps -aq', ')'].join('\n'),
  ]) {
    assert.deepEqual(
      findDockerSafetyViolations(script).map(({ message }) => message),
      ['removing every Docker container'],
      script,
    )
  }

  const workflow = [
    'jobs:',
    '  check:',
    '    runs-on: inference-x64',
    '    steps:',
    '      - run: |',
    '          ids=$(docker ps -aq)',
    '          docker rm -f $ids',
  ].join('\n')
  assert.deepEqual(
    findDockerSafetyViolations(workflow, '.github/workflows/check.yml').map(
      ({ message }) => message,
    ),
    ['removing every Docker container'],
  )

  const separateSteps = [
    'jobs:',
    '  check:',
    '    runs-on: inference-x64',
    '    steps:',
    '      - run: docker ps -aq',
    '      - run: docker rm -f $ids',
  ].join('\n')
  assert.deepEqual(findDockerSafetyViolations(separateSteps, '.github/workflows/check.yml'), [])
})

test('recognizes true assignments on Docker boolean flags when removing containers', () => {
  assert.deepEqual(
    findDockerSafetyViolations('docker rm --force=true $(docker ps --all=true --quiet=true)').map(
      ({ message }) => message,
    ),
    ['removing every Docker container'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker rm --force=false $(docker ps --all=false --quiet=true)'),
    [],
  )
})

test('recognizes true assignments on short Docker boolean flags when removing containers', () => {
  assert.deepEqual(
    findDockerSafetyViolations('docker rm -f=true $(docker ps -a=true -q=true)').map(
      ({ message }) => message,
    ),
    ['removing every Docker container'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker rm -f=true $(docker ps -a=true -q=false)'),
    [],
  )
})

test('ignores dynamic ports and ports opened inside a container', () => {
  const workflow =
    'docker run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" -p 5432 postgres\nserver --port 43819'
  const compose = 'services:\n  db:\n    ports:\n      - "5432"'

  assert.deepEqual(findDockerSafetyViolations(workflow), [])
  assert.deepEqual(findDockerSafetyViolations(compose), [])
})
