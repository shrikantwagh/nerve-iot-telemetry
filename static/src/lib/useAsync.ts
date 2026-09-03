/**
 * Data-fetching hooks.
 *
 * Deliberately small rather than a query library: this app has a handful of screens,
 * and what actually matters is that (a) an in-flight request is aborted when its screen
 * unmounts or its inputs change, so a slow response cannot overwrite a newer one, and
 * (b) polling pauses when the tab is hidden. Both are easy to get wrong by hand and
 * both are visible as bugs.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

export interface AsyncState<T> {
  data: T | null
  error: ApiError | Error | null
  loading: boolean
  /** True only for the very first load, so refreshes don't blank the screen. */
  initial: boolean
  reload: () => void
  setData: (updater: T | ((prev: T | null) => T | null)) => void
}

export function useAsync<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
  options: { pollMs?: number; enabled?: boolean } = {}
): AsyncState<T> {
  const { pollMs, enabled = true } = options

  const [data, setDataState] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [initial, setInitial] = useState(true)
  const [nonce, setNonce] = useState(0)

  // Keep the fetcher in a ref so a caller passing an inline arrow function does not
  // retrigger the effect on every render.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let cancelled = false

    setLoading(true)
    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (cancelled) return
        setDataState(result)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // An abort is our own doing, not a failure to show the user.
        if ((err as Error)?.name === 'AbortError') return
        if (err instanceof ApiError && err.status === 0 && /cancelled/i.test(err.message)) return
        setError(err as Error)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setInitial(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // Polling: skipped while the tab is hidden. On a free-tier instance a background tab
  // quietly burning the rate limit is a real failure mode, not a theoretical one.
  useEffect(() => {
    if (!pollMs || !enabled) return
    let timer: number | undefined

    const tick = () => {
      if (!document.hidden) setNonce((n) => n + 1)
      timer = window.setTimeout(tick, pollMs)
    }
    timer = window.setTimeout(tick, pollMs)

    const onVisible = () => {
      if (!document.hidden) setNonce((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      if (timer) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pollMs, enabled])

  const setData = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater))
  }, [])

  return { data, error, loading, initial, reload, setData }
}

/** For buttons that mutate: tracks pending state and surfaces the error message. */
export function useAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>
): {
  run: (...args: TArgs) => Promise<TResult | undefined>
  pending: boolean
  error: string | null
  clearError: () => void
} {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Mounted flag, set on EVERY effect run rather than only at declaration.
   *
   * StrictMode double-invokes effects (mount -> cleanup -> mount). With the flag
   * initialised once at `useRef(true)` and only ever cleared in the cleanup, that
   * sequence leaves it permanently `false` on the second mount — and every error this
   * hook catches is then silently discarded. That is precisely how a failed login
   * showed a spinner, stopped, and told the user nothing. Assigning `true` on each run
   * makes the flag mean "currently mounted", which is what the guard is for.
   */
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(
    async (...args: TArgs) => {
      setPending(true)
      setError(null)
      try {
        return await fn(...args)
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err))
        return undefined
      } finally {
        if (mounted.current) setPending(false)
      }
    },
    [fn]
  )

  return { run, pending, error, clearError: () => setError(null) }
}

/** Debounce a fast-changing value (search boxes) so we don't hammer the API. */
export function useDebounced<T>(value: T, ms = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

/** Theme toggle: light / dark / system, stamped on <html> as data-theme. */
export type ThemeChoice = 'light' | 'dark' | 'system'

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    try {
      const saved = window.localStorage.getItem('nerve.theme')
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
    } catch {
      /* storage unavailable — fall through to system */
    }
    return 'system'
  })

  useEffect(() => {
    const root = document.documentElement
    if (choice === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', choice)
    try {
      window.localStorage.setItem('nerve.theme', choice)
    } catch {
      /* ignore */
    }
  }, [choice])

  return [choice, setChoice]
}
