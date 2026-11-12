import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import '../../../crates/rari/src/runtime/factory/js/response_availability_helper.js'

const markResponseUnavailable = Reflect.get(
  globalThis,
  'markResponseUnavailable',
) as (retryAfterSeconds?: number) => void

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('markResponseUnavailable', () => {
  it('rejects a mark when no current request id is available', () => {
    const op = vi.fn()
    vi.stubGlobal('Deno', { core: { ops: { op_mark_response_unavailable: op } } })
    vi.stubGlobal('~rari', { currentRequestId: () => '' })

    expect(() => markResponseUnavailable()).toThrow(
      'markResponseUnavailable can only be called during a server render',
    )
    expect(op).not.toHaveBeenCalled()
  })
})
