/**
 * Predictive maintenance.
 *
 * A forecast is only worth acting on if you can check it, so every card carries the fit
 * that produced it: how many samples, over what window, how well the line fits, and the
 * limit the trend is heading for. That panel is the difference between a claim and a
 * guess with a date on it — a maintenance schedule is a truck roll, and nobody should be
 * asked to book one on the strength of an unexplained number.
 *
 * Ordering is by soonest predicted failure, because that is the order the work has to
 * happen in.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { useAuth } from '../lib/auth'
import { useAction, useAsync } from '../lib/useAsync'
import { dateTime, duration, num, pct, timeAgo } from '../lib/format'
import type {
  Device,
  DeviceType,
  MaintenancePrediction,
  MetricSchemaEntry,
  PredictionState,
  Site,
} from '../lib/types'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  SectionHeader,
  Segmented,
  Select,
  Skeleton,
  Textarea,
} from '../components/ui'
import { StatTile } from '../components/StatTile'

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type StateFilter = PredictionState | 'all'

const DAY_MS = 86_400_000

const STATE_TONE: Record<PredictionState, 'accent' | 'neutral' | 'good' | 'warning'> = {
  open: 'warning',
  scheduled: 'accent',
  completed: 'good',
  dismissed: 'neutral',
}

const STATE_LABEL: Record<PredictionState, string> = {
  open: 'Open',
  scheduled: 'Scheduled',
  completed: 'Completed',
  dismissed: 'Dismissed',
}

/** Confidence may arrive as 0–1 or as 0–100; normalize to a fraction. */
function asFraction(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const v = value > 1 ? value / 100 : value
  return Math.max(0, Math.min(1, v))
}

function confidenceLabel(fraction: number | null): string {
  if (fraction === null) return 'Unrated'
  if (fraction >= 0.8) return 'High confidence'
  if (fraction >= 0.5) return 'Moderate confidence'
  return 'Low confidence'
}

/** Attach a unit without a space for the units that read wrong with one. */
function withUnit(text: string, unit?: string | null): string {
  if (!unit) return text
  return unit === '%' || unit.startsWith('°') ? `${text}${unit}` : `${text} ${unit}`
}

function humanizeKey(key: string | null | undefined): string {
  if (!key) return 'metric'
  return key.replace(/_/g, ' ')
}

function readString(bag: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = bag[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function readNumber(bag: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = bag[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/**
 * State the trend the way an engineer would say it out loud: which measure, which
 * direction, how fast. `trend_slope` is the sweep's per-day slope; if the evidence
 * declares its own unit or period we prefer that over the assumption.
 */
function trendPhrase(
  prediction: MaintenancePrediction,
  schema: MetricSchemaEntry | undefined
): string | null {
  const slope = prediction.trend_slope
  if (slope === null || slope === undefined || !Number.isFinite(slope)) return null

  const evidence = (prediction.evidence ?? {}) as Record<string, unknown>
  const unit = schema?.unit ?? readString(evidence, ['unit', 'metric_unit', 'value_unit'])
  const period = readString(evidence, ['slope_per', 'slope_unit', 'per', 'slope_period']) ?? 'day'
  const measure = schema?.label ?? humanizeKey(prediction.metric_key)

  if (slope === 0) return `${measure} is flat`
  const magnitude = num(Math.abs(slope), Math.abs(slope) >= 10 ? 1 : 2)
  const direction = slope < 0 ? 'falling' : 'rising'
  return `${measure} ${direction} ${withUnit(magnitude, unit)} per ${period}`
}

const EVIDENCE_LABEL: Record<string, string> = {
  samples: 'Samples in fit',
  sample_count: 'Samples in fit',
  n: 'Samples in fit',
  r_squared: 'Fit quality (R²)',
  r2: 'Fit quality (R²)',
  window: 'Window analysed',
  window_hours: 'Window analysed (hours)',
  window_days: 'Window analysed (days)',
  limit: 'Failure limit',
  threshold: 'Failure limit',
  hard_limit: 'Failure limit',
  slope: 'Slope per day',
  intercept: 'Fit intercept',
  first_value: 'First value in window',
  last_value: 'Latest value',
  current_value: 'Latest value',
  metric_key: 'Metric',
  unit: 'Unit',
  source: 'Data source',
  bucket: 'Bucket size',
  model: 'Fit model',
}

function evidenceValueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—'
    if (Number.isInteger(value)) return value.toLocaleString()
    return num(value, Math.abs(value) < 1 ? 3 : 2)
  }
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function toDateInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Default the maintenance window to three days before the forecast, never in the past. */
function defaultScheduleDate(prediction: MaintenancePrediction): string {
  const failure = prediction.predicted_failure_at
    ? new Date(prediction.predicted_failure_at).getTime()
    : NaN
  const target = Number.isFinite(failure) ? failure - 3 * DAY_MS : Date.now() + DAY_MS
  return toDateInput(Math.max(Date.now() + DAY_MS, target))
}

/* -------------------------------------------------------------------------- */
/* Small parts                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Confidence meter. Labelled, because "0.62" beside a bar is a number without a verdict
 * — and the label, not the fill, is what a colour-blind reader gets.
 */
function ConfidenceMeter({ value }: { value: number | null | undefined }) {
  const fraction = asFraction(value)
  const label = confidenceLabel(fraction)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Confidence
        </span>
        <span className="num-tabular text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {fraction === null ? '—' : pct(fraction)}
        </span>
      </div>
      <span
        className="mt-1 block overflow-hidden rounded-full"
        style={{ height: 5, background: 'var(--surface-3)' }}
        role="img"
        aria-label={`${label}${fraction === null ? '' : `, ${pct(fraction)}`}`}
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${(fraction ?? 0) * 100}%`, background: 'var(--accent)' }}
        />
      </span>
      <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
    </div>
  )
}

function EvidencePanel({ prediction }: { prediction: MaintenancePrediction }) {
  const [open, setOpen] = useState(false)
  const entries = Object.entries((prediction.evidence ?? {}) as Record<string, unknown>)
  const evidence = (prediction.evidence ?? {}) as Record<string, unknown>
  const rSquared = readNumber(evidence, ['r_squared', 'r2'])
  const samples = readNumber(evidence, ['samples', 'sample_count', 'n'])
  const panelId = `evidence-${prediction.id}`

  const summary =
    entries.length === 0
      ? 'No fit inputs recorded'
      : [
          samples !== undefined ? `${samples.toLocaleString()} samples` : null,
          rSquared !== undefined ? `R² ${num(rSquared, 2)}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || `${entries.length} fit inputs`

  return (
    <div className="mt-3 rounded-[6px] border" style={{ borderColor: 'var(--surface-3)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          Evidence — {summary}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {open ? 'Hide' : 'Show'}
        </span>
      </button>

      {open && (
        <div id={panelId} className="border-t px-2.5 py-2" style={{ borderColor: 'var(--surface-3)' }}>
          {entries.length === 0 ? (
            <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              This prediction was stored without its fit inputs, so it cannot be checked here. Treat it
              as a hint, not a finding.
            </p>
          ) : (
            <>
              <div className="scroll-x">
                <table className="w-full border-collapse text-[12px]">
                  <tbody>
                    {entries.map(([key, value]) => (
                      <tr key={key}>
                        <th
                          scope="row"
                          className="py-1 pr-3 text-left font-normal whitespace-nowrap"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {EVIDENCE_LABEL[key] ?? humanizeKey(key)}
                        </th>
                        <td className="num-tabular py-1" style={{ color: 'var(--text-primary)' }}>
                          {evidenceValueText(value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rSquared !== undefined && (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  The straight-line fit explains {pct(asFraction(rSquared) ?? 0)} of the variation over this
                  window. Below about 60% the date is a direction, not a deadline.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function Predictions() {
  const { can, isDemo } = useAuth()
  const canAct = can('operator')

  const [state, setState] = useState<StateFilter>('open')
  const [siteId, setSiteId] = useState('')
  const [deviceId, setDeviceId] = useState('')

  const [scheduling, setScheduling] = useState<MaintenancePrediction | null>(null)
  const [scheduleDate, setScheduleDate] = useState('')
  const [dismissing, setDismissing] = useState<MaintenancePrediction | null>(null)
  const [dismissReason, setDismissReason] = useState('')

  // Reference data in one shot: three lists, one loading state, one retry.
  const reference = useAsync<{ sites: Site[]; devices: Device[]; deviceTypes: DeviceType[] }>(
    async () => {
      const [sites, devices, deviceTypes] = await Promise.all([
        api.sites.list(),
        // Pages internally; /devices 400s on a per_page above 100.
        api.devices.listAll({ sort: 'name' }),
        api.deviceTypes.list(),
      ])
      return { sites: sites ?? [], devices, deviceTypes: deviceTypes ?? [] }
    },
    []
  )

  const list = useAsync(
    () =>
      api.predictions.list({
        state: state === 'all' ? undefined : state,
        site_id: siteId ? Number(siteId) : undefined,
        device_id: deviceId ? Number(deviceId) : undefined,
      }),
    [state, siteId, deviceId]
  )

  const schedule = useAction((id: number, iso: string) => api.predictions.schedule(id, iso))
  const dismiss = useAction((id: number, reason: string) => api.predictions.dismiss(id, reason))

  /** metric_key -> the device type's own declaration, so units and labels are not guessed. */
  const schemaFor = useMemo(() => {
    const typeById = new Map<number, DeviceType>()
    for (const t of reference.data?.deviceTypes ?? []) typeById.set(t.id, t)
    const deviceById = new Map<number, Device>()
    for (const d of reference.data?.devices ?? []) deviceById.set(d.id, d)

    return (prediction: MaintenancePrediction): MetricSchemaEntry | undefined => {
      if (!prediction.metric_key) return undefined
      const device = deviceById.get(prediction.device_id)
      const type = device?.device_type_id ? typeById.get(device.device_type_id) : undefined
      return type?.metric_schema?.find((m) => m.key === prediction.metric_key)
    }
  }, [reference.data])

  const rows = useMemo(() => {
    const items = list.data ?? []
    return [...items].sort((a, b) => {
      const at = a.predicted_failure_at ? new Date(a.predicted_failure_at).getTime() : Infinity
      const bt = b.predicted_failure_at ? new Date(b.predicted_failure_at).getTime() : Infinity
      if (at !== bt) return at - bt
      return (asFraction(b.confidence) ?? 0) - (asFraction(a.confidence) ?? 0)
    })
  }, [list.data])

  const stats = useMemo(() => {
    const now = Date.now()
    const withDate = rows.filter((r) => r.predicted_failure_at)
    const soon = withDate.filter((r) => {
      const t = new Date(r.predicted_failure_at as string).getTime()
      return Number.isFinite(t) && t - now <= 7 * DAY_MS
    }).length
    const confidences = rows.map((r) => asFraction(r.confidence)).filter((c): c is number => c !== null)
    const avgConfidence = confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null
    return { total: rows.length, soon, avgConfidence }
  }, [rows])

  const siteOptions = [
    { value: '', label: 'All sites' },
    ...(reference.data?.sites ?? []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.code})` })),
  ]

  const deviceOptions = [
    { value: '', label: 'All devices' },
    ...(reference.data?.devices ?? [])
      .filter((d) => !siteId || String(d.site_id) === siteId)
      .map((d) => ({ value: String(d.id), label: d.name })),
  ]

  const actionTitle = isDemo
    ? 'Disabled on the shared demo account so the live fleet stays intact.'
    : !canAct
      ? 'Requires the operator role.'
      : undefined

  const closeSchedule = () => {
    setScheduling(null)
    schedule.clearError()
  }
  const closeDismiss = () => {
    setDismissing(null)
    setDismissReason('')
    dismiss.clearError()
  }

  const submitSchedule = async () => {
    if (!scheduling || !scheduleDate) return
    // The window opens at 09:00 local — a bare date would land at midnight UTC and read
    // as the day before for anyone west of Greenwich.
    const iso = new Date(`${scheduleDate}T09:00:00`).toISOString()
    const result = await schedule.run(scheduling.id, iso)
    if (result) {
      closeSchedule()
      list.reload()
    }
  }

  const submitDismiss = async () => {
    if (!dismissing || dismissReason.trim().length < 3) return
    const result = await dismiss.run(dismissing.id, dismissReason.trim())
    if (result) {
      closeDismiss()
      list.reload()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Predictive maintenance"
        subtitle="An hourly sweep fits a trend line to each device's metric rollups and projects when it crosses its limit. Every forecast below shows the fit it came from."
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <Segmented<StateFilter>
          value={state}
          onChange={setState}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'scheduled', label: 'Scheduled' },
            { value: 'completed', label: 'Completed' },
            { value: 'dismissed', label: 'Dismissed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <div className="w-48">
          <Field label="Site">
            <Select
              value={siteId}
              onChange={(v) => {
                setSiteId(v)
                setDeviceId('')
              }}
              options={siteOptions}
              disabled={reference.initial}
            />
          </Field>
        </div>
        <div className="w-56">
          <Field label="Device">
            <Select
              value={deviceId}
              onChange={setDeviceId}
              options={deviceOptions}
              disabled={reference.initial}
            />
          </Field>
        </div>
      </div>

      {reference.error && !reference.data && (
        <ErrorState error={reference.error} onRetry={reference.reload} />
      )}

      {/* Summary */}
      {!list.initial && !list.error && rows.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Predictions in view" value={stats.total} />
          <StatTile
            label="Failing within 7 days"
            value={stats.soon}
            accent={stats.soon > 0 ? 'var(--status-serious)' : undefined}
            hint={stats.soon > 0 ? 'schedule these first' : 'nothing imminent'}
          />
          <StatTile
            label="Average confidence"
            value={stats.avgConfidence === null ? '—' : pct(stats.avgConfidence)}
            hint="across the fits in view"
          />
        </div>
      )}

      {/* List */}
      {list.initial ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <Skeleton height={14} width="40%" />
              <div className="mt-3">
                <Skeleton height={12} width="70%" />
              </div>
              <div className="mt-2">
                <Skeleton height={12} width="55%" />
              </div>
            </Card>
          ))}
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title={state === 'open' ? 'No open predictions' : 'Nothing matches these filters'}
            hint={
              state === 'open'
                ? 'Predictions are written by the hourly trend sweep, which needs a few hours of rollups per device before it can fit a line — so a fresh instance legitimately has none yet. Run the simulator with a backfill (Admin → Setup) to give it history to work with.'
                : 'Widen the state filter, or clear the site and device filters.'
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((p) => {
            const schema = schemaFor(p)
            const trend = trendPhrase(p, schema)
            const failureAt = p.predicted_failure_at ? new Date(p.predicted_failure_at).getTime() : null
            const overdue = failureAt !== null && Number.isFinite(failureAt) && failureAt < Date.now()

            return (
              <Card key={p.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/devices/${p.device_id}`}
                        className="text-[14px] font-semibold hover:underline"
                        style={{ color: 'var(--accent)' }}
                      >
                        {p.device_name ?? `Device ${p.device_id}`}
                      </Link>
                      <Badge tone={STATE_TONE[p.state] ?? 'neutral'}>
                        {STATE_LABEL[p.state] ?? p.state}
                      </Badge>
                      {p.site_name && <Badge>{p.site_name}</Badge>}
                    </div>
                    <p className="mt-1 text-[13px]" style={{ color: 'var(--text-primary)' }}>
                      {p.component}
                      {p.metric_key && (
                        <span style={{ color: 'var(--text-muted)' }}>
                          {' · '}
                          {schema?.label ?? humanizeKey(p.metric_key)}
                          <span className="ml-1" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                            {p.metric_key}
                          </span>
                        </span>
                      )}
                    </p>
                    {trend && (
                      <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                        Trend: {trend}
                      </p>
                    )}
                    {p.device_serial && (
                      <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Serial {p.device_serial}
                        {p.created_at ? ` · predicted ${timeAgo(p.created_at)}` : ''}
                      </p>
                    )}
                  </div>

                  <div className="w-full shrink-0 sm:w-52">
                    <div
                      className="rounded-[6px] px-2.5 py-2"
                      style={{ background: 'var(--surface-2)' }}
                    >
                      <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Predicted failure
                      </span>
                      <span
                        className="block text-[14px] font-semibold"
                        style={{ color: overdue ? 'var(--status-critical)' : 'var(--text-primary)' }}
                      >
                        {dateTime(p.predicted_failure_at)}
                      </span>
                      <span className="block text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {failureAt === null || !Number.isFinite(failureAt)
                          ? 'no date projected'
                          : overdue
                            ? `overdue by ${duration(p.predicted_failure_at)}`
                            : `in ${duration(new Date().toISOString(), p.predicted_failure_at)}`}
                      </span>
                    </div>
                    <div className="mt-2">
                      <ConfidenceMeter value={p.confidence} />
                    </div>
                  </div>
                </div>

                {p.recommended_action && (
                  <div
                    className="mt-3 rounded-[6px] border-l-2 px-3 py-2"
                    style={{ borderColor: 'var(--accent)', background: 'var(--surface-2)' }}
                  >
                    <span className="block text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                      Recommended action
                    </span>
                    <span className="block text-[13px]" style={{ color: 'var(--text-primary)' }}>
                      {p.recommended_action}
                    </span>
                  </div>
                )}

                <EvidencePanel prediction={p} />

                {p.state === 'scheduled' && p.scheduled_for && (
                  <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    Maintenance scheduled for {dateTime(p.scheduled_for)}.
                  </p>
                )}

                {(p.state === 'open' || p.state === 'scheduled') && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!canAct || isDemo}
                      title={actionTitle}
                      onClick={() => {
                        setScheduling(p)
                        setScheduleDate(defaultScheduleDate(p))
                        schedule.clearError()
                      }}
                    >
                      {p.state === 'scheduled' ? 'Reschedule maintenance' : 'Schedule maintenance'}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!canAct || isDemo}
                      title={actionTitle}
                      onClick={() => {
                        setDismissing(p)
                        setDismissReason('')
                        dismiss.clearError()
                      }}
                    >
                      Dismiss
                    </Button>
                    <Link
                      to={`/devices/${p.device_id}`}
                      className="inline-flex items-center text-[12px] font-medium hover:underline"
                      style={{ color: 'var(--accent)' }}
                    >
                      Open the device charts
                    </Link>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {/* Schedule */}
      <Modal
        open={scheduling !== null}
        onClose={closeSchedule}
        title="Schedule maintenance"
        footer={
          <>
            <Button onClick={closeSchedule}>Cancel</Button>
            <Button
              variant="primary"
              pending={schedule.pending}
              disabled={!scheduleDate}
              onClick={submitSchedule}
            >
              Schedule
            </Button>
          </>
        }
      >
        {scheduling && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {scheduling.component} on{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                {scheduling.device_name ?? `device ${scheduling.device_id}`}
              </strong>
              . Forecast crosses its limit {dateTime(scheduling.predicted_failure_at)}.
            </p>
            <Field
              label="Maintenance date"
              hint="The window opens at 09:00 local time. Defaulted to three days before the forecast so there is slack."
            >
              <Input
                type="date"
                value={scheduleDate}
                onChange={setScheduleDate}
                autoFocus
                onEnter={submitSchedule}
              />
            </Field>
            {schedule.error && (
              <p className="text-[12px]" style={{ color: 'var(--status-critical)' }}>
                {schedule.error}
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Dismiss */}
      <Modal
        open={dismissing !== null}
        onClose={closeDismiss}
        title="Dismiss prediction"
        footer={
          <>
            <Button onClick={closeDismiss}>Cancel</Button>
            <Button
              variant="danger"
              pending={dismiss.pending}
              disabled={dismissReason.trim().length < 3}
              onClick={submitDismiss}
            >
              Dismiss prediction
            </Button>
          </>
        }
      >
        {dismissing && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Dismissing tells the sweep this trend is not worth acting on. The reason is written to the
              audit log, so the next person to see the same trend knows why it was waved off.
            </p>
            <Field label="Reason" hint="Required — a bare dismissal loses the only context there was.">
              <Textarea
                value={dismissReason}
                onChange={setDismissReason}
                rows={3}
                placeholder="Sensor was replaced on the 14th; the drift is the old probe, not the compressor."
              />
            </Field>
            {dismiss.error && (
              <p className="text-[12px]" style={{ color: 'var(--status-critical)' }}>
                {dismiss.error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
