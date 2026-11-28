import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const arm64ArtifactUploadStep = stepBlock(
  'build-arm64',
  'Upload Linux assets for the trusted publisher',
)
const cleanupValidationJob = jobBlock('validate-cleanup-ref')
const diagnosticJob = jobBlock('check-snapshot-profile-diagnostic')
const deleteJob = jobBlock('delete-test-release')
const buildJob = jobBlock('build')
const arm64BuildJob = jobBlock('build-arm64')
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
  assert.match(publishJob, /^    needs: \[build, build-arm64, validate-release-request\]$/m)
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

test('cross-compiles ARM64 on rari and serializes it after x64', () => {
  assert.match(buildJob, /runs-on: rari/)
  assert.match(buildJob, /- arch: x64/)
  assert.doesNotMatch(buildJob, /arch: arm64/)
  const runnerLabels = [...workflow.matchAll(/^\s*runs-on:\s*(.*)$/gm)].map(match => match[1])
  assert.ok(runnerLabels.length > 0, 'Workflow must declare its runner labels')
  assert.ok(
    runnerLabels.every(label => label === 'rari'),
    `Every workflow job must use the rari runner: ${runnerLabels.join(', ')}`,
  )

  assert.match(arm64BuildJob, /runs-on: rari/)
  assert.match(arm64BuildJob, /needs: build/)
  assert.match(arm64BuildJob, /- arch: arm64/)
  assert.doesNotMatch(arm64BuildJob, /arch: x64/)
  assert.match(publishJob, /needs: \[build, build-arm64, validate-release-request\]/)

  const snapshotGeneratorBuild = stepBlock('build-arm64', 'Build ARM64 V8 snapshot generator')
  assert.match(
    snapshotGeneratorBuild,
    /cargo build --release --target aarch64-unknown-linux-gnu --manifest-path tools\/snapshot\/Cargo\.toml/,
  )
  assert.match(
    snapshotGeneratorBuild,
    /RUSTFLAGS="-C link-arg=-Wl,-rpath-link,\$ARM64_SYSROOT\/usr\/lib\/aarch64-linux-gnu -Cforce-frame-pointers=yes"/,
  )
  const snapshotGeneration = stepBlock('build-arm64', 'Generate ARM64 V8 snapshot under QEMU')
  assert.match(
    snapshotGeneration,
    /qemu-aarch64 -L "\$ARM64_SYSROOT" target\/aarch64-unknown-linux-gnu\/release\/rari-snapshot crates\/rari\/snapshots/,
  )

  const arm64Sysroot = stepBlock('build-arm64', 'Prepare ARM64 sysroot')
  assert.match(arm64Sysroot, /docker create --platform linux\/arm64 node:24-trixie-slim/)
  assert.match(arm64Sysroot, /APT::Architecture=arm64/)
  assert.match(arm64Sysroot, /Dir::State::status=\$sysroot\/var\/lib\/dpkg\/status/)
  assert.match(
    arm64Sysroot,
    /--download-only --yes install \\\n\s+libfontconfig1-dev:arm64 libgcc-s1:arm64 libstdc\+\+6:arm64/,
  )
  assert.match(
    arm64Sysroot,
    /bash \.github\/scripts\/prepare-arm64-sysroot\.sh "\$sysroot" "\$apt_dir"\/archives\/\*\.deb/,
  )
  assert.doesNotMatch(arm64Sysroot, /dpkg-deb --extract|package_name=/)
  assert.match(arm64Sysroot, /PKG_CONFIG_SYSROOT_DIR_aarch64_unknown_linux_gnu/)
  assert.match(arm64Sysroot, /PKG_CONFIG_LIBDIR_aarch64_unknown_linux_gnu/)
  assert.match(arm64Sysroot, /libfontconfig\.so\.1 libgcc_s\.so\.1 libstdc\+\+\.so\.6/)
  assert.match(arm64Sysroot, /\$sysroot\/lib\/aarch64-linux-gnu\/\$library/)
  assert.match(arm64Sysroot, /\$sysroot\/usr\/lib\/aarch64-linux-gnu\/\$library/)
  assert.doesNotMatch(arm64Sysroot, /dpkg --add-architecture|dpkg --install|dpkg -i/)
  const fontconfigLinkCheck = stepBlock('build-arm64', 'Check ARM64 fontconfig cross-link')
  assert.match(fontconfigLinkCheck, /PKG_CONFIG_SYSROOT_DIR="\$ARM64_SYSROOT"/)
  assert.match(fontconfigLinkCheck, /pkg-config --cflags fontconfig/)
  assert.match(fontconfigLinkCheck, /pkg-config --libs fontconfig/)
  assert.match(
    fontconfigLinkCheck,
    /fontconfig_cflags_text="\$\(pkg-config --cflags fontconfig\)"\s+read -r -a fontconfig_cflags <<< "\$fontconfig_cflags_text"/,
  )
  assert.match(
    fontconfigLinkCheck,
    /fontconfig_libs_text="\$\(pkg-config --libs fontconfig\)"\s+read -r -a fontconfig_libs <<< "\$fontconfig_libs_text"/,
  )
  assert.match(fontconfigLinkCheck, /aarch64-linux-gnu-gcc/)
  assert.match(fontconfigLinkCheck, /FcInit\(\)/)
  assert.match(fontconfigLinkCheck, /-Wl,-rpath-link,\$ARM64_SYSROOT\/usr\/lib\/aarch64-linux-gnu/)
  assert.ok(
    arm64BuildJob.indexOf('      - name: Prepare ARM64 sysroot') <
      arm64BuildJob.indexOf('      - name: Generate ARM64 V8 snapshot under QEMU'),
    'ARM64 sysroot must be prepared before the snapshot generator runs under QEMU',
  )
  assert.ok(
    arm64BuildJob.indexOf(arm64Sysroot) < arm64BuildJob.indexOf(fontconfigLinkCheck) &&
      arm64BuildJob.indexOf(fontconfigLinkCheck) < arm64BuildJob.indexOf(snapshotGeneratorBuild),
    'Fontconfig must cross-link after sysroot setup and before the ARM64 Cargo builds',
  )

  const arm64BinaryBuild = stepBlock('build-arm64', 'Build Linux ARM64 binary')
  assert.match(
    arm64BinaryBuild,
    /cargo build --release --target aarch64-unknown-linux-gnu --bin rari --features ext-full,jemalloc/,
  )
  assert.match(
    arm64BinaryBuild,
    /RUSTFLAGS="-C link-arg=-Wl,-rpath-link,\$ARM64_SYSROOT\/usr\/lib\/aarch64-linux-gnu -Cforce-frame-pointers=yes"/,
  )
  const arm64SmokeTest = stepBlock(
    'build-arm64',
    'Smoke-test packaged Linux ARM64 binary in production rootfs under QEMU',
  )
  assert.match(arm64SmokeTest, /qemu-aarch64 --version/)
  assert.match(arm64SmokeTest, /tar -xzf "\$tarball"/)
  assert.match(arm64SmokeTest, /rari-linux-arm64-\$\{VERSION\}\.tgz/)
  assert.match(arm64SmokeTest, /rootfs="\$ARM64_SYSROOT"/)
  assert.match(arm64SmokeTest, /qemu-aarch64 -L "\$rootfs" "\$binary" --version/)
  assert.match(arm64SmokeTest, /qemu-aarch64 -L "\$rootfs" "\$binary" \\\n\s+--mode production/)
  assert.match(arm64SmokeTest, /curl --fail --silent --show-error http:\/\/127\.0\.0\.1:43819/)
  assert.match(arm64SmokeTest, /--mode production --host 127\.0\.0\.1 --port 43819/)
  assert.match(arm64SmokeTest, /grep -Fq "Test App Home"/)
  assert.doesNotMatch(
    arm64SmokeTest,
    /docker create|docker export|apt-get|qemu-aarch64-static|qemu-aarch64 -L \/|\/bin\/sh/,
  )
  assert.match(arm64Sysroot, /echo "\$library missing from ARM64 sysroot"/)
  assert.doesNotMatch(
    arm64BuildJob,
    /qemu-aarch64-static|docker start|docker exec/,
    'The ARM64 smoke check must not run an emulated shell inside an ARM64 container',
  )
  const arm64Package = stepBlock('build-arm64', 'Prepare and package Linux release assets')
  assert.ok(
    arm64BuildJob.indexOf(arm64Package) < arm64BuildJob.indexOf(arm64SmokeTest),
    'ARM64 QEMU smoke test must use the packaged binary',
  )
  assert.ok(
    arm64BuildJob.indexOf(arm64SmokeTest) <
      arm64BuildJob.indexOf('      - name: Upload Linux assets for the trusted publisher'),
    'ARM64 QEMU smoke test must pass before artifact upload',
  )
  assert.doesNotMatch(arm64BuildJob, /update-binfmts|binfmt_misc/)
  const crossDependencies = stepBlock('build-arm64', 'Install Linux build dependencies')
  assert.match(crossDependencies, /apt-get install --no-install-recommends/)
  assert.match(crossDependencies, /qemu-user/)
  assert.doesNotMatch(crossDependencies, /dpkg --add-architecture|libfontconfig1-dev:arm64/)
  assert.doesNotMatch(crossDependencies, /qemu-user-binfmt|update-binfmts|binfmt_misc/)
  assert.doesNotMatch(arm64BuildJob, /dpkg --add-architecture arm64/)

  assert.match(arm64Package, /binary=target\/aarch64-unknown-linux-gnu\/release\/rari/)
  assert.match(arm64Package, /objcopy=aarch64-linux-gnu-objcopy/)
  assert.match(arm64Package, /file_description="\$\(file -b "\$release_binary"\)"/)
  assert.match(arm64Package, /check-arm64-elf\.sh "\$file_description"/)
  assert.match(arm64Package, /readelf=aarch64-linux-gnu-readelf/)
  assert.match(arm64Package, /check-glibc-version\.sh "\$release_binary" "\$readelf"/)
  assert.ok(
    arm64BuildJob.indexOf(arm64Package) <
      arm64BuildJob.indexOf('      - name: Upload Linux assets for the trusted publisher'),
    'ARM64 architecture and glibc checks must run before artifact upload',
  )

  const x64Package = stepBlock('build', 'Prepare and package Linux release assets')
  assert.match(x64Package, /binary=target\/x86_64-unknown-linux-gnu\/release\/rari/)
  assert.match(x64Package, /readelf=readelf/)
  assert.match(x64Package, /check-glibc-version\.sh "\$release_binary" "\$readelf"/)
  assert.doesNotMatch(buildJob, /getconf GNU_LIBC_VERSION/)
  assert.doesNotMatch(arm64BuildJob, /getconf GNU_LIBC_VERSION/)
})

test('prepares the ARM64 sysroot without host libc development files', async t => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'rari-arm64-sysroot-'))
  t.after(() => rm(tempDirectory, { recursive: true, force: true }))

  const binDirectory = join(tempDirectory, 'bin')
  const packageDirectory = join(tempDirectory, 'packages')
  const sysroot = join(tempDirectory, 'sysroot')
  const fakeDpkgDeb = join(binDirectory, 'dpkg-deb')
  const prepareScript = new URL('./prepare-arm64-sysroot.sh', import.meta.url)
  await mkdir(binDirectory)
  await mkdir(packageDirectory)
  await writeFile(
    fakeDpkgDeb,
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  -f)
    package_name="${'${2##*/}'}"
    printf '%s\\n' "${'${package_name%.deb}'}"
    ;;
  --extract)
    package_name="${'${2##*/}'}"
    package_name="${'${package_name%.deb}'}"
    destination="$3"
    if [[ "$package_name" == bad-libc ]]; then
      mkdir -p "$destination/usr/lib/aarch64-linux-gnu"
      touch "$destination/usr/lib/aarch64-linux-gnu/libc.so"
    else
      mkdir -p "$destination/usr/share/package-fixtures"
      touch "$destination/usr/share/package-fixtures/$package_name"
    fi
    ;;
  *)
    exit 2
    ;;
esac
`,
  )
  await chmod(fakeDpkgDeb, 0o755)

  const libc6DevPackage = join(packageDirectory, 'libc6-dev.deb')
  const gccPackage = join(packageDirectory, 'libgcc-s1.deb')
  const badLibcPackage = join(packageDirectory, 'bad-libc.deb')
  await Promise.all([libc6DevPackage, gccPackage, badLibcPackage].map(path => writeFile(path, '')))

  const runPrepare = (...packages) =>
    spawnSync('bash', [prepareScript.pathname, sysroot, ...packages], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` },
    })

  const successfulPreparation = runPrepare(libc6DevPackage, gccPackage)
  assert.equal(successfulPreparation.status, 0, successfulPreparation.stderr)
  await access(join(sysroot, 'usr/share/package-fixtures/libgcc-s1'))
  await assert.rejects(access(join(sysroot, 'usr/share/package-fixtures/libc6-dev')))

  const invalidSysroot = join(tempDirectory, 'invalid-sysroot')
  const invalidPreparation = spawnSync(
    'bash',
    [prepareScript.pathname, invalidSysroot, badLibcPackage],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` },
    },
  )
  assert.equal(invalidPreparation.status, 1)
  assert.match(invalidPreparation.stderr, /libc\.so must resolve from the cross compiler sysroot/)
})

test('checks the packaged binary GLIBC ceiling', async t => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'rari-glibc-check-'))
  t.after(() => rm(tempDirectory, { recursive: true, force: true }))

  const binary = join(tempDirectory, 'rari')
  const readelf = join(tempDirectory, 'readelf')
  const checker = new URL('./check-glibc-version.sh', import.meta.url)
  await writeFile(binary, 'binary fixture')

  const writeReadelfOutput = async (...versions) => {
    const lines = ['Version needs section', ...versions.map(version => `  Name: GLIBC_${version}`)]
    await writeFile(
      readelf,
      `#!/usr/bin/env bash\nprintf '%s\\n' ${lines.map(line => `'${line}'`).join(' ')}\n`,
    )
    await chmod(readelf, 0o755)
  }

  await writeReadelfOutput('2.39')
  const supported = spawnSync('bash', [checker.pathname, binary, readelf], { encoding: 'utf8' })
  assert.equal(supported.status, 0, supported.stderr)
  assert.match(supported.stdout, /Highest GLIBC requirement .*GLIBC_2\.39/)

  await writeReadelfOutput('2.39', '2.4')
  const numericOrdering = spawnSync('bash', [checker.pathname, binary, readelf], {
    encoding: 'utf8',
  })
  assert.equal(numericOrdering.status, 0, numericOrdering.stderr)
  assert.match(numericOrdering.stdout, /Highest GLIBC requirement .*GLIBC_2\.39/)

  await writeReadelfOutput('2.4')
  const olderNumericVersion = spawnSync('bash', [checker.pathname, binary, readelf], {
    encoding: 'utf8',
  })
  assert.equal(olderNumericVersion.status, 0, olderNumericVersion.stderr)
  assert.match(olderNumericVersion.stdout, /Highest GLIBC requirement .*GLIBC_2\.4/)

  await writeReadelfOutput('2.43')
  const unsupported = spawnSync('bash', [checker.pathname, binary, readelf], { encoding: 'utf8' })
  assert.equal(unsupported.status, 1)
  assert.match(unsupported.stderr, /GLIBC_2\.43 exceeds the supported maximum GLIBC_2\.39/)
})

test('checks the ARM64 ELF architecture description', () => {
  const checker = new URL('./check-arm64-elf.sh', import.meta.url)
  const arm64 = spawnSync(
    'bash',
    [checker.pathname, 'ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV)'],
    { encoding: 'utf8' },
  )
  assert.equal(arm64.status, 0, arm64.stderr)

  const x64 = spawnSync(
    'bash',
    [checker.pathname, 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV)'],
    { encoding: 'utf8' },
  )
  assert.equal(x64.status, 1)
  assert.match(x64.stderr, /Expected a 64-bit little-endian ARM aarch64 binary/)
})

test('routes operational fork-build jobs through rari without adding a concurrency group', () => {
  for (const name of [
    'build',
    'build-arm64',
    'check-snapshot-profile-diagnostic',
    'publish-release',
    'validate-cleanup-ref',
    'validate-release-request',
    'delete-test-release',
  ]) {
    assert.match(jobBlock(name), /runs-on: rari/, `${name} must use the rari runner`)
  }

  assert.doesNotMatch(workflow, /^\s*concurrency:/m)
})
