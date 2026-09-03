/**
 * Time-series chart with a nominal band.
 *
 * The nominal band is the point of this component. A telemetry reading means nothing
 * without knowing what "normal" is for that metric, and the device type already declares
 * it in `metric_schema`. Shading the nominal range turns "the line is at 47" into "the
 * line has left its band" without the reader having to know the metric.
 *
 * Mark specs are fixed per the dataviz method: 2px lines with round caps, no dot on
 * every point (only the endpoint, with a 2px surface ring), 10% area wash, hairline
 * SOLID gridlines one step off the surface, and a crosshair + tooltip hover layer.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { clockTime, dateTime, num } from '../../lib/format'
import type { MetricSchemaEntry, MetricSeries } from '../../lib/types'
import { ChartFrame, TooltipRow, TooltipShell } from './ChartFrame'
import type { LegendItem } from './ChartFrame'

export interface SeriesSpec {
  key: string
  label: string
  color: string
  unit?: string
  points: { ts: string; value: number | null }[]
}

interface MergedPoint {
  t: number
  label: string
  [seriesKey: string]: number | string | null
}

/**
 * Merge several series onto one time axis.
 *
 * Recharts wants one row per x-value, so series sampled at slightly different instants
 * have to be reconciled. Rows are keyed by exact timestamp: a series with no reading at
 * an instant gets `null` there, which Recharts renders as a gap rather than inventing a
 * value by interpolation. A fabricated point in a monitoring tool is worse than a gap.
 */
function mergeSeries(series: SeriesSpec[]): MergedPoint[] {
  const byTime = new Map<number, MergedPoint>()
  for (const s of series) {
    for (const p of s.points) {
      const t = new Date(p.ts).getTime()
      if (!Number.isFinite(t)) continue
      let row = byTime.get(t)
      if (!row) {
        row = { t, label: p.ts }
        byTime.set(t, row)
      }
      row[s.key] = p.value
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t)
}

/** Round an axis domain out to clean numbers so ticks read 0 / 20 / 40, not 3.7 / 21.4. */
function niceDomain(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1
    return [min - pad, max + pad]
  }
  const span = max - min
  const pad = span * 0.08
  const lo = min - pad
  const hi = max + pad
  const step = 10 ** Math.floor(Math.log10(span)) / 2
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step]
}

export function TimeSeriesChart({
  title,
  subtitle,
  series,
  schema,
  height = 260,
  controls,
  footnote,
  showBand = true,
}: {
  title: string
  subtitle?: string
  series: SeriesSpec[]
  /** Supplies the nominal band and units. From the device type's declaration. */
  schema?: MetricSchemaEntry | null
  height?: number
  controls?: React.ReactNode
  footnote?: React.ReactNode
  showBand?: boolean
}) {
  const rows = mergeSeries(series)
  const legend: LegendItem[] = series.map((s) => ({ key: s.key, label: s.label, color: s.color }))

  const values = rows.flatMap((r) => series.map((s) => r[s.key]).filter((v): v is number => typeof v === 'number'))
  const dataMin = values.length ? Math.min(...values) : 0
  const dataMax = values.length ? Math.max(...values) : 1

  // The band must be inside the visible domain or the reader cannot see they have left it.
  const bandLow = showBand ? (schema?.nominal_min ?? null) : null
  const bandHigh = showBand ? (schema?.nominal_max ?? null) : null
  const domainMin = bandLow !== null ? Math.min(dataMin, bandLow) : dataMin
  const domainMax = bandHigh !== null ? Math.max(dataMax, bandHigh) : dataMax
  const [yLo, yHi] = niceDomain(domainMin, domainMax)

  const unit = schema?.unit ?? series[0]?.unit ?? ''
  const precision = schema?.precision ?? 2
  const spansDays = rows.length > 1 && rows[rows.length - 1].t - rows[0].t > 26 * 3600 * 1000

  const table = (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr>
          <th
            className="border-b px-2 py-1.5 text-left font-medium"
            style={{ borderColor: 'var(--surface-3)', color: 'var(--text-muted)' }}
          >
            Time
          </th>
          {series.map((s) => (
            <th
              key={s.key}
              className="border-b px-2 py-1.5 text-right font-medium whitespace-nowrap"
              style={{ borderColor: 'var(--surface-3)', color: 'var(--text-muted)' }}
            >
              {s.label}
              {unit ? ` (${unit})` : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows
          .slice()
          .reverse()
          .map((r) => (
            <tr key={r.t}>
              <td
                className="border-b px-2 py-1 whitespace-nowrap"
                style={{ borderColor: 'var(--surface-3)', color: 'var(--text-secondary)' }}
              >
                {dateTime(r.label)}
              </td>
              {series.map((s) => (
                <td
                  key={s.key}
                  className="num-tabular border-b px-2 py-1 text-right"
                  style={{ borderColor: 'var(--surface-3)' }}
                >
                  {typeof r[s.key] === 'number' ? num(r[s.key] as number, precision) : '—'}
                </td>
              ))}
            </tr>
          ))}
      </tbody>
    </table>
  )

  const bandNote =
    bandLow !== null || bandHigh !== null ? (
      <>
        Shaded band is the nominal operating range
        {bandLow !== null && bandHigh !== null
          ? ` (${num(bandLow, precision)}–${num(bandHigh, precision)}${unit ? ` ${unit}` : ''})`
          : ''}{' '}
        declared by the device type.
      </>
    ) : null

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      legend={legend}
      controls={controls}
      height={height}
      table={table}
      footnote={
        footnote ? (
          <>
            {footnote}
            {bandNote ? <> {bandNote}</> : null}
          </>
        ) : (
          bandNote
        )
      }
    >
      {rows.length === 0 ? (
        <div
          className="flex h-full items-center justify-center text-[12px]"
          style={{ color: 'var(--text-muted)' }}
        >
          No readings in this window.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            {/* Nominal band, drawn under the data as a wash. */}
            {bandLow !== null && bandHigh !== null && (
              <ReferenceArea
                y1={bandLow}
                y2={bandHigh}
                fill="var(--status-good)"
                fillOpacity={0.08}
                stroke="none"
              />
            )}
            {bandHigh !== null && (
              <ReferenceLine y={bandHigh} stroke="var(--status-good)" strokeOpacity={0.5} strokeWidth={1} />
            )}
            {bandLow !== null && (
              <ReferenceLine y={bandLow} stroke="var(--status-good)" strokeOpacity={0.5} strokeWidth={1} />
            )}

            {/* Hairline, SOLID, recessive — never dashed. */}
            <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />

            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t: number) =>
                spansDays ? dateTime(new Date(t).toISOString()) : clockTime(new Date(t).toISOString())
              }
              stroke="var(--axis)"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={[yLo, yHi]}
              tickFormatter={(v: number) => num(v, Math.abs(v) >= 100 ? 0 : 1)}
              stroke="var(--axis)"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              width={52}
              unit={undefined}
            />

            <Tooltip
              // The crosshair is the hover layer for a line chart.
              cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                return (
                  <TooltipShell>
                    <div className="mb-1 font-medium">
                      {dateTime(new Date(Number(label)).toISOString())}
                    </div>
                    {payload.map((p) => (
                      <TooltipRow
                        key={String(p.dataKey)}
                        color={p.color}
                        label={series.find((s) => s.key === p.dataKey)?.label ?? String(p.dataKey)}
                        value={`${num(p.value as number, precision)}${unit ? ` ${unit}` : ''}`}
                      />
                    ))}
                  </TooltipShell>
                )
              }}
            />

            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                // No dot on every point — that is chaos and goes unread.
                dot={false}
                // Endpoint marker only: >=8px with a 2px surface ring so it stays
                // legible where lines cross.
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)', fill: s.color }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartFrame>
  )
}

/**
 * Convenience wrapper for the common case: one metric series straight off
 * `GET /devices/{id}/telemetry`.
 */
export function MetricChart({
  metric,
  schema,
  color = 'var(--series-1)',
  height = 240,
  controls,
}: {
  metric: MetricSeries
  schema?: MetricSchemaEntry | null
  color?: string
  height?: number
  controls?: React.ReactNode
}) {
  const label = schema?.label ?? metric.label ?? metric.metric_key
  const effectiveSchema: MetricSchemaEntry = {
    key: metric.metric_key,
    label,
    unit: schema?.unit ?? metric.unit ?? '',
    kind: schema?.kind ?? 'gauge',
    nominal_min: schema?.nominal_min ?? metric.nominal_min ?? null,
    nominal_max: schema?.nominal_max ?? metric.nominal_max ?? null,
    precision: schema?.precision ?? 2,
  }

  return (
    <TimeSeriesChart
      title={label}
      subtitle={effectiveSchema.unit ? `Measured in ${effectiveSchema.unit}` : undefined}
      series={[
        {
          key: metric.metric_key,
          label,
          color,
          unit: effectiveSchema.unit,
          points: metric.points.map((p) => ({ ts: p.ts, value: p.value })),
        },
      ]}
      schema={effectiveSchema}
      height={height}
      controls={controls}
      footnote={
        <>
          {metric.source === 'rollup'
            ? 'Served from 5-minute rollups.'
            : 'Served from raw readings.'}
          {metric.truncated ? ` Truncated to ${metric.point_cap ?? 'the point cap'}.` : ''}
        </>
      }
    />
  )
}
