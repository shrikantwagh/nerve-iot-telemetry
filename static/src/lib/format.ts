/**
 * Formatting helpers.
 *
 * Presentation rules that must be identical everywhere live here — a health score that
 * rounds differently on two screens reads as a bug in the data.
 */

import type { DeviceStatus, MetricSchemaEntry, Severity } from './types'

/** Compact number for stat tiles: 1,284 / 12.9K / 4.2M. */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return n.toLocaleString()
}

export function num(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/**
 * Format a metric value using its schema entry, so units and precision come from the
 * device type's declaration rather than being guessed per screen.
 */
export function metricValue(
  value: number | string | boolean | null | undefined,
  schema?: MetricSchemaEntry
): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'string') return value
  if (!Number.isFinite(value)) return '—'

  // A `state` metric arrives as 0/1 over the wire; showing "0.00" for it is wrong.
  if (schema?.kind === 'state') return value ? 'On' : 'Off'

  const precision = schema?.precision ?? (Math.abs(value) >= 100 ? 0 : 2)
  const text = value.toLocaleString(undefined, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })
  return schema?.unit ? `${text}${schema.unit.startsWith('°') || schema.unit === '%' ? '' : ' '}${schema.unit}` : text
}

const MINUTE = 60
const HOUR = 3600
const DAY = 86400

/** "4m ago", "2h ago", "3d ago". Past-only — this app never shows future timestamps as ago. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 10) return 'just now'
  if (secs < MINUTE) return `${secs}s ago`
  if (secs < HOUR) return `${Math.floor(secs / MINUTE)}m ago`
  if (secs < DAY) return `${Math.floor(secs / HOUR)}h ago`
  const days = Math.floor(secs / DAY)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/** "2h 14m" — for incident age and command latency. */
export function duration(fromIso: string | null | undefined, toIso?: string | null): string {
  if (!fromIso) return '—'
  const from = new Date(fromIso).getTime()
  const to = toIso ? new Date(toIso).getTime() : Date.now()
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '—'
  let secs = Math.max(0, Math.round((to - from) / 1000))
  if (secs < MINUTE) return `${secs}s`
  const days = Math.floor(secs / DAY)
  secs -= days * DAY
  const hours = Math.floor(secs / HOUR)
  secs -= hours * HOUR
  const mins = Math.floor(secs / MINUTE)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${mins}m`
  return `${mins}m`
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/* -------------------------------------------------------------------------- */
/* Status & severity vocabulary                                               */
/* -------------------------------------------------------------------------- */

/**
 * Status colors are the reserved four-step status palette, never a categorical series
 * slot — and every use pairs the color with a text label, so meaning is never carried
 * by hue alone.
 */
export const SEVERITY_TOKEN: Record<Severity, { color: string; label: string; icon: string }> = {
  critical: { color: 'var(--status-critical)', label: 'Critical', icon: '●' },
  warning: { color: 'var(--status-warning)', label: 'Warning', icon: '▲' },
  info: { color: 'var(--text-muted)', label: 'Info', icon: '■' },
}

export const STATUS_TOKEN: Record<DeviceStatus, { color: string; label: string }> = {
  online: { color: 'var(--status-good)', label: 'Online' },
  degraded: { color: 'var(--status-warning)', label: 'Degraded' },
  offline: { color: 'var(--status-critical)', label: 'Offline' },
  maintenance: { color: 'var(--status-serious)', label: 'Maintenance' },
  provisioning: { color: 'var(--text-muted)', label: 'Provisioning' },
}

/** Health is a magnitude, so it reads off the status ramp by band, not a rainbow. */
export function healthToken(score: number | null | undefined): { color: string; label: string } {
  if (score === null || score === undefined || !Number.isFinite(score))
    return { color: 'var(--text-muted)', label: 'Unknown' }
  if (score >= 85) return { color: 'var(--status-good)', label: 'Healthy' }
  if (score >= 60) return { color: 'var(--status-warning)', label: 'Watch' }
  if (score >= 35) return { color: 'var(--status-serious)', label: 'Degraded' }
  return { color: 'var(--status-critical)', label: 'Critical' }
}

export const CONDITION_LABEL: Record<string, string> = {
  gt: 'above',
  lt: 'below',
  outside_range: 'outside range',
  rate_of_change: 'changing faster than',
  flatline: 'flatlined',
  offline: 'offline',
  anomaly: 'anomalous vs baseline',
}

export const CATEGORY_LABEL: Record<string, string> = {
  robot: 'Robots',
  refrigeration: 'Refrigeration',
  hvac: 'HVAC',
  machine_tool: 'Machine tools',
  power: 'Power',
  gateway: 'Gateways',
  other: 'Other',
}

/** The eight categorical slots, in their fixed validated order. Never cycled. */
export const SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const

/**
 * Color follows the entity, not its row number: a metric key always maps to the same
 * slot, so filtering a chart never repaints the survivors.
 */
export function seriesColorFor(key: string, orderedKeys: string[]): string {
  const idx = orderedKeys.indexOf(key)
  return SERIES_COLORS[(idx < 0 ? 0 : idx) % SERIES_COLORS.length]
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${Math.round(n * 100)}%`
}


/**
 * Render a free-form `detail` field as text.
 *
 * Backend detail payloads are inconsistent by design — a string for most timeline kinds,
 * an object like `{user_id, source, changes}` for status changes. Passing one straight to
 * JSX throws "Objects are not valid as a React child" and, without an error boundary,
 * blanks the screen. This flattens anything to something readable.
 */
export function describeDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return ''
  if (typeof detail === 'string') return detail
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail)
  if (Array.isArray(detail)) return detail.map(describeDetail).filter(Boolean).join(', ')
  if (typeof detail === 'object') {
    // "source: ui, changes: status" reads better than raw JSON in a timeline row.
    return Object.entries(detail as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => {
        const label = k.replace(/_/g, ' ')
        if (v !== null && typeof v === 'object') return `${label}: ${Object.keys(v as object).join(', ')}`
        return `${label}: ${String(v)}`
      })
      .join(' · ')
  }
  return ''
}
