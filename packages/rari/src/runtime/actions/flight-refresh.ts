import type { ActionRevalidationKind } from './revalidation-kind'
import { isValidElement } from 'react'
import { errorMessage, isFlightThenable, isRecord } from '@/shared/utils/type-guards'
import { ActionDidNotRevalidate, parseActionRevalidationKind } from './revalidation-kind'

export interface ActionFlightRefreshDetail {
  element: unknown
  revalidationKind: ActionRevalidationKind
  revalidatedPath?: string
}

export interface ActionFlightResponseShape {
  readonly a?: unknown
  readonly f?: unknown
}

const SKIP_REFRESH_MARKER = '~rariSkipRefresh'

function shouldSkipRefreshForActionResult(result: unknown): boolean {
  if (!isRecord(result)) return false

  if ('redirect' in result) return true

  return SKIP_REFRESH_MARKER in result || '~rariFormState' in result
}

function isActionRefreshRoot(value: unknown): boolean {
  return isValidElement(value) || isFlightThenable(value)
}

export function scheduleActionFlightRefresh(
  response: Response,
  flightResponse: ActionFlightResponseShape,
  actionResult: unknown,
): void {
  if (typeof globalThis.dispatchEvent !== 'function') return

  if (shouldSkipRefreshForActionResult(actionResult)) return

  void Promise.resolve()
    .then(() => {
      const refreshElement = flightResponse.f
      if (refreshElement == null) return

      if (!isActionRefreshRoot(refreshElement)) return

      const revalidationKind = parseActionRevalidationKind(
        response.headers.get('x-action-revalidated'),
      )

      if (revalidationKind === ActionDidNotRevalidate) return

      const revalidatedPath = response.headers.get('x-action-revalidated-path') ?? undefined

      const applyRefresh = () => {
        globalThis.dispatchEvent(
          new CustomEvent('rari:action-flight-refresh', {
            detail: {
              element: refreshElement,
              revalidationKind,
              revalidatedPath,
            } satisfies ActionFlightRefreshDetail,
          }),
        )
      }

      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          requestAnimationFrame(applyRefresh)
        })
        return
      }

      queueMicrotask(applyRefresh)
    })
    .catch((error: unknown) => {
      console.error('[rari] Action flight refresh failed:', errorMessage(error, String(error)))
    })
}

export {
  ActionDidNotRevalidate,
  ActionDidRevalidateDynamicOnly,
  ActionDidRevalidateStaticAndDynamic,
} from './revalidation-kind'
