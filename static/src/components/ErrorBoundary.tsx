/**
 * Error boundary.
 *
 * Without one, a single component throwing during render unmounts the ENTIRE React tree
 * and leaves a blank page — which is exactly what happened here: five of the seven
 * screens went completely blank whenever the API returned 429, with the only clue an
 * "object is not iterable" thrown from inside react-dom. A blank screen is the worst
 * possible failure report, because it tells the user nothing and tells the developer
 * less.
 *
 * Scoped per route rather than only at the root, so a broken screen degrades to a
 * message inside the app shell — the nav still works and you can navigate away — instead
 * of taking the whole application down with it.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Names the area in the fallback, e.g. "Fleet". */
  label?: string
  /** Bumping this resets the boundary — pass the route key so navigation clears it. */
  resetKey?: string
}

interface State {
  error: Error | null
  componentStack: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // A thrown value is not guaranteed to be an Error — code can throw a string, and
    // Xano error payloads arrive as plain objects. Normalise so the fallback can always
    // render something useful rather than "[object Object]".
    if (error instanceof Error) return { error }
    return { error: new Error(typeof error === 'string' ? error : JSON.stringify(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null })
    // Keep the component stack in the console: it is the only thing that identifies
    // WHICH component threw, and it is what turned a blank page into a fixable bug.
    console.error('[Nerve] render error', { error, componentStack: info.componentStack })
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, componentStack: null })
    }
  }

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    const where = this.props.label ? ` on ${this.props.label}` : ''
    // The first few frames are the useful ones; the full stack is in the console.
    const topFrames = (componentStack ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6)

    return (
      <div className="p-4">
        <div
          className="rounded-[10px] border px-4 py-3"
          style={{ borderColor: 'var(--status-critical)', background: 'var(--surface-1)' }}
        >
          <p className="text-[13px] font-medium" style={{ color: 'var(--status-critical)' }}>
            This screen hit an error{where}
          </p>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            The rest of the app is still working — use the navigation to move elsewhere. If
            this started right after a burst of activity, the backend may have rate-limited
            the requests this screen depends on.
          </p>
          <pre
            className="mt-2 overflow-x-auto rounded-[6px] px-2 py-1.5 text-[11px]"
            style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
          >
            {error.message || String(error)}
          </pre>
          {topFrames.length > 0 && (
            <details className="mt-2">
              <summary
                className="cursor-pointer text-[11px]"
                style={{ color: 'var(--text-muted)' }}
              >
                Where it happened
              </summary>
              <pre
                className="mt-1 overflow-x-auto rounded-[6px] px-2 py-1.5 text-[11px]"
                style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
              >
                {topFrames.join('\n')}
              </pre>
            </details>
          )}
          <button
            onClick={() => this.setState({ error: null, componentStack: null })}
            className="mt-3 cursor-pointer rounded-[6px] border px-3 py-1.5 text-[13px] font-medium"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--surface-3)',
              color: 'var(--text-primary)',
            }}
          >
            Try this screen again
          </button>
        </div>
      </div>
    )
  }
}
