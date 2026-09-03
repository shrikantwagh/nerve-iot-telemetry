/**
 * Health-score distribution.
 *
 * Health bands are *ordered* and *semantic* — "0-10" is worse than "90-100" — so
 * coloring bars by band is a legitimate status encoding, not a value-ramp painted onto
 * nominal categories. Every bar is labeled by its bucket on the axis and its count above
 * the cap, so color is never the only channel carrying the reading.
 *
 * Mark specs: bars capped at 24px thick (the band's leftover is air), 4px rounded
 * data-end with a square baseline, and a 2px surface gap between neighbours.
 */

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { healthToken } from '../../lib/format'
import type { HealthBucket } from '../../lib/types'
import { ChartFrame, TooltipRow, TooltipShell } from './ChartFrame'

export function HealthHistogram({
  buckets,
  height = 220,
  total,
}: {
  buckets: HealthBucket[]
  height?: number
  total?: number
}) {
  const rows = buckets.map((b) => ({
    ...b,
    // Color from the midpoint of the band, so the fill matches the health vocabulary
    // used in every table and meter elsewhere in the app.
    color: healthToken((b.from + b.to) / 2).color,
  }))

  const table = (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr>
          {['Health band', 'Devices', 'Share'].map((h) => (
            <th
              key={h}
              className="border-b px-2 py-1.5 text-left font-medium"
              style={{ borderColor: 'var(--surface-3)', color: 'var(--text-muted)' }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.bucket}>
            <td className="border-b px-2 py-1" style={{ borderColor: 'var(--surface-3)' }}>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block rounded-sm"
                  style={{ width: 8, height: 8, background: r.color }}
                />
                {r.bucket}
              </span>
            </td>
            <td
              className="num-tabular border-b px-2 py-1"
              style={{ borderColor: 'var(--surface-3)' }}
            >
              {r.count}
            </td>
            <td
              className="num-tabular border-b px-2 py-1"
              style={{ borderColor: 'var(--surface-3)', color: 'var(--text-secondary)' }}
            >
              {total ? `${Math.round((r.count / total) * 100)}%` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <ChartFrame
      title="Health distribution"
      subtitle="Devices grouped by composite health score"
      height={height}
      table={table}
      footnote="Health blends alert load, reporting recency and open maintenance predictions."
    >
      {rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
          No devices yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 18, right: 8, bottom: 4, left: 0 }} barCategoryGap="20%">
            <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="bucket"
              stroke="var(--axis)"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              interval={0}
            />
            <YAxis
              stroke="var(--axis)"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              width={36}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const row = payload[0].payload as (typeof rows)[number]
                return (
                  <TooltipShell>
                    <div className="mb-1 font-medium">Health {row.bucket}</div>
                    <TooltipRow color={row.color} label={healthToken((row.from + row.to) / 2).label} value={`${row.count} devices`} />
                  </TooltipShell>
                )
              }}
            />
            <Bar
              dataKey="count"
              maxBarSize={24}
              // 4px rounded data-end, square at the baseline.
              radius={[4, 4, 0, 0]}
              // A 2px gap in the surface color separates neighbours — never a border.
              stroke="var(--surface-1)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {rows.map((r) => (
                <Cell key={r.bucket} fill={r.color} />
              ))}
              {/* Value on the cap — the counts are few enough to label every bar here
                  without it becoming noise, and it satisfies the relief rule directly. */}
              <LabelList
                dataKey="count"
                position="top"
                offset={6}
                style={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                formatter={(v: number) => (v > 0 ? String(v) : '')}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartFrame>
  )
}
