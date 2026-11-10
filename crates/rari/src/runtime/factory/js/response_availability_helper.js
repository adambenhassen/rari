Object.defineProperty(globalThis, 'markResponseUnavailable', {
  configurable: false,
  enumerable: false,
  writable: false,
  value(retryAfterSeconds = 60) {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0) {
      throw new TypeError('retry-after must be a non-negative integer')
    }

    Deno.core.ops.op_mark_response_unavailable(String(retryAfterSeconds))
  },
})
