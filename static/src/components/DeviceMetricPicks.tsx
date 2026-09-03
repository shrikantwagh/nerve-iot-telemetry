/**
 * Device metric selection — shared by the fleet grid and the device detail screen.
 *
 * The reason this exists rather than "show the first two metrics": a row that always
 * surfaces `battery_pct` is useless on the day the problem is `vibration_rms`. The device
 * type already declares a nominal band per metric, so we can rank a device's live
 * readings by how far outside their band they sit and surface the one that is actually
 * wrong. The same ranking decides which charts open first on the detail page.
 */

import { metricValue } from '../lib/format'
import type { Device, DeviceType, MetricSchemaEntry, MetricValues } from '../lib/types'
import { Badge } from './ui'

export type Breach = 'high' | 'low' | null

export interface MetricPick {
  schema: MetricSchemaEntry
  value: number | string | boolean | null
  breach: Breach
  /** Distance outside the nominal band, normalised by the band width. 0 when inside. */
  excess: number
}

/**
 * Last-resort schema when a device type declares none: treat every live reading as an
 * unbanded gauge so the screen still shows numbers instead of an empty column.
 */
export function synthSchema(values: MetricValues | null | undefined): MetricSchemaEntry[] {
  if (!values) return []
  return Object.keys(values).map((key) => ({
    key,
    label: key.replace(/_/g, ' '),
    unit: '',
    kind: 'gauge' as const,
  }))
}

export function resolveSchema(device: Device, typeMap?: Map<number, DeviceType>): MetricSchemaEntry[] {
  const declared = typeMap?.get(device.device_type_id)?.metric_schema ?? device.device_type?.metric_schema
  if (declared && declared.length) return declared
  return synthSchema(device.metrics_latest)
}

/** How far a reading sits outside its declared nominal band. */
export function evaluateReading(
  entry: MetricSchemaEntry,
  value: number | string | boolean | null | undefined
): { breach: Breach; excess: number } {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { breach: null, excess: 0 }
  const lo = entry.nominal_min ?? null
  const hi = entry.nominal_max ?? null
  if (lo === null && hi === null) return { breach: null, excess: 0 }

  // Normalise by the band width so a 2 degC overshoot on a freezer and a 2 % overshoot on
  // a battery do not get compared as if they were the same size of problem.
  const span =
    lo !== null && hi !== null
      ? Math.abs(hi - lo) || Math.abs(hi) || 1
      : Math.abs((hi ?? lo) as number) || 1

  if (hi !== null && value > hi) return { breach: 'high', excess: (value - hi) / span }
  if (lo !== null && value < lo) return { breach: 'low', excess: (lo - value) / span }
  return { breach: null, excess: 0 }
}

/** A breach past a quarter of the band width reads as serious rather than borderline. */
export const BREACH_HARD = 0.25

export function breachTone(pick: MetricPick): 'warning' | 'critical' {
  return pick.excess >= BREACH_HARD ? 'critical' : 'warning'
}

export function breachColor(pick: MetricPick): string {
  if (!pick.breach) return 'var(--text-primary)'
  return pick.excess >= BREACH_HARD ? 'var(--status-critical)' : 'var(--status-serious)'
}

export function breachLabel(breach: Breach): string {
  if (breach === 'high') return 'above nominal'
  if (breach === 'low') return 'below nominal'
  return ''
}

/**
 * Rank a device's gauge readings: out-of-band first, worst breach first, otherwise the
 * order the device type declared them in.
 */
export function rankGaugeReadings(device: Device, schema: MetricSchemaEntry[]): MetricPick[] {
  const latest = device.metrics_latest ?? {}
  const picks: (MetricPick & { order: number })[] = []

  schema.forEach((entry, order) => {
    if (entry.kind !== 'gauge') return
    const value = latest[entry.key]
    if (value === undefined || value === null || value === '') return
    const { breach, excess } = evaluateReading(entry, value)
    picks.push({ schema: entry, value, breach, excess, order })
  })

  picks.sort((a, b) => {
    if (Boolean(a.breach) !== Boolean(b.breach)) return a.breach ? -1 : 1
    if (b.excess !== a.excess) return b.excess - a.excess
    return a.order - b.order
  })

  return picks.map(({ schema: s, value, breach, excess }) => ({ schema: s, value, breach, excess }))
}

export function pickInterestingMetrics(
  device: Device,
  schema: MetricSchemaEntry[],
  limit = 2
): MetricPick[] {
  return rankGaugeReadings(device, schema).slice(0, limit)
}

/**
 * Inline reading list for a table cell. Colour is never the only signal — a breach also
 * gets the words "above nominal" / "below nominal".
 */
export function MetricPills({ picks }: { picks: MetricPick[] }) {
  if (!picks.length) {
    return (
      <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
        No readings yet
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {picks.map((p) => (
        <span key={p.schema.key} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {p.schema.label}
          </span>
          <span className="num-tabular text-[12px] font-medium" style={{ color: breachColor(p) }}>
            {metricValue(p.value, p.schema)}
          </span>
          {p.breach && <Badge tone={breachTone(p)}>{breachLabel(p.breach)}</Badge>}
        </span>
      ))}
    </span>
  )
}
