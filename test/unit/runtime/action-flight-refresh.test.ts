import type { ActionFlightRefreshDetail } from '@rari/runtime/actions/flight-refresh'
import { scheduleActionFlightRefresh } from '@rari/runtime/actions/flight-refresh'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { castMock } from '../../helpers/mock-cast'

const refreshElement = createElement('div', null, 'refresh')

describe('action-flight-refresh', () => {
  beforeEach(() => {
    vi.stubGlobal('dispatchEvent', vi.fn())
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('skips refresh when the action result is a redirect', () => {
    const response = new Response('', {
      headers: {
        'x-action-revalidated': '2',
        'x-action-revalidated-path': '/actions',
      },
    })

    scheduleActionFlightRefresh(response, { f: refreshElement }, { redirect: '/elsewhere' })

    expect(globalThis.dispatchEvent).not.toHaveBeenCalled()
  })

  it('skips refresh when the action result opts out via ~rariSkipRefresh', () => {
    const response = new Response('', {
      headers: {
        'x-action-revalidated': '2',
        'x-action-revalidated-path': '/actions',
      },
    })

    scheduleActionFlightRefresh(
      response,
      { f: refreshElement },
      { 'success': true, '~rariSkipRefresh': true },
    )

    expect(globalThis.dispatchEvent).not.toHaveBeenCalled()
  })

  it('dispatches action flight refresh for unstructured action results', async () => {
    const response = new Response('', {
      headers: {
        'x-action-revalidated': '2',
        'x-action-revalidated-path': '/actions',
      },
    })

    scheduleActionFlightRefresh(response, { f: refreshElement }, undefined)

    await vi.waitFor(() => {
      expect(globalThis.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'rari:action-flight-refresh',
          detail: {
            element: refreshElement,
            revalidationKind: 2,
            revalidatedPath: '/actions',
          },
        }),
      )
    })
  })

  it('dispatches unresolved Flight thenables as refresh roots', async () => {
    const thenable: PromiseLike<unknown> = {
      // oxlint-disable-next-line unicorn/no-thenable fixture models a Flight thenable payload
      async then(onFulfilled) {
        return Promise.resolve(onFulfilled?.(refreshElement)).then(onFulfilled)
      },
    }
    const response = new Response('', {
      headers: {
        'x-action-revalidated': '2',
        'x-action-revalidated-path': '/actions',
      },
    })

    scheduleActionFlightRefresh(response, { f: thenable }, undefined)

    await vi.waitFor(() => {
      expect(globalThis.dispatchEvent).toHaveBeenCalled()
    })

    const event = vi.mocked(globalThis.dispatchEvent).mock.calls[0]?.[0]
    expect(event).toBeInstanceOf(CustomEvent)
    const refreshEvent = castMock<CustomEvent<ActionFlightRefreshDetail>>(event)
    expect(refreshEvent.type).toBe('rari:action-flight-refresh')
    expect(refreshEvent.detail.element).toBe(thenable)
    expect(refreshEvent.detail.revalidationKind).toBe(2)
  })

  it('dispatches a Promise subclass whose then does not return a chain', async () => {
    class FlightPromise extends Promise<unknown> {}
    const flight = new FlightPromise(resolve => {
      resolve(refreshElement)
    })
    // oxlint-disable-next-line unicorn/no-thenable fixture models a Flight Promise
    void Object.defineProperty(flight, 'then', { value: () => undefined })
    const response = new Response('', { headers: { 'x-action-revalidated': '2' } })

    scheduleActionFlightRefresh(response, { f: flight }, undefined)

    await vi.waitFor(() => {
      expect(globalThis.dispatchEvent).toHaveBeenCalled()
    })
    const event = castMock<CustomEvent<ActionFlightRefreshDetail>>(
      vi.mocked(globalThis.dispatchEvent).mock.calls[0]?.[0],
    )
    expect(event.detail.element).toBe(flight)
  })

  it.each([null, ''])('does not dispatch when a native Promise resolves to %s', async value => {
    const response = new Response('', { headers: { 'x-action-revalidated': '2' } })

    scheduleActionFlightRefresh(response, { f: Promise.resolve(value) }, undefined)
    await new Promise<void>(resolve => {
      setTimeout(resolve, 10)
    })

    expect(globalThis.dispatchEvent).not.toHaveBeenCalled()
  })

  it('dispatches the element resolved by a native Promise', async () => {
    const response = new Response('', { headers: { 'x-action-revalidated': '2' } })

    scheduleActionFlightRefresh(response, { f: Promise.resolve(refreshElement) }, undefined)

    await vi.waitFor(() => {
      expect(globalThis.dispatchEvent).toHaveBeenCalled()
    })
    const event = castMock<CustomEvent<ActionFlightRefreshDetail>>(
      vi.mocked(globalThis.dispatchEvent).mock.calls[0]?.[0],
    )
    expect(event.detail.element).toBe(refreshElement)
  })

  it('observes a rejected native Promise even when the action did not revalidate', async () => {
    const error = new Error('flight failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = new Response('')

    scheduleActionFlightRefresh(response, { f: Promise.reject(error) }, undefined)

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('[rari] Action flight refresh failed:', 'flight failed')
    })
    expect(globalThis.dispatchEvent).not.toHaveBeenCalled()
    log.mockRestore()
  })
})
