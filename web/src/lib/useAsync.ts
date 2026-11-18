import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T }

/** Runs an async loader when deps change; ignores results from stale runs. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  const run = useRef(0)

  useEffect(() => {
    const id = ++run.current
    setState({ status: 'loading' })
    load().then(
      (data) => id === run.current && setState({ status: 'ready', data }),
      (error: unknown) =>
        id === run.current && setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
    )
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}
