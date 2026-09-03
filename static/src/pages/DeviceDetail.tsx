/**
 * Device detail — one device, everything about it.
 *
 * The page is organised the way an operator actually reads a device: what it is and
 * whether it is healthy, then what its signals are doing against their declared nominal
 * bands, then what the system already thinks is wrong (alerts, predictions), then what you
 * can do about it (commands), then the audit trail.
 *
 * Two deliberate restraints:
 *
 * - **Counters and state flags get a value list, not a line chart.** A monotonic counter
 *   drawn over time is a straight diagonal; it consumes a whole chart slot to tell you
 *   nothing you could not read from one number.
 * - **Only four metrics chart by default**, chosen out-of-band first. Every charted metric
 *   is a separate telemetry request, and a device type can declare a dozen.
 */

import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { MetricChart } from '../components/charts/TimeSeriesChart'
import {
  breachColor,
  breachLabel,
  breachTone,
  evaluateReading,
  rankGaugeReadings,
  resolveSchema,
} from '../components/DeviceMetricPicks'
import {
  Badge,
  Banner,
  Button,
  Card,
  Cell,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  HealthMeter,
  Input,
  Modal,
  Row,
  SectionHeader,
  Segmented,
  Select,
  SeverityBadge,
  Skeleton,
  StatusDot,
  Table,
  Textarea,
} from '../components/ui'
import api from '../lib/api'
import { useAuth } from '../lib/auth'
import {
  SEVERITY_TOKEN,
  STATUS_TOKEN,
  dateTime,
  duration,
  metricValue,
  num,
  pct,
  seriesColorFor,
  timeAgo,
  describeDetail,
} from '../lib/format'
import type {
  Alert,
  AnomalyExplanation,
  CommandName,
  Device,
  DeviceCommand,
  DeviceStatus,
  MaintenancePrediction,
  MetricSchemaEntry,
  MetricSeries,
  TimelineEntry,
} from '../lib/types'
import { useAction, useAsync } from '../lib/useAsync'

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

type RangeKey = '1h' | '6h' | '24h' | '7d'

const RANGES: { value: RangeKey; label: string; hours: number }[] = [
  { value: '1h', label: '1h', hours: 1 },
  { value: '6h', label: '6h', hours: 6 },
  { value: '24h', label: '24h', hours: 24 },
  { value: '7d', label: '7d', hours: 168 },
]

/** Charted by default. More can be turned on, up to CHART_CAP. */
const DEFAULT_CHARTS = 4
const CHART_CAP = 6

const COMMAND_OPTIONS: { value: CommandName; label: string }[] = [
  { value: 'restart', label: 'Restart' },
  { value: 'clear_fault', label: 'Clear fault' },
  { value: 'calibrate', label: 'Calibrate' },
  { value: 'return_to_dock', label: 'Return to dock' },
  { value: 'enter_maintenance', label: 'Enter maintenance' },
  { value: 'set_config', label: 'Set config' },
  { value: 'firmware_update', label: 'Firmware update' },
]

const COMMAND_LABEL: Record<string, string> = Object.fromEntries(
  COMMAND_OPTIONS.map((c) => [c.value, c.label])
)

const COMMAND_STATE_TONE: Record<DeviceCommand['state'], 'neutral' | 'accent' | 'good' | 'critical'> = {
  queued: 'neutral',
  sent: 'accent',
  acked: 'good',
  failed: 'critical',
  expired: 'neutral',
}

const STATUS_OPTIONS: DeviceStatus[] = ['online', 'degraded', 'offline', 'maintenance', 'provisioning']

const DEMO_TITLE =
  'Disabled on the shared demo account so the live fleet stays intact. Sign in with your own operator account to run this.'
const ROLE_TITLE = 'Requires the operator role.'

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function DeviceDetail() {
  const { deviceId } = useParams()
  const id = Number(deviceId)
  const valid = Number.isFinite(id) && id > 0

  const device = useAsync((signal) => api.devices.get(id, signal), [id], {
    pollMs: 30_000,
    enabled: valid,
  })

  if (!valid) {
    return (
      <Card>
        <EmptyState
          title="That is not a device id"
          hint={`"${deviceId ?? ''}" is not a number. Open a device from the Fleet grid to get a working link.`}
        />
      </Card>
    )
  }

  if (device.error) return <ErrorState error={device.error} onRetry={device.reload} />

  if (!device.data) {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <Skeleton height={28} width="40%" />
          <div className="mt-3">
            <Skeleton height={16} width="70%" />
          </div>
        </Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <Skeleton height={220} />
          </Card>
          <Card>
            <Skeleton height={220} />
          </Card>
        </div>
      </div>
    )
  }

  return <DeviceView device={device.data} reload={device.reload} />
}

/* -------------------------------------------------------------------------- */
/* The device, loaded                                                         */
/* -------------------------------------------------------------------------- */

function DeviceView({ device, reload }: { device: Device; reload: () => void }) {
  const { can, isDemo } = useAuth()
  const [range, setRange] = useState<RangeKey>('6h')
  const [windowNonce, setWindowNonce] = useState(0)
  const [editOpen, setEditOpen] = useState(false)

  const hours = RANGES.find((r) => r.value === range)?.hours ?? 6

  // Freezing the window per range keeps the telemetry deps stable across the device poll —
  // otherwise every 30s tick would refetch every chart.
  const window_ = useMemo(() => {
    const now = Date.now()
    return {
      from: new Date(now - hours * 3_600_000).toISOString(),
      to: new Date(now).toISOString(),
    }
  }, [hours, windowNonce])

  const schema = useMemo(() => resolveSchema(device), [device])
  const gauges = useMemo(() => schema.filter((s) => s.kind === 'gauge'), [schema])
  const ranked = useMemo(() => rankGaugeReadings(device, schema), [device, schema])

  const gaugeKeys = useMemo(() => gauges.map((g) => g.key), [gauges])

  // Charting order: whatever is currently out of band first, then declaration order.
  const defaultCharted = useMemo(() => {
    const rankedKeys = ranked.map((r) => r.schema.key)
    const ordered = [...rankedKeys, ...gaugeKeys.filter((k) => !rankedKeys.includes(k))]
    return ordered.slice(0, DEFAULT_CHARTS)
  }, [ranked, gaugeKeys])

  const [chartedOverride, setChartedOverride] = useState<string[] | null>(null)
  const charted = chartedOverride ?? defaultCharted
  const chartedKeys = useMemo(() => gaugeKeys.filter((k) => charted.includes(k)), [gaugeKeys, charted])

  const toggleMetric = (key: string) => {
    setChartedOverride(
      charted.includes(key) ? charted.filter((k) => k !== key) : [...charted, key]
    )
  }

  const nonGauge = schema.filter((s) => s.kind !== 'gauge')

  const timeRange = (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        value={range}
        onChange={setRange}
        options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
      />
      <Button size="sm" variant="ghost" onClick={() => setWindowNonce((n) => n + 1)}>
        Refresh window
      </Button>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <DeviceHeader
        device={device}
        canEdit={can('operator')}
        isDemo={isDemo}
        onEdit={() => setEditOpen(true)}
      />

      <MetricSection
        device={device}
        gauges={gauges}
        chartedKeys={chartedKeys}
        gaugeKeys={gaugeKeys}
        onToggle={toggleMetric}
        from={window_.from}
        to={window_.to}
        hours={hours}
        controls={timeRange}
      />

      {nonGauge.length > 0 && <CountersAndStates device={device} entries={nonGauge} />}

      <div className="grid gap-4 xl:grid-cols-2">
        <AlertsSection device={device} reload={reload} />
        <PredictionsSection device={device} />
      </div>

      <CommandConsole device={device} />

      <TimelineSection deviceId={device.id} />

      <EditDeviceModal
        device={device}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false)
          reload()
        }}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[13px]" style={{ color: 'var(--text-primary)' }}>
        {children}
      </dd>
    </div>
  )
}

function DeviceHeader({
  device,
  canEdit,
  isDemo,
  onEdit,
}: {
  device: Device
  canEdit: boolean
  isDemo: boolean
  onEdit: () => void
}) {
  const stale = device.status === 'offline'
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {device.name}
            </h1>
            <StatusDot status={device.status} />
            {device.auto_provisioned && <Badge tone="accent">Auto-provisioned</Badge>}
            {device.tags?.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[12px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
              {device.serial}
            </span>
            <CopyButton text={device.serial} label="Copy serial" />
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <HealthMeter score={device.health_score} width={120} />
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button
                size="sm"
                onClick={onEdit}
                disabled={isDemo}
                title={isDemo ? DEMO_TITLE : 'Edit name, location, status and notes'}
              >
                Edit device
              </Button>
            )}
            {/* Scrolled by script, not by an href — under HashRouter a `#commands`
                link would be read as a route change. */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                document
                  .getElementById('device-commands')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              Command console
            </Button>
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3 xl:grid-cols-6">
        <MetaItem label="Type">{device.device_type?.name ?? device.device_type_name ?? '—'}</MetaItem>
        <MetaItem label="Site">{device.site?.name ?? device.site_name ?? '—'}</MetaItem>
        <MetaItem label="Location">{device.location_label || '—'}</MetaItem>
        <MetaItem label="Firmware">
          <span style={{ fontFamily: 'var(--mono)' }}>{device.firmware_version || '—'}</span>
        </MetaItem>
        <MetaItem label="Last seen">
          <span style={{ color: stale ? 'var(--status-critical)' : 'var(--text-primary)' }}>
            {timeAgo(device.last_seen_at)}
          </span>
        </MetaItem>
        <MetaItem label="Health">
          {num(device.health_score, 0)} / 100 · {STATUS_TOKEN[device.status]?.label ?? device.status}
        </MetaItem>
      </dl>

      {device.notes && (
        <p className="mt-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {device.notes}
        </p>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Metric charts                                                              */
/* -------------------------------------------------------------------------- */

interface ChartResult {
  key: string
  series?: MetricSeries
  error?: Error
}

function MetricSection({
  device,
  gauges,
  chartedKeys,
  gaugeKeys,
  onToggle,
  from,
  to,
  hours,
  controls,
}: {
  device: Device
  gauges: MetricSchemaEntry[]
  chartedKeys: string[]
  gaugeKeys: string[]
  onToggle: (key: string) => void
  from: string
  to: string
  hours: number
  controls: React.ReactNode
}) {
  const keyList = chartedKeys.join(',')

  const series = useAsync<ChartResult[]>(
    async (signal) =>
      Promise.all(
        chartedKeys.map(async (key) => {
          try {
            return { key, series: await api.devices.telemetry(device.id, { metric_key: key, from, to }, signal) }
          } catch (err) {
            return { key, error: err as Error }
          }
        })
      ),
    [device.id, keyList, from, to],
    { enabled: chartedKeys.length > 0 }
  )

  const atCap = chartedKeys.length >= CHART_CAP

  return (
    <Card>
      <SectionHeader
        title="Live signals"
        subtitle={
          gauges.length === 0
            ? 'This device type declares no gauge metrics.'
            : `Charting ${chartedKeys.length} of ${gauges.length} gauge metric${
                gauges.length === 1 ? '' : 's'
              }. Metrics currently outside their nominal band chart first; up to ${DEFAULT_CHARTS} open by default so the page stays fast.`
        }
        action={controls}
      />

      {gauges.length === 0 ? (
        <EmptyState
          title="No gauge metrics to chart"
          hint="Add a metric_schema entry with kind: gauge to this device type and the chart appears on the next reading."
        />
      ) : (
        <>
          {/* Metric toggles. Real buttons, with the breach state in text as well as colour. */}
          <div className="mb-4 flex flex-wrap gap-2">
            {gauges.map((g) => {
              const on = chartedKeys.includes(g.key)
              const { breach, excess } = evaluateReading(g, device.metrics_latest?.[g.key])
              const blocked = !on && atCap
              return (
                <button
                  key={g.key}
                  onClick={() => onToggle(g.key)}
                  disabled={blocked}
                  aria-pressed={on}
                  title={
                    blocked
                      ? `Charting is capped at ${CHART_CAP} metrics at once so the page stays fast. Turn one off first.`
                      : on
                        ? `Stop charting ${g.label}`
                        : `Chart ${g.label}`
                  }
                  className={`inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[12px] ${
                    blocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                  }`}
                  style={{
                    background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                    borderColor: on ? 'var(--accent)' : 'var(--surface-3)',
                    color: on ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  <span>{g.label}</span>
                  <span
                    className="num-tabular"
                    style={{ color: breachColor({ schema: g, value: null, breach, excess }) }}
                  >
                    {metricValue(device.metrics_latest?.[g.key], g)}
                  </span>
                  {breach && (
                    <span
                      className="rounded-[4px] px-1 text-[10px]"
                      style={{
                        background: 'var(--surface-1)',
                        color:
                          breachTone({ schema: g, value: null, breach, excess }) === 'critical'
                            ? 'var(--status-critical)'
                            : 'var(--status-serious)',
                      }}
                    >
                      {breachLabel(breach)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {chartedKeys.length === 0 ? (
            <EmptyState
              title="No metrics charted"
              hint="Turn on a metric above to chart it over the selected time range."
            />
          ) : series.error ? (
            <ErrorState error={series.error} onRetry={series.reload} />
          ) : series.initial ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {chartedKeys.map((k) => (
                <Skeleton key={k} height={260} />
              ))}
            </div>
          ) : (
            <div className="grid gap-6 xl:grid-cols-2">
              {(series.data ?? []).map((result) => {
                const entry = gauges.find((g) => g.key === result.key) ?? null
                return (
                  <div key={result.key}>
                    {result.error || !result.series ? (
                      <div
                        className="rounded-[10px] border px-3 py-3"
                        style={{ borderColor: 'var(--surface-3)' }}
                      >
                        <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                          {entry?.label ?? result.key}
                        </p>
                        <p className="mt-1 text-[12px]" style={{ color: 'var(--status-critical)' }}>
                          Could not load this series: {result.error?.message ?? 'unknown error'}
                        </p>
                        <div className="mt-2">
                          <Button size="sm" onClick={series.reload}>
                            Retry
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <MetricChart
                          metric={result.series}
                          schema={entry}
                          color={seriesColorFor(result.key, gaugeKeys)}
                          height={240}
                        />
                        <ExplainPanel
                          deviceId={device.id}
                          metricKey={result.key}
                          metricLabel={entry?.label ?? result.key}
                          hours={hours}
                        />
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Explain with AI                                                            */
/* -------------------------------------------------------------------------- */

function ExplainPanel({
  deviceId,
  metricKey,
  metricLabel,
  hours,
}: {
  deviceId: number
  metricKey: string
  metricLabel: string
  hours: number
}) {
  const [result, setResult] = useState<AnomalyExplanation | null>(null)
  const explain = useAction(() => api.ai.explainAnomaly(deviceId, metricKey, hours))

  const run = async () => {
    const res = await explain.run()
    if (res) setResult(res)
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={result ? 'ghost' : 'secondary'}
          onClick={run}
          pending={explain.pending}
          title={`Ask the model to describe the shape of ${metricLabel} over the last ${hours}h`}
        >
          {result ? 'Re-explain with AI' : 'Explain with AI'}
        </Button>
        {explain.pending && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Reading the last {hours}h of {metricLabel}…
          </span>
        )}
      </div>

      {explain.error && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--status-critical)' }}>
          {explain.error}
        </p>
      )}

      {result && (
        <div
          className="mt-2 rounded-[10px] border px-3 py-2.5"
          style={{ borderColor: 'var(--surface-3)', background: 'var(--surface-2)' }}
        >
          <div className="flex flex-wrap items-center gap-2">
            {result.shape && <Badge tone="accent">{result.shape}</Badge>}
            <Badge tone={result.likely_fault ? 'critical' : 'good'}>
              {result.likely_fault ? 'Reads as a real fault' : 'Reads as benign'}
            </Badge>
            {result.fallback_used && (
              <Badge tone="warning">Deterministic fallback — no model call</Badge>
            )}
          </div>

          {result.explanation && (
            <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {result.explanation}
            </p>
          )}

          {result.what_to_check && result.what_to_check.length > 0 && (
            <>
              <p className="mt-2.5 text-[11px] font-medium tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                What to check
              </p>
              <ul className="mt-1 list-disc pl-5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {result.what_to_check.map((item, i) => (
                  <li key={i} className="mt-0.5">
                    {item}
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Provenance: an AI answer with no model, latency or fallback flag is a claim
              with no receipt. */}
          <p className="mt-2.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {result.model ? `Model ${result.model}` : 'Model not reported'}
            {result.latency_ms !== undefined && result.latency_ms !== null
              ? ` · ${num(result.latency_ms / 1000, 1)}s`
              : ''}
            {` · ${result.fallback_used ? 'fallback path' : 'live inference'} · window ${hours}h`}
          </p>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Counters and state metrics                                                 */
/* -------------------------------------------------------------------------- */

function CountersAndStates({ device, entries }: { device: Device; entries: MetricSchemaEntry[] }) {
  const latest = device.metrics_latest ?? {}
  return (
    <Card>
      <SectionHeader
        title="Counters and state"
        subtitle="Current values only. A monotonic counter drawn as a line is a straight diagonal, and a boolean state is a square wave with two levels — neither earns a chart slot."
      />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3 xl:grid-cols-5">
        {entries.map((e) => (
          <div key={e.key}>
            <dt className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {e.label}
              <span className="ml-1 opacity-70">{e.kind === 'counter' ? '(counter)' : '(state)'}</span>
            </dt>
            <dd className="num-tabular mt-0.5 text-[15px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {metricValue(latest[e.key], e)}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Firing alerts                                                              */
/* -------------------------------------------------------------------------- */

function AlertsSection({ device, reload }: { device: Device; reload: () => void }) {
  const { can, isDemo } = useAuth()
  const alerts = (device.firing_alerts ?? []).filter((a) => a.state !== 'resolved')
  const mutable = can('operator')

  const ack = useAction((id: number) => api.alerts.ack(id))
  const resolve = useAction((id: number) => api.alerts.resolve(id))

  const act = async (fn: typeof ack, id: number) => {
    const res = await fn.run(id)
    if (res) reload()
  }

  const disabledTitle = !mutable ? ROLE_TITLE : isDemo ? DEMO_TITLE : undefined

  return (
    <Card>
      <SectionHeader
        title="Firing alerts"
        subtitle={
          alerts.length
            ? `${alerts.length} alert${alerts.length === 1 ? '' : 's'} open on this device.`
            : undefined
        }
      />

      {ack.error && <Banner tone="critical">{ack.error}</Banner>}
      {resolve.error && <Banner tone="critical">{resolve.error}</Banner>}

      {alerts.length === 0 ? (
        <EmptyState
          title="Nothing firing"
          hint="Alerts appear here the moment a rule or a statistical baseline trips. Nominal bands and baselines are per device, so no thresholds to hand-tune."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {alerts.map((a: Alert) => (
            <li
              key={a.id}
              className="rounded-[10px] border px-3 py-2.5"
              style={{ borderColor: 'var(--surface-3)' }}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={a.severity} />
                    <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {a.rule_name ?? a.metric_key ?? 'Alert'}
                    </span>
                    {a.state === 'acknowledged' && <Badge tone="accent">Acknowledged</Badge>}
                  </div>
                  {a.message && (
                    <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      {a.message}
                    </p>
                  )}
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Fired {timeAgo(a.fired_at)} · firing for {duration(a.fired_at)}
                    {a.observed_value !== null && a.observed_value !== undefined
                      ? ` · observed ${num(a.observed_value, 2)}`
                      : ''}
                    {a.threshold !== null && a.threshold !== undefined
                      ? ` vs threshold ${num(a.threshold, 2)}`
                      : ''}
                    {a.z_score !== null && a.z_score !== undefined ? ` · z=${num(a.z_score, 1)}` : ''}
                    {a.acked_by_name ? ` · acked by ${a.acked_by_name}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {mutable && (
                    <>
                      <Button
                        size="sm"
                        disabled={isDemo || a.state === 'acknowledged'}
                        pending={ack.pending}
                        onClick={() => act(ack, a.id)}
                        title={
                          a.state === 'acknowledged' ? 'Already acknowledged' : (disabledTitle ?? 'Acknowledge')
                        }
                      >
                        Ack
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={isDemo}
                        pending={resolve.pending}
                        onClick={() => act(resolve, a.id)}
                        title={disabledTitle ?? 'Resolve'}
                      >
                        Resolve
                      </Button>
                    </>
                  )}
                  {!mutable && (
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {ROLE_TITLE}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Predictions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Confidence arrives as a 0–1 fraction, but a backend that switches to 0–100 would
 * otherwise render "8500%" — so treat anything above 1 as already a percentage.
 */
function confidenceText(confidence: number): string {
  return confidence > 1 ? `${num(confidence, 0)}%` : pct(confidence)
}

function PredictionsSection({ device }: { device: Device }) {
  const predictions = (device.open_predictions ?? []).filter((p) => p.state === 'open' || p.state === 'scheduled')

  return (
    <Card>
      <SectionHeader
        title="Predicted maintenance"
        subtitle={
          predictions.length
            ? 'Extrapolated from the metric trend, not a fixed service interval.'
            : undefined
        }
      />

      {predictions.length === 0 ? (
        <EmptyState
          title="No failure predicted"
          hint="The predictive sweep fits a trend per component each night. A prediction appears here once a metric's slope points at a limit within the horizon."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {predictions.map((p: MaintenancePrediction) => (
            <li
              key={p.id}
              className="rounded-[10px] border px-3 py-2.5"
              style={{ borderColor: 'var(--surface-3)' }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {p.component}
                </span>
                {p.metric_key && <Badge>{p.metric_key}</Badge>}
                {p.state === 'scheduled' && <Badge tone="accent">Scheduled</Badge>}
              </div>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                Predicted failure {p.predicted_failure_at ? dateTime(p.predicted_failure_at) : 'date unknown'}
                {p.predicted_failure_at ? ` · in ${duration(new Date().toISOString(), p.predicted_failure_at)}` : ''}
                {p.confidence !== null && p.confidence !== undefined
                  ? ` · confidence ${confidenceText(p.confidence)}`
                  : ''}
              </p>
              {p.recommended_action && (
                <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-primary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Recommended: </span>
                  {p.recommended_action}
                </p>
              )}
              {p.scheduled_for && (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Service booked for {dateTime(p.scheduled_for)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Command console                                                            */
/* -------------------------------------------------------------------------- */

function CommandConsole({ device }: { device: Device }) {
  const { can, isDemo } = useAuth()
  const mutable = can('operator')

  const [command, setCommand] = useState<CommandName>('restart')
  const [payloadText, setPayloadText] = useState('')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [lastIssued, setLastIssued] = useState<DeviceCommand | null>(null)

  const history = useAsync(() => api.devices.commands(device.id), [device.id], { pollMs: 20_000 })
  const issue = useAction(
    (cmd: CommandName, payload: Record<string, unknown> | undefined, n: string | undefined) =>
      api.devices.issueCommand(device.id, cmd, payload, n)
  )

  const submit = async () => {
    setFormError(null)
    let payload: Record<string, unknown> | undefined
    const trimmed = payloadText.trim()
    if (trimmed) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setFormError('Payload must be a JSON object, for example {"speed_limit": 0.4}.')
          return
        }
        payload = parsed as Record<string, unknown>
      } catch {
        setFormError('Payload is not valid JSON. Leave it blank if the command takes no arguments.')
        return
      }
    }
    const res = await issue.run(command, payload, note.trim() || undefined)
    if (res) {
      setLastIssued(res)
      setPayloadText('')
      setNote('')
      history.reload()
    }
  }

  const disabled = !mutable || isDemo
  const disabledTitle = !mutable ? ROLE_TITLE : isDemo ? DEMO_TITLE : undefined
  const commands = history.data ?? []

  return (
    <Card>
      <div id="device-commands" className="scroll-mt-16" />
      <SectionHeader
        title="Command console"
        subtitle="Commands are queued on the device record and picked up on its next poll, so the fix happens in the same tool as the diagnosis. Every issue is audit-logged."
      />

      {!mutable && (
        <div className="mb-3">
          <Banner tone="accent">
            You are signed in as a viewer, so issuing commands is disabled. The history below is still live.
          </Banner>
        </div>
      )}
      {mutable && isDemo && (
        <div className="mb-3">
          <Banner tone="warning">{DEMO_TITLE}</Banner>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Command">
          <Select
            value={command}
            onChange={(v) => setCommand(v as CommandName)}
            options={COMMAND_OPTIONS}
            disabled={disabled}
          />
        </Field>
        <Field label="Note" hint="Why you are running it. Shows in the audit log.">
          <Input
            value={note}
            onChange={setNote}
            placeholder="e.g. clearing fault after belt reseat"
            disabled={disabled}
          />
        </Field>
        <Field label="Payload (optional JSON)" hint='e.g. {"target_version": "2.4.1"}'>
          <Textarea
            value={payloadText}
            onChange={setPayloadText}
            rows={2}
            placeholder="{ }"
            disabled={disabled}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={submit}
          disabled={disabled}
          pending={issue.pending}
          title={disabledTitle ?? `Queue ${COMMAND_LABEL[command]} on ${device.name}`}
        >
          Issue {COMMAND_LABEL[command]}
        </Button>
        {lastIssued && (
          <span className="text-[12px]" style={{ color: 'var(--status-good)' }}>
            {COMMAND_LABEL[lastIssued.command] ?? lastIssued.command} queued as #{lastIssued.id}.
          </span>
        )}
      </div>

      {(formError || issue.error) && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--status-critical)' }}>
          {formError ?? issue.error}
        </p>
      )}

      <div className="mt-5">
        <SectionHeader title="Command history" />
        {history.error ? (
          <ErrorState error={history.error} onRetry={history.reload} />
        ) : history.initial ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={28} />
            ))}
          </div>
        ) : commands.length === 0 ? (
          <EmptyState
            title="No commands issued yet"
            hint="Issue one above — restart and clear_fault are the safe ones to try on a healthy device."
          />
        ) : (
          <Table head={['Command', 'State', 'Issued', 'By', 'Sent', 'Acked', 'Round trip', 'Note']}>
            {commands.map((c) => (
              <Row key={c.id}>
                <Cell nowrap>
                  <span className="font-medium">{COMMAND_LABEL[c.command] ?? c.command}</span>
                  {c.payload && Object.keys(c.payload).length > 0 && (
                    <span
                      className="ml-2 text-[11px]"
                      style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}
                    >
                      {JSON.stringify(c.payload)}
                    </span>
                  )}
                </Cell>
                <Cell nowrap>
                  <Badge tone={COMMAND_STATE_TONE[c.state] ?? 'neutral'}>{c.state}</Badge>
                </Cell>
                <Cell nowrap muted>
                  {timeAgo(c.created_at)}
                </Cell>
                <Cell nowrap muted>
                  {c.issued_by_name ?? '—'}
                </Cell>
                <Cell nowrap muted>
                  {c.sent_at ? dateTime(c.sent_at) : '—'}
                </Cell>
                <Cell nowrap muted>
                  {c.acked_at ? dateTime(c.acked_at) : '—'}
                </Cell>
                <Cell nowrap muted>
                  {c.sent_at && c.acked_at ? duration(c.sent_at, c.acked_at) : '—'}
                </Cell>
                <Cell muted>{c.note || '—'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </div>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Timeline                                                                   */
/* -------------------------------------------------------------------------- */

const KIND_LABEL: Record<TimelineEntry['kind'], string> = {
  alert: 'Alert',
  command: 'Command',
  prediction: 'Prediction',
  status: 'Status',
}

function kindColor(entry: TimelineEntry): string {
  if (entry.kind === 'alert') return SEVERITY_TOKEN[entry.severity ?? 'info'].color
  if (entry.kind === 'command') return 'var(--accent)'
  if (entry.kind === 'prediction') return 'var(--series-7)'
  return 'var(--text-muted)'
}

function TimelineSection({ deviceId }: { deviceId: number }) {
  const timeline = useAsync(() => api.devices.timeline(deviceId), [deviceId], { pollMs: 60_000 })
  const entries = timeline.data ?? []

  return (
    <Card>
      <SectionHeader
        title="Timeline"
        subtitle="Alerts, commands, predictions and status changes merged into one reverse-chronological feed."
        action={
          <Button size="sm" variant="ghost" onClick={timeline.reload} pending={timeline.loading && !timeline.initial}>
            Refresh
          </Button>
        }
      />

      {timeline.error ? (
        <ErrorState error={timeline.error} onRetry={timeline.reload} />
      ) : timeline.initial ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} height={30} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title="Nothing has happened yet"
          hint="This device has no alerts, commands, predictions or status changes on record. Telemetry alone does not create a timeline entry."
        />
      ) : (
        <ol className="flex flex-col">
          {entries.map((e, i) => (
            <li key={`${e.ts}-${e.kind}-${e.ref_id ?? i}`} className="flex gap-3">
              {/* Gutter: dot plus the connecting rail. */}
              <div className="flex w-3 shrink-0 flex-col items-center pt-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: kindColor(e) }}
                  aria-hidden="true"
                />
                {i < entries.length - 1 && (
                  <span className="mt-1 w-px flex-1" style={{ background: 'var(--surface-3)' }} aria-hidden="true" />
                )}
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{KIND_LABEL[e.kind] ?? e.kind}</Badge>
                  {e.kind === 'alert' && e.severity && <SeverityBadge severity={e.severity} />}
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {e.title}
                  </span>
                </div>
                {e.detail && (
                  <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {describeDetail(e.detail)}
                  </p>
                )}
                <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {dateTime(e.ts)} · {timeAgo(e.ts)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Edit modal                                                                 */
/* -------------------------------------------------------------------------- */

function EditDeviceModal({
  device,
  open,
  onClose,
  onSaved,
}: {
  device: Device
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { isDemo } = useAuth()
  // Defaulted, not asserted: this modal calls name.trim(), so an absent name has to
  // become an empty string rather than a crash.
  const [name, setName] = useState(device.name ?? '')
  const [location, setLocation] = useState(device.location_label ?? '')
  const [firmware, setFirmware] = useState(device.firmware_version ?? '')
  const [status, setStatus] = useState<DeviceStatus>(device.status ?? 'provisioning')
  const [tags, setTags] = useState((device.tags ?? []).join(', '))
  const [notes, setNotes] = useState(device.notes ?? '')

  const save = useAction(() =>
    api.devices.update(device.id, {
      name: name.trim(),
      location_label: location.trim() || null,
      firmware_version: firmware.trim() || null,
      status,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      notes: notes.trim() || null,
    })
  )

  const submit = async () => {
    const res = await save.run()
    if (res) onSaved()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${device.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            pending={save.pending}
            disabled={isDemo || !name.trim()}
            title={isDemo ? DEMO_TITLE : !name.trim() ? 'A device needs a name' : undefined}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {save.error && <Banner tone="critical">{save.error}</Banner>}
        <Field label="Name">
          <Input value={name} onChange={setName} disabled={isDemo} autoFocus />
        </Field>
        <Field label="Location label" hint="Where it physically is — aisle, room, line.">
          <Input value={location} onChange={setLocation} disabled={isDemo} placeholder="Aisle 4, Bay 2" />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Firmware version">
            <Input value={firmware} onChange={setFirmware} disabled={isDemo} placeholder="2.4.1" />
          </Field>
          <Field label="Status" hint="Set Maintenance to suppress offline alerts during service.">
            <Select
              value={status}
              onChange={(v) => setStatus(v as DeviceStatus)}
              disabled={isDemo}
              options={STATUS_OPTIONS.map((s) => ({ value: s, label: STATUS_TOKEN[s].label }))}
            />
          </Field>
        </div>
        <Field label="Tags" hint="Comma separated.">
          <Input value={tags} onChange={setTags} disabled={isDemo} placeholder="line-3, night-shift" />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={setNotes} rows={3} disabled={isDemo} />
        </Field>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Serial{' '}
          <span style={{ fontFamily: 'var(--mono)' }}>{device.serial}</span> is immutable — it is how the
          device authenticates itself on ingest.
        </p>
      </div>
    </Modal>
  )
}
