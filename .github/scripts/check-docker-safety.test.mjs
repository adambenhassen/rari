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
  assert.deepEqual(
    findDockerSafetyViolations('services:\n  db:\n    ports:\n      - 5432:5432').map(
      ({ message }) => message,
    ),
    ['fixed host-port publishing'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      ['services:', '  db:', '    ports:', '      - published: 5432', '        target: 5432'].join(
        '\n',
      ),
    ).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('services:\n  db:\n    ports:\n      - target: 5432').map(
      ({ message }) => message,
    ),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      [
        'services:',
        '  db:',
        "    'ports':",
        "      - 'published': 5432",
        "        'target': 5432",
      ].join('\n'),
    ).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      "services: {db: {'ports': [{'published': 5432, 'target': 5432}]}}",
    ).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
})

test('rejects literal host ports when the container port is variable', () => {
  const name = '--name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  const docker = `docker run ${name} -p 5432:$PG_PORT postgres`
  const dockerSpecialParameter = `docker run ${name} -p "5432:$?" postgres`
  const composeScalar = 'services:\n  db:\n    ports:\n      - "5432:${PG_PORT}"'
  const composeFlow = 'services:\n  db:\n    ports: ["5432:${PG_PORT}"]'

  for (const source of [docker, dockerSpecialParameter, composeScalar, composeFlow]) {
    assert.deepEqual(
      findDockerSafetyViolations(source).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }
})

test('rejects variable host ports in Docker publish flags', () => {
  const name = '--name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  const commands = [
    `docker run ${name} -p "$HOST_PORT:5432" postgres`,
    `docker run ${name} --publish "$HOST_PORT:5432" postgres`,
    `docker run ${name} --publish="$HOST_PORT:5432" postgres`,
    `docker run ${name} -dp "\${DB_PORT}:5432" postgres`,
  ]

  for (const command of commands) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }

  assert.deepEqual(
    findDockerSafetyViolations(`docker run ${name} -p "\${HOST_PORT:+}:5432" postgres`).map(
      ({ message }) => message,
    ),
    ['fixed host-port publishing'],
  )
})

test('rejects Docker publish words that shell quoting or xargs can rewrite', () => {
  const name = '--name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  const commands = [
    `docker run ${name} -p $'5432':5432 postgres`,
    `docker run ${name} -p "54"32:5432 postgres`,
    `docker run ${name} -p 5432':5432' postgres`,
    `xargs -I{} docker run ${name} -p {}:5432 postgres`,
    `docker run ${name} -\\p 5432:5432 image`,
    `docker run ${name} -'p' 5432:5432 image`,
    `docker run ${name} -\${PUBLISH_FLAG} 5432:5432 image`,
    `docker run ${name} -"\${PUBLISH_FLAG}" 5432:5432 image`,
    `docker run ${name} --publish\${EMPTY} 5432:5432 image`,
  ]

  for (const command of commands) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }
})

test('rejects shell substitutions in fixed Docker host-port mappings', () => {
  const name = '--name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  const commands = [
    `docker run ${name} -p "$(printf 5432):5432" postgres`,
    'docker run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" --publish "`printf 5432`:5432" postgres',
    `docker run ${name} -p "5432:$(printf 5432)" postgres`,
    `docker run ${name} -p {5432..5432}:5432 postgres`,
    `docker run ${name} -p 5432:{5432..5432} postgres`,
  ]

  for (const command of commands) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }
})

test('rejects variable values in Compose host-port positions', () => {
  const sources = [
    'services:\n  db:\n    ports:\n      - "$HOST_PORT:5432"',
    'services:\n  db:\n    ports:\n      - "${DB_PORT}:5432"',
    'services:\n  db:\n    ports:\n      - target: 5432\n        published: ${DB_PORT}',
  ]

  for (const source of sources) {
    assert.deepEqual(
      findDockerSafetyViolations(source).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }

  assert.deepEqual(
    findDockerSafetyViolations('services:\n  db:\n    ports:\n      - "${HOST_PORT:+}:5432"'),
    [],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      'services:\n  db:\n    ports:\n      - target: 5432\n        published: ${HOST_PORT:+}',
    ),
    [],
  )
})

test('rejects global Docker cleanup and filters that are not unique to a job', () => {
  assert.deepEqual(
    findDockerSafetyViolations(['docker', 'system', 'prune', '-af'].join(' ')).map(
      ({ message }) => message,
    ),
    ['Docker system prune is not allowed'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker buildx prune -af').map(({ message }) => message),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker buildx --builder ci prune -af').map(
      ({ message }) => message,
    ),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations('docker --context remote system prune -af').map(
      ({ message }) => message,
    ),
    ['Docker system prune is not allowed'],
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
    findDockerSafetyViolations('docker system prune --filter "label=ci.task=$TASK_ID"').map(
      ({ message }) => message,
    ),
    ['Docker system prune is not allowed'],
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

test('normalizes quoted fragments in Docker command, group, and subcommand words', () => {
  const name = '--name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  const publishCommands = [
    `"docker" run ${name} -p 5432:5432 image`,
    `do"cker" run ${name} -p 5432:5432 image`,
    `docker "ru"n ${name} -p 5432:5432 image`,
  ]

  for (const command of publishCommands) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }

  assert.deepEqual(
    findDockerSafetyViolations('docker "sys"tem prune -af').map(({ message }) => message),
    ['Docker system prune is not allowed'],
  )
})

test('matches container names relative to each Docker invocation', () => {
  const scopedName = '--name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  assert.deepEqual(
    findDockerSafetyViolations(`${scopedName}; docker run --name fixed alpine`).map(
      ({ message }) => message,
    ),
    ['container name is not unique to this job'],
  )
})

test('recognizes Docker commands immediately after shell control operators', () => {
  const name = '--name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  const cases = [
    [`echo ready;docker run ${name} -p 5432:5432 image`, 'fixed host-port publishing'],
    ['echo ready &&docker system prune -af', 'Docker system prune is not allowed'],
  ]

  for (const [command, message] of cases) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      [message],
    )
  }
})

test('scans Docker commands inside quoted shell scripts', () => {
  const name = 'rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB'
  const publishCommands = [
    `bash -c "docker run --name ${name} -p 5432:5432 image"`,
    `sh -c 'docker run --name ${name} -p 5432:5432 image'`,
    `bash -c $'docker run --name ${name} -p 5432:5432 image'`,
    `bash -c $'\\x64ocker run --name ${name} -p 5432:5432 image'`,
    `bash -c $'do'cker\\ run\\ --name\\ ${name}\\ -p\\ 5432:5432\\ image`,
  ]

  for (const command of publishCommands) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }

  assert.deepEqual(
    findDockerSafetyViolations("sh -c 'docker rm -f $(docker ps -aq)'").map(
      ({ message }) => message,
    ),
    ['removing every Docker container'],
  )
})

test('scans Docker commands inside process substitutions', () => {
  const name = 'rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB'
  for (const command of [
    `cat <(docker run --name ${name} -p 5432:5432 image)`,
    `tee >(docker run --name ${name} -p 5432:5432 image)`,
  ]) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }
})

test('scans Docker commands passed to env split-string', () => {
  assert.ok(
    findDockerSafetyViolations("env -S 'docker run -p 5432:5432 img'").some(
      ({ message }) => message === 'fixed host-port publishing',
    ),
  )
})

test('scans Docker commands stored in quoted shell assignments', () => {
  const name = 'rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB'
  const commands = [
    `CMD="docker run --name ${name} -p 5432:5432 image"; $CMD`,
    `CMD='docker run --name ${name} -p 5432:5432 image'; eval "$CMD"`,
  ]

  for (const command of commands) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }
})

test('resolves literal Docker executable assignments', () => {
  const name = '"rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  for (const command of [
    `D=docker; $D run --name ${name} -p 5432:5432 image`,
    `D=docker; echo D=echo; $D run --name ${name} -p 5432:5432 image`,
  ]) {
    assert.deepEqual(
      findDockerSafetyViolations(command).map(({ message }) => message),
      ['fixed host-port publishing'],
    )
  }
})

test('keeps command substitution assignments scoped to their shell', () => {
  assert.deepEqual(
    findDockerSafetyViolations(
      'D=docker; result=$(D=echo; printf ok); "$D" run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" -p 5432:5432 image',
    ).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
})

test('resolves Docker executable assignments in parenthesized subshells', () => {
  assert.deepEqual(
    findDockerSafetyViolations(
      '( D=docker; "$D" run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" -p 5432:5432 image )',
    ).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
})

test('ignores parentheses in shell comments when scoping assignments', () => {
  const command = [
    'D=docker; (',
    '  # ) is comment text, not the end of the subshell',
    '  D=echo; printf ok',
    '); "$D" run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" -p 5432:5432 image',
  ].join('\n')

  assert.deepEqual(
    findDockerSafetyViolations(command).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
})

test('fails closed on dynamic executable assignments', () => {
  assert.throws(
    () => findDockerSafetyViolations('D="$(printf docker)"; "$D" run -p 5432:5432 image'),
    /Cannot statically resolve shell command variable D/,
  )
  assert.throws(
    () => findDockerSafetyViolations('result=$(D="$(printf docker)"; "$D" run -p 5432:5432 image)'),
    /Cannot statically resolve shell command variable D/,
  )
  assert.doesNotThrow(() => findDockerSafetyViolations('D="$(printf docker)"; echo "$D"'))
})

test('fails closed on unresolved command-position shell expansions', () => {
  const commands = [
    '"${DOCKER_BIN:-docker}" run -p 5432:5432 img',
    '"$(which docker)" run -p 5432:5432 img',
    '$(which docker) run -p 5432:5432 img',
    'for D in docker; do "$D" run -p 5432:5432 img; done',
    'read D <<< docker; $D run -p 5432:5432 img',
    'exec "${DOCKER_BIN:-docker}" run -p 5432:5432 img',
    'env "${DOCKER_BIN:-docker}" run -p 5432:5432 img',
    'command "${DOCKER_BIN:-docker}" run -p 5432:5432 img',
    'bash -c \'"${DOCKER_BIN:-docker}" run -p 5432:5432 img\'',
    'bash -c\'"${DOCKER_BIN:-docker}" run -p 5432:5432 img\'',
    'sh -c \'"${DOCKER_BIN:-docker}" run -p 5432:5432 img\'',
    'bash -o pipefail -c \'"${DOCKER_BIN:-docker}" run -p 5432:5432 img\'',
    'bash -O extglob -c \'"${DOCKER_BIN:-docker}" run -p 5432:5432 img\'',
  ]

  for (const command of commands) {
    assert.throws(
      () => findDockerSafetyViolations(command),
      /Cannot statically resolve shell command/,
      command,
    )
  }
})

test('resolves Docker executable assignments across a workflow run block', () => {
  const name = '"rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  const workflow = `jobs:\n  check:\n    steps:\n      - run: |\n          D=docker\n          $D run --name ${name} -p 5432:5432 image`

  assert.deepEqual(
    findDockerSafetyViolations(workflow, '.github/workflows/assigned-docker.yml').map(
      ({ message }) => message,
    ),
    ['fixed host-port publishing'],
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

test('resolves Compose files separately for each invocation in a workflow step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-per-invocation-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - run: |',
    '          docker compose -f custom.yml up',
    '          docker compose up',
  ].join('\n')
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'custom.yml'), 'services: {}\n')
    await writeFile(join(root, 'compose.yaml'), fixedCompose)

    const composeFiles = await collectComposeFiles(root, [{ path: workflowPath, source: workflow }])

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'custom.yml'), resolve(root, 'compose.yaml')],
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

test('scans Compose files when step items align with the steps key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-indentless-steps-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '    - run: docker compose -f custom.yml up',
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

test('fails closed when a Compose command is in an unparsed workflow step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-unparsed-step-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = [
    'jobs:',
    '  check:',
    '    steps:',
    '  - run: docker compose -f custom.yml up',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }]),
      /Cannot parse Docker Compose command in an unparsed workflow step/,
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

test('scans the default Compose override file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-override-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = 'jobs:\n  check:\n    steps:\n      - run: docker compose up'

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'compose.yaml'), 'services: {}\n')
    await writeFile(
      join(root, 'compose.override.yaml'),
      'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"',
    )

    const composeFiles = await collectComposeFiles(root, [{ path: workflowPath, source: workflow }])

    assert.deepEqual(
      composeFiles.map(({ path }) => path),
      [resolve(root, 'compose.yaml'), resolve(root, 'compose.override.yaml')],
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

test('fails closed on Compose include and extends file references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-references-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = 'jobs:\n  check:\n    steps:\n      - run: docker compose up'
  const fixedCompose = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'
  const configs = [
    'include:\n  - path: referenced.yml\nservices: {}\n',
    "'include':\n  - path: referenced.yml\nservices: {}\n",
    "{'include': [{path: referenced.yml}], services: {}}\n",
    'services:\n  web:\n    extends:\n      file: referenced.yml\n      service: base\n',
    "services:\n  web:\n    'extends':\n      'file': referenced.yml\n      service: base\n",
    "services: {web: {'extends': {'file': referenced.yml, service: base}}}\n",
  ]

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'referenced.yml'), fixedCompose)

    for (const config of configs) {
      await writeFile(join(root, 'compose.yaml'), config)
      await assert.rejects(
        collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
        /Cannot statically scan Compose include or extends.file/,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed on Compose anchors and aliases that can hide port mappings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-compose-aliases-'))
  const workflowPath = join(root, '.github', 'workflows', 'check.yml')
  const workflow = 'jobs:\n  check:\n    steps:\n      - run: docker compose up'
  const compose = [
    'x-dbports: &dbports',
    '  - "5432:5432"',
    'services:',
    '  db:',
    '    ports: *dbports',
  ].join('\n')

  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, 'compose.yaml'), compose)

    await assert.rejects(
      collectComposeFiles(root, [{ path: workflowPath, source: workflow }], {}),
      /Cannot statically scan YAML anchors or aliases/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI fails closed on anchors and aliases in an in-scope workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-workflow-aliases-'))
  const workflowDirectory = join(root, '.github', 'workflows')

  try {
    await mkdir(workflowDirectory, { recursive: true })
    await writeFile(
      join(workflowDirectory, 'check.yml'),
      [
        'jobs:',
        '  check:',
        '    runs-on: inference-x64',
        '    strategy:',
        '      matrix:',
        '        dbports: &dbports ["5432:5432"]',
        '    services:',
        '      postgres:',
        '        image: postgres',
        '        ports: *dbports',
      ].join('\n'),
    )

    const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' })

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /Cannot statically scan YAML anchors or aliases in .*check\.yml/)
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

test('CLI exits nonzero for variable Docker host-port publishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-cli-variable-publish-'))
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
        '      - run: docker run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" -p "$HOST_PORT:5432" postgres',
        '      - run: docker run --name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" --publish "$HOST_PORT:5432" postgres',
      ].join('\n'),
    )

    const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' })

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /check\.yml:5: fixed host-port publishing/)
    assert.match(result.stderr, /check\.yml:6: fixed host-port publishing/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI exits nonzero when .github/workflows is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-safety-no-workflows-'))

  try {
    const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' })

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /No workflow files found/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('smoke container name includes all fork build matrix dimensions', async () => {
  const workflow = await readFile(new URL('../workflows/fork-build.yml', import.meta.url), 'utf8')
  const arm64Start = workflow.indexOf('  build-arm64:\n')
  const nextJob = workflow.indexOf('\n  check-snapshot-profile-diagnostic:', arm64Start)
  assert.notEqual(arm64Start, -1)
  assert.notEqual(nextJob, -1)
  assert.doesNotMatch(
    workflow.slice(arm64Start, nextJob),
    /Smoke-test packaged Linux x64 binary on the production base image/,
  )

  assert.deepEqual(
    findDockerSafetyViolations(workflow, '.github/workflows/fork-build.yml').map(
      ({ message }) => message,
    ),
    [],
  )
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
  const name = '--name "rari-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"'
  const workflow = `docker run ${name} -p 5432 postgres\nserver --port 43819`
  const hostlessPublishes = [
    `docker run ${name} -p 5432-5434/udp postgres`,
    `docker run ${name} -p 127.0.0.1::5432 postgres`,
    `docker run ${name} -p [::1]::5432 postgres`,
  ]
  const compose = 'services:\n  db:\n    ports:\n      - "5432"'

  assert.deepEqual(findDockerSafetyViolations(workflow), [])
  for (const command of hostlessPublishes) {
    assert.deepEqual(findDockerSafetyViolations(command), [])
  }
  assert.deepEqual(findDockerSafetyViolations(compose), [])
})
