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
  const keyLine = restoreStep.split('\n').find(line => line.trimStart().startsWith('key:'))

  assert.match(restoreStep, /id: cargo-cache\n/)
  assert.ok(keyLine, 'Missing Cargo cache key')
  assert.match(keyLine, /cargo-/)
  assert.match(keyLine, /runner\.os/)
  assert.match(keyLine, /env\.RUSTUP_TOOLCHAIN/)
  assert.match(keyLine, /hashFiles\('rust-toolchain\.toml'\)/)
  assert.match(keyLine, /hashFiles\('Cargo\.lock'\)/)
  assert.match(restoreStep, /~\/\.cargo\/registry/)
  assert.match(restoreStep, /~\/\.cargo\/git/)
  assert.match(restoreStep, /\n\s+target\n/)
})

test('Cargo cache is saved before the E2E disk cleanup', () => {
  const saveStep = stepBlock('Save Cargo build cache')
  const saveIndex = workflow.indexOf('      - name: Save Cargo build cache\n')
  const cleanupIndex = workflow.indexOf(
    '      - name: Free build space before installing Playwright\n',
  )

  assert.ok(saveIndex < cleanupIndex, 'Cargo cache must save before cargo clean removes target')
  assert.match(saveStep, /actions\/cache\/save@[0-9a-f]{40} # v5\.1\.0/)
  assert.match(saveStep, /steps\.cargo-cache\.outputs\.cache-hit != 'true'/)
  assert.match(saveStep, /steps\.cargo-cache\.outputs\.cache-primary-key/)
})
