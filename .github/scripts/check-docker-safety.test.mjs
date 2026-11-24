import assert from 'node:assert/strict'
import test from 'node:test'
import { findDockerSafetyViolations } from './check-docker-safety.mjs'

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
    findDockerSafetyViolations(compose).map(({ message }) => message),
    ['fixed host-port publishing'],
  )
})

test('rejects global Docker cleanup but permits a task-label filtered prune', () => {
  assert.deepEqual(
    findDockerSafetyViolations(['docker', 'system', 'prune', '-af'].join(' ')).map(
      ({ message }) => message,
    ),
    ['unfiltered Docker prune'],
  )
  assert.deepEqual(
    findDockerSafetyViolations(
      ['docker', 'network', 'prune', '--filter', 'label=ci.task=$GITHUB_RUN_ID'].join(' '),
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

test('ignores dynamic ports and ports opened inside a container', () => {
  const workflow = 'docker run -p 5432 postgres\nserver --port 43819'
  const compose = 'services:\n  db:\n    ports:\n      - "5432"'

  assert.deepEqual(findDockerSafetyViolations(workflow), [])
  assert.deepEqual(findDockerSafetyViolations(compose), [])
})
