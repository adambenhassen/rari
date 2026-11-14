import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { getRariLogPath } from './helpers'

export async function waitForCacheWarmup() {
  await expect
    .poll(
      async () => {
        try {
          return (await readFile(getRariLogPath(), 'utf8')).includes('Cache warmup: Completed')
        } catch {
          return false
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true)
}
