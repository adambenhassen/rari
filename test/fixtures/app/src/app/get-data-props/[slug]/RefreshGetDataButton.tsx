'use client'

import { useTransition } from 'react'
import { refreshGetData } from './actions'

export default function RefreshGetDataButton() {
  const [isPending, startTransition] = useTransition()

  return (
    <button
      type="button"
      data-testid="refresh-get-data"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await refreshGetData()
        })
      }}
    >
      Refresh data
    </button>
  )
}
