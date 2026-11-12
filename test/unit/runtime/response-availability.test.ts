import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import '../../../crates/rari/src/runtime/factory/js/response_availability_helper.js'

const markResponseUnavailable: (retryAfterSeconds?: number) => void = Reflect.get(
  globalThis,
  'markResponseUnavailable',
)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('markResponseUnavailable', () => {
  it('passes an empty request id to the runtime context resolver', () => {
    const op = vi.fn()
    vi.stubGlobal('Deno', { core: { ops: { op_mark_response_unavailable: op } } })
    vi.stubGlobal('~rari', { currentRequestId: () => '' })

    markResponseUnavailable()

    expect(op).toHaveBeenCalledWith('60', '')
  })

  it('rejects a mark when the runtime op is unavailable', () => {
    vi.stubGlobal('Deno', { core: { ops: { op_mark_response_unavailable: undefined } } })
    vi.stubGlobal('~rari', { currentRequestId: () => 'request-id' })
    const mark = () => {
      markResponseUnavailable()
    }

    expect(mark).toThrow(TypeError)
    expect(mark).toThrow('markResponseUnavailable can only be called during a server render')
  })
})
