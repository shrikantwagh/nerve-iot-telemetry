/**
 * The shell every chart sits in.
 *
 * Two things here are deliberate rather than decorative:
 *
 * 1. **The Table toggle is not optional.** Three light-mode series slots (aqua, yellow,
 *    magenta) sit below 3:1 contrast against the light surface. The dataviz method's
 *    relief rule says a contrast WARN obligates visible labels or a table view — so
 *    every chart in this app ships one. It doubles as the accessible path for anyone
 *    the color channel fails.
 * 2. **The container includes the x-axis band.** Fixing a height that only fits the plot
 *    is what produces those tiny nested scrollbars inside dashboard cards.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Segmented } from '../ui'

export interface LegendItem {
  key: string
  label: string
  color: string
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  // A single series needs no legend box: the chart title already names it.
  if (items.length < 2) return null
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-1.5">
          {/* A short line-key, matching how the series is actually drawn. */}
          <span
            aria-hidden="true"
            className="inline-block rounded-full"
            style={{ width: 12, height: 2, background: it.color }}
          />
          {/* Text wears text tokens, never the series color. */}
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {it.label}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ChartFrame({
  title,
  subtitle,
  legend,
  controls,
  children,
  table,
  height = 240,
  footnote,
}: {
  title: string
  subtitle?: ReactNode
  legend?: LegendItem[]
  /** Filters live in one row above the chart. */
  controls?: ReactNode
  children: ReactNode
  /** The relief-rule table view. Required for any chart with a plot. */
  table: ReactNode
  height?: number
  footnote?: ReactNode
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart')

  return (
    <figure className="m-0">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <figcaption className="min-w-0">
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h3>
          {subtitle && (
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {subtitle}
            </p>
          )}
        </figcaption>
        <div className="flex shrink-0 items-center gap-2">
          {controls}
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'table', label: 'Table' },
            ]}
          />
        </div>
      </div>

      {legend && legend.length > 1 && (
        <div className="mb-2">
          <ChartLegend items={legend} />
        </div>
      )}

      {view === 'chart' ? (
        // Height includes the axis band, so nothing gets its own nested scrollbar.
        <div style={{ height }}>{children}</div>
      ) : (
        <div className="scroll-x" style={{ maxHeight: height + 40, overflowY: 'auto' }}>
          {table}
        </div>
      )}

      {footnote && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {footnote}
        </p>
      )}
    </figure>
  )
}

/** Shared tooltip surface, so every chart's hover layer looks like one system. */
export function TooltipShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-[6px] border px-2.5 py-2 shadow-lg"
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--surface-3)',
        color: 'var(--text-primary)',
        fontSize: 12,
      }}
    >
      {children}
    </div>
  )
}

export function TooltipRow({
  color,
  label,
  value,
}: {
  color?: string
  label: string
  value: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5">
        {color && (
          <span
            aria-hidden="true"
            className="inline-block rounded-full"
            style={{ width: 8, height: 8, background: color }}
          />
        )}
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </span>
      <span className="num-tabular font-medium">{value}</span>
    </div>
  )
}
