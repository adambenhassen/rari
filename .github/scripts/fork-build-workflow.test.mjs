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

function stepBlock(jobName, stepName) {
  const job = jobBlock(jobName)
  const marker = `      - name: ${stepName}\n`
  const start = job.indexOf(marker)
  assert.notEqual(start, -1, `Missing ${stepName} step in ${jobName} job`)
  const bodyStart = start + marker.length
  const remainder = job.slice(bodyStart)
  const nextStep = remainder.search(/^      - name:/m)
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep)
}

const artifactUploadStep = stepBlock('build', 'Upload Linux assets for the trusted publisher')
const cleanupValidationJob = jobBlock('validate-cleanup-ref')
const deleteJob = jobBlock('delete-test-release')
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

test('Linux build artifacts retain enough time for the publisher handoff', () => {
  const retentionDays = artifactUploadStep.match(/^\s+retention-days:\s*(\d+)\s*$/m)
  assert.ok(retentionDays, 'Linux build artifact upload must set retention-days explicitly')
  assert.ok(
    Number(retentionDays[1]) >= 2,
    `Linux build artifacts need at least two retention days, got ${retentionDays[1]}`,
  )
})

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
