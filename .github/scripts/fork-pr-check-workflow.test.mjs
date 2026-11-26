import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../workflows/fork-pr-check.yml', import.meta.url), 'utf8')

test('uses hash-addressed APT indexes with retries before package installation', () => {
  const aptConfigStep = workflow.match(
    /      - name: Configure APT index fetches\n([\s\S]*?)(?=      - name:|$)/,
  )
  assert.ok(aptConfigStep, 'Missing APT index configuration step')
  assert.match(aptConfigStep[1], /Acquire::By-Hash "force";/)
  assert.match(aptConfigStep[1], /Acquire::Retries "3";/)

  const aptConfigPosition = workflow.indexOf(aptConfigStep[0])
  const aptUpdatePosition = workflow.indexOf('sudo apt-get update')
  const playwrightInstallPosition = workflow.indexOf('pnpm exec playwright install chromium --with-deps')
  assert.ok(aptUpdatePosition !== -1, 'Missing APT update')
  assert.ok(playwrightInstallPosition !== -1, 'Missing Playwright dependency installation')
  assert.ok(aptConfigPosition < aptUpdatePosition, 'APT configuration must precede apt-get update')
  assert.ok(aptConfigPosition < playwrightInstallPosition, 'APT configuration must precede Playwright dependencies')
})
