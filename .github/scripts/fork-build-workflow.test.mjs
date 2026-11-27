import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const workflow = await readFile(new URL('../workflows/fork-build.yml', import.meta.url), 'utf8')
const glibcCheckScript = fileURLToPath(new URL('./check-glibc-version.sh', import.meta.url))

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
const arm64ArtifactUploadStep = stepBlock(
  'build-arm64',
  'Upload Linux assets for the trusted publisher',
)
const cleanupValidationJob = jobBlock('validate-cleanup-ref')
const diagnosticJob = jobBlock('check-snapshot-profile-diagnostic')
const deleteJob = jobBlock('delete-test-release')
const buildJob = jobBlock('build')
const arm64BuildJob = jobBlock('build-arm64')
const arm64SmokeJob = jobBlock('smoke-arm64')
const publishJob = jobBlock('publish-release')
const packageStep = stepBlock('build', 'Prepare and package Linux release assets')
const arm64PackageStep = stepBlock('build-arm64', 'Prepare and package Linux release assets')
const x64SmokeStep = stepBlock('build', 'Smoke-test packaged Linux x64 binary on the production base image')
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

  const arm64RetentionDays = arm64ArtifactUploadStep.match(/^\s+retention-days:\s*(\d+)\s*$/m)
  assert.ok(arm64RetentionDays, 'ARM64 build artifact upload must set retention-days explicitly')
  assert.ok(
    Number(arm64RetentionDays[1]) >= 2,
    `ARM64 build artifacts need at least two retention days, got ${arm64RetentionDays[1]}`,
  )
})

test('cleanup-only dispatch skips both architecture builds and publishing', () => {
  assert.ok(releaseValidationCondition, 'Missing non-matrix release validation condition')
  assert.doesNotMatch(
    releaseValidationJob,
    /^    strategy:/m,
    'Release validation must not be matrixed',
  )
  assert.match(buildJob, /^    needs: validate-release-request$/m)
  assert.match(arm64BuildJob, /^    needs: build$/m)
  assert.doesNotMatch(
    buildJob,
    /^    if:/m,
    'Matrix build jobs must inherit a skipped validation dependency',
  )
  assert.match(
    publishJob,
    /^    needs: \[build, build-arm64, smoke-arm64, validate-release-request\]$/m,
  )
  assert.ok(publishCondition, 'Missing publisher condition')
  assert.ok(diagnosticCondition, 'Missing diagnostic job condition')

  const arches = [
    ...buildJob.matchAll(/^          - arch: (x64|arm64)$/gm),
    ...arm64BuildJob.matchAll(/^          - arch: (x64|arm64)$/gm),
  ].map(match => match[1])
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
  assert.match(arm64BuildJob, /^    needs: build$/m)
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
    [
      ...buildJob.matchAll(/^          - arch: (x64|arm64)$/gm),
      ...arm64BuildJob.matchAll(/^          - arch: (x64|arm64)$/gm),
    ].map(match => match[1]),
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

test('checks packaged Linux binaries and cross-compiles ARM64 on rari', () => {
  assert.match(buildJob, /runs-on: rari/)
  assert.match(buildJob, /- arch: x64/)
  assert.doesNotMatch(buildJob, /arch: arm64/)
  assert.match(arm64BuildJob, /runs-on: rari/)
  assert.match(arm64BuildJob, /needs: build/)
  assert.match(arm64BuildJob, /- arch: arm64/)
  assert.doesNotMatch(arm64BuildJob, /arch: x64/)
  assert.match(arm64BuildJob, /--target aarch64-unknown-linux-gnu/)
  assert.match(arm64BuildJob, /CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER/)
  assert.match(arm64BuildJob, /qemu-aarch64-static -L \//)
  assert.match(arm64BuildJob, /qemu-user-static/)
  assert.match(packageStep, /check-glibc-version\.sh/)
  assert.match(arm64PackageStep, /check-glibc-version\.sh/)
  assert.match(arm64PackageStep, /aarch64-linux-gnu-readelf/)
  assert.match(x64SmokeStep, /cat \/tmp\/rari-x64-smoke\.log/)
  assert.match(arm64SmokeJob, /needs: build-arm64/)
  assert.match(arm64SmokeJob, /node:24-trixie-slim/)
  assert.match(arm64SmokeJob, /docker create --platform linux\/arm64/)
  assert.match(arm64SmokeJob, /cat \/tmp\/rari-arm64-smoke\.log/)
  assert.match(publishJob, /needs: \[build, build-arm64, smoke-arm64, validate-release-request\]/)
})

test('routes operational fork-build jobs through rari without adding a concurrency group', () => {
  for (const name of [
    'build',
    'build-arm64',
    'smoke-arm64',
    'check-snapshot-profile-diagnostic',
    'publish-release',
    'validate-cleanup-ref',
    'validate-release-request',
    'delete-test-release',
  ]) {
    assert.match(jobBlock(name), /runs-on: rari/, `${name} must use the rari runner`)
  }

  assert.deepEqual(
    [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]),
    ['GITEA_TOKEN', 'GITEA_TOKEN'],
  )
  assert.doesNotMatch(workflow, /inference-x64/)
  assert.doesNotMatch(workflow, /foxtrot|runs-on: arm64/)
  assert.doesNotMatch(workflow, /^\s*concurrency:/m)
})

test('the GLIBC checker reports the highest requirement and rejects versions above 2.39', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rari-glibc-check-'))
  const binary = join(directory, 'rari')
  const readelfStub = join(directory, 'readelf')

  try {
    await writeFile(binary, '')
    await writeFile(readelfStub, '#!/bin/sh\nprintf "%s\\n" "$GLIBC_TEST_OUTPUT"\n')
    await chmod(readelfStub, 0o755)

    const check = versionInfo =>
      spawnSync('bash', [glibcCheckScript, binary, readelfStub], {
        encoding: 'utf8',
        env: { ...process.env, GLIBC_TEST_OUTPUT: versionInfo },
      })

    const supported = check(
      'Name: GLIBC_2.17 Flags: none Version: 3\nName: GLIBC_2.39 Flags: none Version: 4',
    )
    assert.equal(supported.status, 0)
    assert.match(supported.stdout, /Highest GLIBC requirement .* GLIBC_2\.39/)

    const unsupported = check('Name: GLIBC_2.43 Flags: none Version: 5')
    assert.equal(unsupported.status, 1)
    assert.match(unsupported.stderr, /GLIBC_2\.43 exceeds the supported maximum GLIBC_2\.39/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
