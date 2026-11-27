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
const diagnosticJob = jobBlock('check-snapshot-profile-diagnostic')
const deleteJob = jobBlock('delete-test-release')
const buildJob = jobBlock('build')
const publishJob = jobBlock('publish-release')
const releaseValidationJob = workflow.includes('  validate-release-request:\n')
  ? jobBlock('validate-release-request')
  : ''
const cleanupValidationCondition = cleanupValidationJob.match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
const diagnosticCondition = diagnosticJob.match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
const deleteCondition = deleteJob.match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
const releaseValidationCondition = releaseValidationJob.match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
const publishCondition = publishJob.match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
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

test('cleanup-only dispatch skips both architecture builds and publishing', () => {
  assert.ok(releaseValidationCondition, 'Missing non-matrix release validation condition')
  assert.doesNotMatch(releaseValidationJob, /^    strategy:/m, 'Release validation must not be matrixed')
  assert.match(buildJob, /^    needs: validate-release-request$/m)
  assert.doesNotMatch(buildJob, /^    if:/m, 'Matrix build jobs must inherit a skipped validation dependency')
  assert.match(publishJob, /^    needs: \[build, validate-release-request\]$/m)
  assert.ok(publishCondition, 'Missing publisher condition')
  assert.ok(diagnosticCondition, 'Missing diagnostic job condition')

  const arches = [...buildJob.matchAll(/^          - arch: (x64|arm64)$/gm)].map((match) => match[1])
  assert.deepEqual(arches, ['x64', 'arm64'])

  for (const deleteTestRelease of [true, 'true']) {
    const context = {
      github: { ref: 'refs/heads/fork/main' },
      inputs: { delete_test_release: deleteTestRelease, diagnose_snapshot_profiles: false },
    }
    assert.equal(runInNewContext(cleanupValidationCondition, context), true)
    assert.equal(runInNewContext(deleteCondition, context), true)
    assert.equal(runInNewContext(diagnosticCondition, context), false)
    const validationRuns = runInNewContext(releaseValidationCondition, context)
    assert.equal(validationRuns, false)

    const validationResult = validationRuns ? 'success' : 'skipped'
    const buildStatuses = arches.map(() => (validationResult === 'success' ? 'queued' : 'skipped'))
    assert.deepEqual(buildStatuses, ['skipped', 'skipped'])
    assert.equal(runInNewContext(publishCondition, context), false)
  }
})

test('normal dispatch validates once, builds both architectures, and permits publishing', () => {
  assert.ok(releaseValidationCondition, 'Missing non-matrix release validation condition')
  assert.match(buildJob, /^    needs: validate-release-request$/m)
  assert.ok(publishCondition, 'Missing publisher condition')

  const context = {
    github: { ref: 'refs/heads/fork/main' },
    inputs: { delete_test_release: false, diagnose_snapshot_profiles: false },
  }
  assert.equal(runInNewContext(releaseValidationCondition, context), true)
  assert.equal(runInNewContext(cleanupValidationCondition, context), false)
  assert.equal(runInNewContext(deleteCondition, context), false)
  assert.equal(runInNewContext(diagnosticCondition, context), false)
  assert.equal(runInNewContext(publishCondition, context), true)
  assert.deepEqual(
    [...buildJob.matchAll(/^          - arch: (x64|arm64)$/gm)].map((match) => match[1]),
    ['x64', 'arm64'],
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
