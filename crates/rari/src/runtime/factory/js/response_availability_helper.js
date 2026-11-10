if (!globalThis['~rari'])
  globalThis['~rari'] = {}

const responseAvailabilityContext = globalThis['~rari'].responseAvailabilityContext
  ??= new Deno.core.AsyncVariable()

globalThis['~rari'].withResponseAvailabilityContext = async (requestId, operation) => {
  const previousContext = responseAvailabilityContext.enter(requestId)
  try {
    return await operation()
  }
  finally {
    Deno.core.setAsyncContext(previousContext)
  }
}

Object.defineProperty(globalThis, 'markResponseUnavailable', {
  configurable: false,
  enumerable: false,
  writable: false,
  value(retryAfterSeconds = 60) {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0) {
      throw new TypeError('retry-after must be a non-negative integer')
    }

    const requestId = responseAvailabilityContext.get()
    Deno.core.ops.op_mark_response_unavailable(String(retryAfterSeconds), requestId ?? '')
  },
})
