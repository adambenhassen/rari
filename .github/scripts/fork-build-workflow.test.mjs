import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const workflow = await readFile(new URL('../workflows/fork-build.yml', import.meta.url), 'utf8')

function jobBlock(name) {
  const start = workflow.indexOf(`  ${name}:\n`)
  assert.notEqual(start, -1, `Missing ${name} job`)
  const bodyStart = start + `  ${name}:\n`.length
  const remainder = workflow.slice(bodyStart)
  const nextJob = remainder.search(/^  [a-z][\w-]*:\s*$/m)
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob)
}

const cleanupValidationJob = jobBlock('validate-cleanup-ref')
const deleteJob = jobBlock('delete-test-release')
const buildJob = jobBlock('build')
const cleanupValidationCondition = cleanupValidationJob.match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
const deleteCondition = deleteJob.match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
assert.ok(cleanupValidationCondition, 'Missing cleanup validation job condition')
assert.ok(deleteCondition, 'Missing delete job condition')
const validationStep = cleanupValidationJob.match(
  /      - name: Validate cleanup ref\n([\s\S]*?)(?=      - name:|$)/,
)
assert.ok(validationStep, 'Missing cleanup request validation step')
const validationRun = validationStep[1].match(/        run: \|\n((?:^ {10,}.*(?:\r?\n|$))+)/m)
assert.ok(validationRun, 'Missing cleanup request validation script')
const validationScript = validationRun[1]
  .split(/\r?\n/)
  .map(line => line.replace(/^ {10}/, ''))
  .join('\n')

test('combined cleanup and diagnostic inputs fail validation and skip deletion', () => {
  assert.match(validationScript, /DIAGNOSE_SNAPSHOT_PROFILES.*== "true"/)

  for (const deleteTestRelease of [true, 'true']) {
    for (const diagnoseSnapshotProfiles of [true, 'true']) {
      const context = {
        github: { ref: 'refs/heads/fork/main' },
        inputs: {
          delete_test_release: deleteTestRelease,
          diagnose_snapshot_profiles: diagnoseSnapshotProfiles,
        },
      }
      assert.equal(runInNewContext(cleanupValidationCondition, context), true)
      assert.equal(runInNewContext(deleteCondition, context), false)
    }
  }

  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', validationScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BUILD_REF: 'refs/heads/fork/main',
      DIAGNOSE_SNAPSHOT_PROFILES: 'true',
    },
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Cannot combine delete_test_release with diagnose_snapshot_profiles/)
  assert.match(deleteJob, /needs: validate-cleanup-ref/)
})

test('pins only the x64 release build to Ubuntu 24.04 with the glibc ceiling', () => {
  assert.match(buildJob, /runs-on: \$\{\{ matrix\.runner \}\}/)
  assert.match(buildJob, /- arch: x64\s+runner: ubuntu-24\.04/)
  assert.match(buildJob, /- arch: arm64\s+runner: arm64/)

  const glibcCheck = buildJob.match(
    /      - name: Require glibc no newer than 2\.39\n([\s\S]*?)(?=      - name:|$)/,
  )
  assert.ok(glibcCheck, 'Missing x64 glibc ceiling check')
  assert.match(glibcCheck[1], /if: matrix\.arch == 'x64'/)
  assert.match(glibcCheck[1], /getconf GNU_LIBC_VERSION/)
})
