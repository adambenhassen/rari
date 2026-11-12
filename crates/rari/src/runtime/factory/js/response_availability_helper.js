/// <reference path="../../ext/rari/core/types.d.ts" />

Object.defineProperty(globalThis, 'markResponseUnavailable', {
  configurable: false,
  enumerable: false,
  writable: false,
  value(retryAfterSeconds = 60) {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0) {
      throw new TypeError('retry-after must be a non-negative integer')
    }

    /** @type {unknown} */
    const maybeRari = Reflect.get(globalThis, '~rari')
    const rari = hasCurrentRequestId(maybeRari) ? maybeRari : undefined
    const requestId = rari?.currentRequestId()
    if (requestId === undefined || requestId.length === 0) {
      throw new Error('markResponseUnavailable can only be called during a server render')
    }

    globalThis.Deno.core.ops.op_mark_response_unavailable(String(retryAfterSeconds), requestId)
  },
})

/**
 * @param {unknown} value
 * @returns {value is { currentRequestId: () => string }}
 */
function hasCurrentRequestId(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'currentRequestId' in value &&
    typeof value.currentRequestId === 'function'
  )
}
