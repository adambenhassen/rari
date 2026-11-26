import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../workflows/fork-pr-check.yml', import.meta.url), 'utf8')

test('jemalloc E2E server build runs with one Cargo job', () => {
  const buildStep = workflow.match(
    /      - name: Build jemalloc E2E server\n([\s\S]*?)(?=      - name:|\s*$)/,
  )

  assert.ok(buildStep, 'Missing jemalloc E2E server build step')
  assert.match(buildStep[1], /        env:\n          CARGO_BUILD_JOBS: '1'\n/)
})
