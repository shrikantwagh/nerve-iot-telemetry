/**
 * Stat tile and hero figure.
 *
 * When the story is one number, the number is the chart — a one-bar bar chart or an
 * eight-hue donut for a single value is the most common way a dashboard misses its own
 * point. Values use proportional figures (tabular-nums makes a large "121" look loose);
 * `tabular-nums` is reserved for numbers stacked in table columns.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { compact } from '../lib/format'
import { Sparkline } from './charts/Sparkline'

export function StatTile({
  label,
  value,
  unit,
  delta,
  deltaGood,
  trend,
  trendColor = 'var(--series-1)',
  accent,
  to,
  hint,
}: {
  label: string
  value: number | string | null | undefined
  unit?: string
  /** Signed change vs a named period, e.g. "+12 vs yesterday". */
  delta?: { value: number; period: string } | null
  /** Whether an increase is good; drives the delta color. Omit for a neutral delta. */
  deltaGood?: boolean
  trend?: (number | null)[]
  trendColor?: string
  /** Color for the value — use a status token only when the number *means* a status. */
  accent?: string
  to?: string
  hint?: ReactNode
}) {
  const display = typeof value === 'number' ? compact(value) : (value ?? '—')

  const deltaColor = (() => {
    if (!delta || delta.value === 0 || deltaGood === undefined) return 'var(--text-muted)'
    const isUp = delta.value > 0
    return isUp === deltaGood ? 'var(--status-good)' : 'var(--status-critical)'
  })()

  const body = (
    <div
      className="flex h-full flex-col justify-between rounded-[10px] border p-3"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--surface-3)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </span>
        {trend && trend.length > 1 && <Sparkline values={trend} color={trendColor} width={72} height={20} />}
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className="text-[26px] leading-none font-semibold"
          style={{ color: accent ?? 'var(--text-primary)' }}
        >
          {display}
        </span>
        {unit && (
          <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            {unit}
          </span>
        )}
      </div>

      {(delta || hint) && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          {delta && (
            <span style={{ color: deltaColor }}>
              {delta.value > 0 ? '+' : ''}
              {compact(delta.value)} {delta.period}
            </span>
          )}
          {hint && <span style={{ color: 'var(--text-muted)' }}>{hint}</span>}
        </div>
      )}
    </div>
  )

  return to ? (
    <Link to={to} className="block h-full no-underline hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  )
}

/**
 * The single number a view leads with. Exactly one per view, >=48px, in the same sans as
 * everything else — a display or serif face here reads as off-brand decoration.
 */
export function HeroFigure({
  label,
  value,
  unit,
  sub,
  accent,
}: {
  label: string
  value: number | string | null | undefined
  unit?: string
  sub?: ReactNode
  accent?: string
}) {
  const display = typeof value === 'number' ? compact(value) : (value ?? '—')
  return (
    <div>
      <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </p>
      <p className="mt-1 flex items-baseline gap-2">
        <span
          className="text-[48px] leading-none font-semibold tracking-tight"
          style={{ color: accent ?? 'var(--text-primary)' }}
        >
          {display}
        </span>
        {unit && (
          <span className="text-[16px]" style={{ color: 'var(--text-muted)' }}>
            {unit}
          </span>
        )}
      </p>
      {sub && (
        <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {sub}
        </p>
      )}
    </div>
  )
}
