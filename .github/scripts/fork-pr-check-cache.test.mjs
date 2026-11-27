import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../workflows/fork-pr-check.yml', import.meta.url), 'utf8')

function stepBlock(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1, `Missing ${name} step`)

  const next = workflow.indexOf('      - name: ', start + 1)
  return workflow.slice(start, next === -1 ? undefined : next)
}

test('Cargo build cache key includes the Rust toolchain and lockfile', () => {
  const restoreStep = stepBlock('Restore Cargo build cache')
  const restoreIndex = workflow.indexOf('      - name: Restore Cargo build cache\n')
  const snapshotBuildIndex = workflow.indexOf(
    '      - name: Build snapshot generator with release profile\n',
  )
  const keyLine = restoreStep.split('\n').find(line => line.trimStart().startsWith('key:'))

  assert.ok(
    restoreIndex < snapshotBuildIndex,
    'Cargo cache must be restored before building the snapshot generator',
  )
  assert.match(restoreStep, /id: cargo-cache\n/)
  assert.ok(keyLine, 'Missing Cargo cache key')
  assert.match(keyLine, /cargo-release-v2-/)
  assert.match(keyLine, /runner\.os/)
  assert.match(keyLine, /env\.RUSTUP_TOOLCHAIN/)
  assert.match(keyLine, /hashFiles\('rust-toolchain\.toml'\)/)
  assert.match(keyLine, /hashFiles\('Cargo\.lock'\)/)
  assert.match(restoreStep, /~\/\.cargo\/registry/)
  assert.match(restoreStep, /~\/\.cargo\/git/)
  assert.match(restoreStep, /\n\s+target\/release\n/)
  assert.doesNotMatch(restoreStep, /\n\s+target\n/)
})

test('Cargo build cache is scoped to this pull request', () => {
  const restoreStep = stepBlock('Restore Cargo build cache')
  const keyLine = restoreStep.split('\n').find(line => line.trimStart().startsWith('key:'))

  assert.ok(keyLine, 'Missing Cargo cache key')
  assert.match(keyLine, /key: cargo-release-v2-pr-\$\{\{ github\.event\.pull_request\.number \}\}-/)
  assert.doesNotMatch(restoreStep, /restore-keys:/)
})

test('Cargo release cache is saved before release artifacts are cleaned', () => {
  const saveStep = stepBlock('Save Cargo build cache')
  const cleanStep = stepBlock('Clean release artifacts before Rust checks')
  const saveIndex = workflow.indexOf('      - name: Save Cargo build cache\n')
  const cleanIndex = workflow.indexOf('      - name: Clean release artifacts before Rust checks\n')
  const clippyIndex = workflow.indexOf('      - name: Run Rust clippy\n')
  const cleanClippyIndex = workflow.indexOf(
    '      - name: Clean Clippy artifacts before Rust tests\n',
  )
  const rustTestIndex = workflow.indexOf('      - name: Test Rust\n')
  const cleanupIndex = workflow.indexOf(
    '      - name: Free build space before installing Playwright\n',
  )

  assert.ok(
    saveIndex < cleanIndex,
    'Cargo cache must save before cargo clean removes release artifacts',
  )
  assert.ok(cleanIndex < clippyIndex, 'Release artifacts must be cleaned before Rust checks')
  assert.ok(cleanIndex < rustTestIndex, 'Release artifacts must be cleaned before Rust tests')
  assert.ok(
    clippyIndex < cleanClippyIndex && cleanClippyIndex < rustTestIndex,
    'Clippy artifacts must be cleaned before Rust tests compile their debug targets',
  )
  assert.ok(saveIndex < cleanupIndex, 'Cargo cache must save before cargo clean removes target')
  assert.match(saveStep, /actions\/cache\/save@[0-9a-f]{40} # v5\.1\.0/)
  assert.match(saveStep, /steps\.cargo-cache\.outputs\.cache-hit != 'true'/)
  assert.match(saveStep, /steps\.cargo-cache\.outputs\.cache-primary-key/)
  assert.match(saveStep, /\n\s+target\/release\n/)
  assert.doesNotMatch(saveStep, /\n\s+target\n/)
  assert.match(cleanStep, /cargo clean --release/)
  assert.match(stepBlock('Clean Clippy artifacts before Rust tests'), /run: cargo clean\n/)
})
