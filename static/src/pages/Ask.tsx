/**
 * Ask — the natural-language query console.
 *
 * The pitch of this screen is not "there is a chatbot in my monitoring tool". It is that
 * the model only ever *plans*: `/ai/query` turns English into a constrained JSON query
 * plan, Xano validates that plan against a field allowlist, and Xano executes it against
 * real rows. So the screen is built in that order — the answer, the rows it came from,
 * and then the plan itself, always available. The plan panel is the trust mechanism; a
 * rejected plan is shown just as plainly as a successful one, because "the model asked
 * for a field it is not allowed to query, so nothing ran" is the strongest possible
 * evidence that the allowlist is real.
 *
 * Nothing here mutates the fleet, so nothing here is role-gated: a viewer, and the shared
 * demo account, can ask freely. That is deliberate — the headline feature must work for
 * the person watching the demo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api from '../lib/api'
import { useAuth } from '../lib/auth'
import { dateTime, num, seriesColorFor, timeAgo } from '../lib/format'
import type { DeviceStatus, NlQueryLogEntry, NlQueryPlan, NlQueryResult, Severity } from '../lib/types'
import { useAsync } from '../lib/useAsync'
import {
  Badge,
  Banner,
  Button,
  Card,
  Cell,
  CopyButton,
  EmptyState,
  ErrorState,
  HealthMeter,
  LinkCell,
  Row,
  SectionHeader,
  SeverityBadge,
  Skeleton,
  Spinner,
  StatusDot,
  Table,
} from '../components/ui'
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart'
import type { SeriesSpec } from '../components/charts/TimeSeriesChart'

/* -------------------------------------------------------------------------- */
/* Examples                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Chosen to show range rather than to flatter the model: a threshold breach over a time
 * window, a ranked lookup scoped to a site, a grouped count over a named day, a
 * rate-of-change question, and an aggregate across sites.
 */
const EXAMPLES = [
  'Which freezers drifted above -15C in the last 6 hours?',
  'Show me the 5 unhealthiest devices at Osaka',
  'How many alerts fired by severity yesterday?',
  'Which AMRs have battery draining faster than normal?',
  'What is the average spindle temperature per site?',
] as const

/** Rows are capped in the DOM, never in the reported count. */
const RENDER_CAP = 50

/** Above this the timed stage label flips from "planning" to "running". */
const PLAN_STAGE_SECONDS = 3

/* -------------------------------------------------------------------------- */
/* Row shaping                                                                */
/* -------------------------------------------------------------------------- */

type QueryRow = Record<string, unknown>

interface Column {
  key: string
  label: string
  numeric: boolean
  temporal: boolean
  /** Largest magnitude in the column — drives the in-cell magnitude bar. */
  max: number
}

const TIME_KEY = /(^|_)(ts|at|time|date|bucket|hour|day|week|month)$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/
const DEVICE_STATUSES = new Set(['online', 'degraded', 'offline', 'maintenance', 'provisioning'])
const SEVERITIES = new Set(['critical', 'warning', 'info'])

/** Read a field the response type does not declare, without lying about the type. */
function extra(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key]
}

function toIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Xano hands out epoch milliseconds; a 10-digit number is seconds.
    const ms = Math.abs(value) > 1e11 ? value : value * 1000
    const d = new Date(ms)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
  return null
}

/**
 * Deliberately conservative. `new Date('2')` parses, so a bare numeric string would be
 * misread as a date and rendered as a timestamp — a column has to either look ISO or be
 * named like a time column to be treated as one.
 */
function looksTemporal(key: string, values: unknown[]): boolean {
  const present = values.filter((v) => v !== null && v !== undefined)
  if (!present.length) return false
  if (present.every((v) => typeof v === 'string' && ISO_DATE.test(v))) return true
  return TIME_KEY.test(key) && present.every((v) => toIso(v) !== null)
}

function humanize(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b(id|ai|amr|hvac|ip)\b/gi, (m) => m.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase())
}

function buildColumns(rows: QueryRow[]): Column[] {
  const keys: string[] = []
  for (const r of rows) {
    for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
  }
  return keys.map((key) => {
    const values = rows.map((r) => r[key])
    const present = values.filter((v) => v !== null && v !== undefined)
    const numeric = present.length > 0 && present.every((v) => typeof v === 'number' && Number.isFinite(v))
    const magnitudes = numeric ? (present as number[]).map((n) => Math.abs(n)) : []
    return {
      key,
      label: humanize(key),
      numeric,
      temporal: looksTemporal(key, values),
      max: magnitudes.length ? Math.max(...magnitudes) : 0,
    }
  })
}

function formatNumber(value: number): string {
  return num(value, Number.isInteger(value) ? 0 : 2)
}

/** One cell. Known vocabulary (severity, status, health) reuses the app's own components. */
function renderValue(value: unknown, col: Column) {
  if (value === null || value === undefined || value === '') return <span style={{ color: 'var(--text-muted)' }}>—</span>

  if (col.key === 'severity' && typeof value === 'string' && SEVERITIES.has(value)) {
    return <SeverityBadge severity={value as Severity} />
  }
  if (col.key === 'status' && typeof value === 'string' && DEVICE_STATUSES.has(value)) {
    return <StatusDot status={value as DeviceStatus} />
  }
  if (col.key.includes('health') && typeof value === 'number') {
    return <HealthMeter score={value} />
  }
  if (col.temporal && (typeof value === 'string' || typeof value === 'number')) {
    const iso = toIso(value)
    return iso ? <span className="whitespace-nowrap">{dateTime(iso)}</span> : String(value)
  }
  if (typeof value === 'number') return <span className="num-tabular">{formatNumber(value)}</span>
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string') return value

  const json = JSON.stringify(value)
  return (
    <span className="text-[11px]" style={{ fontFamily: 'var(--mono)', color: 'var(--text-secondary)' }}>
      {json.length > 120 ? `${json.slice(0, 120)}…` : json}
    </span>
  )
}

/** A single measure gets a magnitude bar, so a ranked answer reads as a ranking. */
function MagnitudeValue({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(2, Math.round((Math.abs(value) / max) * 100)) : 0
  return (
    <span className="inline-flex items-center justify-end gap-2 whitespace-nowrap">
      <span
        className="inline-block overflow-hidden rounded-full"
        style={{ width: 64, height: 5, background: 'var(--surface-3)' }}
        aria-hidden="true"
      >
        <span className="block h-full rounded-full" style={{ width: `${width}%`, background: 'var(--seq-400)' }} />
      </span>
      <span className="num-tabular">{formatNumber(value)}</span>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Chart selection                                                            */
/* -------------------------------------------------------------------------- */

const TIME_CHART = /line|time|area|trend|spark/i
const RANKED_CHART = /bar|column|pie|donut|hist/i

/**
 * Build a time series from arbitrary rows, honouring the plan's own `chart_hint`.
 *
 * Returns null whenever the rows do not actually suit a line chart — a wrong chart is
 * worse than a table, and the caller falls back to one.
 */
function timeSeriesFrom(
  rows: QueryRow[],
  columns: Column[],
  hint: NlQueryPlan['chart_hint'],
  plan: NlQueryPlan | undefined
): SeriesSpec[] | null {
  if (!hint?.type || !TIME_CHART.test(hint.type)) return null

  const hintedX = hint.x && columns.some((c) => c.key === hint.x) ? hint.x : undefined
  const xKey = hintedX ?? columns.find((c) => c.temporal)?.key
  if (!xKey) return null

  const hintedY = hint.y && columns.some((c) => c.key === hint.y && c.numeric) ? hint.y : undefined
  const yKey = hintedY ?? columns.find((c) => c.numeric && c.key !== xKey)?.key
  if (!yKey) return null

  const groupBy = plan?.aggregate?.group_by
  const groupKey =
    groupBy && groupBy !== xKey && groupBy !== yKey && columns.some((c) => c.key === groupBy) ? groupBy : undefined

  const yLabel = columns.find((c) => c.key === yKey)?.label ?? humanize(yKey)
  const buckets = new Map<string, { ts: string; value: number | null }[]>()
  let points = 0

  for (const r of rows) {
    const ts = toIso(r[xKey])
    if (!ts) continue
    const raw = r[yKey]
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    const name = groupKey ? String(r[groupKey] ?? 'Unknown') : yLabel
    const list = buckets.get(name) ?? []
    list.push({ ts, value })
    buckets.set(name, list)
    if (value !== null) points += 1
  }

  // One point is a number, not a trend.
  if (points < 2) return null

  // Cap at the eight validated categorical slots rather than cycling colors.
  const names = [...buckets.keys()].slice(0, 8)
  return names.map((name) => ({
    key: name,
    label: name,
    color: seriesColorFor(name, names),
    points: (buckets.get(name) ?? []).slice().sort((a, b) => a.ts.localeCompare(b.ts)),
  }))
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

function ResultTable({
  rows,
  columns,
  ranked,
  entity,
}: {
  rows: QueryRow[]
  columns: Column[]
  /** The plan asked for a bar-style chart, so the single measure gets a magnitude bar. */
  ranked: boolean
  entity?: string
}) {
  const measures = columns.filter((c) => c.numeric && !c.temporal)
  const measureKey = ranked && measures.length === 1 ? measures[0].key : null
  const linksToDevice = Boolean(entity && /device/i.test(entity))

  return (
    <Table head={columns.map((c) => c.label)}>
      {rows.map((r, i) => (
        <Row key={i}>
          {columns.map((c) => {
            const value = r[c.key]

            // A device row that carries its own id is worth making navigable — the
            // answer is usually the start of a drill-down, not the end of one.
            if (linksToDevice && (c.key === 'name' || c.key === 'device_name') && typeof r.id === 'number') {
              return (
                <LinkCell key={c.key} to={`/devices/${r.id}`}>
                  {String(value ?? `Device ${r.id}`)}
                </LinkCell>
              )
            }

            if (c.key === measureKey && typeof value === 'number') {
              return (
                <Cell key={c.key} align="right" nowrap>
                  <MagnitudeValue value={value} max={c.max} />
                </Cell>
              )
            }

            return (
              <Cell key={c.key} align={c.numeric ? 'right' : 'left'} nowrap={c.numeric || c.temporal}>
                {renderValue(value, c)}
              </Cell>
            )
          })}
        </Row>
      ))}
    </Table>
  )
}

function ResultsSection({ result }: { result: NlQueryResult }) {
  const rows = useMemo(() => (result.rows ?? []).filter((r): r is QueryRow => Boolean(r)), [result.rows])
  const reported = result.row_count ?? rows.length
  const shown = useMemo(() => rows.slice(0, RENDER_CAP), [rows])
  const columns = useMemo(() => buildColumns(shown), [shown])
  const hint = result.chart_hint ?? result.plan?.chart_hint
  const series = useMemo(() => timeSeriesFrom(shown, columns, hint, result.plan), [shown, columns, hint, result.plan])

  if (!rows.length) {
    return (
      <EmptyState
        title="No rows matched"
        hint="The plan was accepted and executed — it just found nothing. Widen the time range, or open the plan below and check the filters it chose."
      />
    )
  }

  const ranked = Boolean(hint?.type && RANKED_CHART.test(hint.type))
  const capped = reported > shown.length

  return (
    <div>
      {series ? (
        <TimeSeriesChart
          title="Results"
          subtitle={`${reported.toLocaleString()} ${reported === 1 ? 'row' : 'rows'} returned`}
          series={series}
          height={260}
          footnote={
            <>
              Charted because the validated plan asked for a {hint?.type} over{' '}
              <span style={{ fontFamily: 'var(--mono)' }}>{hint?.x ?? 'time'}</span>.
            </>
          }
        />
      ) : (
        <>
          <ResultTable rows={shown} columns={columns} ranked={ranked} entity={result.plan?.entity} />
          {ranked && (
            <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              The plan asked for a {hint?.type} chart. Grouped counts read better as a ranked table here, so the
              measure carries a magnitude bar instead of a separate chart.
            </p>
          )}
        </>
      )}

      <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {capped
          ? `Showing the first ${shown.length} of ${reported.toLocaleString()} rows returned.`
          : `${reported.toLocaleString()} ${reported === 1 ? 'row' : 'rows'} returned.`}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* How this was answered                                                      */
/* -------------------------------------------------------------------------- */

function HowPanel({
  result,
  open,
  onToggle,
}: {
  result: NlQueryResult
  open: boolean
  onToggle: () => void
}) {
  const planJson = result.plan ? JSON.stringify(result.plan, null, 2) : null
  const modelRaw = extra(result, 'model')
  const model = typeof modelRaw === 'string' && modelRaw ? modelRaw : null
  const latency = result.latency_ms
  const rowCount = result.row_count ?? result.rows?.length ?? 0

  const facts: { label: string; value: string }[] = [
    { label: 'Rows returned', value: rowCount.toLocaleString() },
    {
      label: 'Latency',
      value:
        typeof latency === 'number' && Number.isFinite(latency)
          ? latency >= 1000
            ? `${num(latency / 1000, 1)}s`
            : `${Math.round(latency)}ms`
          : 'not reported',
    },
    {
      label: 'Planner',
      value: model ?? (result.fallback_used ? 'deterministic interpreter' : 'not reported by this endpoint'),
    },
  ]

  return (
    <div className="rounded-[10px] border" style={{ borderColor: 'var(--surface-3)', background: 'var(--surface-1)' }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            How this was answered
          </span>
          <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            The validated query plan, row count and latency
          </span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {open ? 'Hide ▲' : 'Show ▼'}
        </span>
      </button>

      {open && (
        <div className="border-t px-4 py-3" style={{ borderColor: 'var(--surface-3)' }}>
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            The model never wrote a query. It filled the JSON plan below, Xano validated every field in it against a
            queryable-field allowlist, and Xano executed it against your own rows — which is the difference between
            this and a chatbot guessing at an answer.
          </p>

          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            {facts.map((f) => (
              <div key={f.label}>
                <dt className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {f.label}
                </dt>
                <dd className="num-tabular m-0 text-[13px]" style={{ color: 'var(--text-primary)' }}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-3">
            {planJson ? (
              <>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                    Validated plan
                  </span>
                  <CopyButton text={planJson} label="Copy plan" />
                </div>
                <pre
                  className="scroll-x m-0 rounded-[6px] border p-3 text-[12px] leading-relaxed"
                  style={{
                    background: 'var(--surface-2)',
                    borderColor: 'var(--surface-3)',
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--mono)',
                    maxHeight: 320,
                    overflowY: 'auto',
                  }}
                >
                  {planJson}
                </pre>
              </>
            ) : (
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                No plan was returned for this question, so there was nothing to validate or execute.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Recent questions                                                           */
/* -------------------------------------------------------------------------- */

function HistoryItem({ entry, onRerun }: { entry: NlQueryLogEntry; onRerun: (q: string) => void }) {
  const ok = entry.success
  return (
    <li>
      <button
        onClick={() => onRerun(entry.question)}
        title={`Ask again: ${entry.question}`}
        className="w-full cursor-pointer rounded-[6px] border px-2.5 py-2 text-left hover:opacity-85"
        style={{ borderColor: 'var(--surface-3)', background: 'var(--surface-1)' }}
      >
        <span className="block text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {entry.question}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: ok ? 'var(--status-good)' : 'var(--status-critical)' }}
            />
            {ok ? 'Answered' : 'Rejected'}
          </span>
          {ok && (
            <span className="num-tabular" style={{ color: 'var(--text-muted)' }}>
              {(entry.row_count ?? 0).toLocaleString()} {entry.row_count === 1 ? 'row' : 'rows'}
            </span>
          )}
          {typeof entry.latency_ms === 'number' && (
            <span className="num-tabular" style={{ color: 'var(--text-muted)' }}>
              {entry.latency_ms >= 1000 ? `${num(entry.latency_ms / 1000, 1)}s` : `${Math.round(entry.latency_ms)}ms`}
            </span>
          )}
          {entry.fallback_used && <Badge>keyword</Badge>}
          <span style={{ color: 'var(--text-muted)' }}>{timeAgo(entry.created_at)}</span>
        </span>
      </button>
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function Ask() {
  const { isDemo } = useAuth()

  const [question, setQuestion] = useState('')
  /** The question the currently displayed result belongs to. */
  const [asked, setAsked] = useState<string | null>(null)
  const [result, setResult] = useState<NlQueryResult | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [pending, setPending] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [showPlan, setShowPlan] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  const history = useAsync<NlQueryLogEntry[]>(() => api.ai.queryHistory(), [])
  const historyReload = history.reload

  // Abort an in-flight question if the screen goes away mid-answer.
  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )

  // Elapsed seconds drive the stage label. There is no progress channel on a single
  // POST, so the stages are timed — and the UI says so rather than implying otherwise.
  useEffect(() => {
    if (!pending) return
    const started = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 250)
    return () => window.clearInterval(timer)
  }, [pending])

  const run = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text) return
      abortRef.current?.abort()

      const controller = new AbortController()
      abortRef.current = controller

      setQuestion(text)
      setAsked(text)
      setResult(null)
      setError(null)
      setCancelled(false)
      setElapsed(0)
      setPending(true)

      try {
        const res = await api.ai.query(text, controller.signal)
        if (controller.signal.aborted) return
        setResult(res)
        historyReload()
      } catch (err) {
        if (controller.signal.aborted) setCancelled(true)
        else setError(err as Error)
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null
          setPending(false)
        }
      }
    },
    [historyReload]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const stage = elapsed < PLAN_STAGE_SECONDS ? 'planning' : 'running'
  const rejected = Boolean(result && result.success === false)
  const rejection = result?.reason || result?.error || null

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="mb-4">
        <h1 className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Ask your fleet
        </h1>
        <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Ask in English. Claude turns the question into a constrained JSON query plan; Xano validates every field in
          that plan against an allowlist and executes it against your live telemetry. The plan ships with every
          answer, so you can check what was actually run.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* ------------------------------------------------------------------ */}
        {/* Console                                                            */}
        {/* ------------------------------------------------------------------ */}
        <div className="min-w-0 space-y-4">
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(question)
              }}
            >
              <label htmlFor="nerve-ask" className="sr-only">
                Ask a question about your fleet
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <input
                  id="nerve-ask"
                  autoFocus
                  autoComplete="off"
                  value={question}
                  disabled={pending}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Which freezers drifted above -15C in the last 6 hours?"
                  className="min-w-0 flex-1 rounded-[8px] border px-3.5 py-3 text-[16px] outline-none disabled:opacity-60"
                  style={{
                    background: 'var(--surface-1)',
                    borderColor: 'var(--surface-3)',
                    color: 'var(--text-primary)',
                  }}
                />
                <button
                  type="submit"
                  disabled={pending || !question.trim()}
                  className={`inline-flex items-center justify-center gap-2 rounded-[8px] border px-6 py-3 text-[15px] font-semibold ${
                    pending || !question.trim() ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:opacity-85'
                  }`}
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'transparent' }}
                >
                  {pending && <Spinner size={14} />}
                  Ask
                </button>
              </div>
            </form>

            <div className="mt-3">
              <p className="mb-1.5 text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                Try one of these
              </p>
              <ul className="flex list-none flex-wrap gap-1.5 p-0">
                {EXAMPLES.map((ex) => (
                  <li key={ex}>
                    <button
                      onClick={() => void run(ex)}
                      disabled={pending}
                      className={`rounded-full border px-3 py-1.5 text-[12px] ${
                        pending ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:opacity-80'
                      }`}
                      style={{
                        background: 'var(--surface-2)',
                        borderColor: 'var(--surface-3)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {ex}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Ask only reads. It never writes a device, rule or command
              {isDemo ? ', which is why it stays enabled on the shared demo account' : ''}.
            </p>
          </Card>

          {/* Pending — named stages, not an unexplained spinner. */}
          {pending && (
            <Card>
              <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
                <span style={{ color: 'var(--accent)' }}>
                  <Spinner size={18} />
                </span>
                <span className="min-w-[200px] flex-1">
                  <span className="block text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {stage === 'planning' ? 'Planning the query' : 'Running the plan'}
                  </span>
                  <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {stage === 'planning'
                      ? 'Claude is turning your question into a JSON plan — entity, filters, time range, aggregate.'
                      : 'Xano is validating the plan against the field allowlist and executing it against your rows.'}
                  </span>
                </span>
                <span className="num-tabular text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  {elapsed}s
                </span>
                <Button size="sm" onClick={cancel}>
                  Cancel
                </Button>
              </div>
              <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Two model calls, so five to fifteen seconds is normal. The stage labels are timed from the request —
                the endpoint replies once, after both steps.
              </p>
            </Card>
          )}

          {cancelled && (
            <Banner tone="warning" onDismiss={() => setCancelled(false)}>
              Cancelled. The request was aborted in the browser; the backend may still have finished planning and is
              free to log it.
            </Banner>
          )}

          {error && !pending && (
            <ErrorState
              error={error as Error & { status?: number; isRateLimit?: boolean }}
              onRetry={asked ? () => void run(asked) : undefined}
            />
          )}

          {/* Answer, results, plan — in that order. */}
          {result && !pending && (
            <div className="space-y-4">
              <Card>
                {asked && (
                  <>
                    <p className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                      You asked
                    </p>
                    <p className="mt-0.5 text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                      {asked}
                    </p>
                  </>
                )}

                {rejected ? (
                  <div className="mt-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge tone="critical">Plan rejected</Badge>
                      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                        Nothing was executed against your data.
                      </span>
                    </div>
                    <p className="text-[16px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                      {rejection ||
                        'The planner produced something the validator would not accept, so the query was refused rather than run.'}
                    </p>
                    <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      This is the allowlist doing its job — a plan that names a field which is not queryable is
                      refused before execution, not partially run. Try naming the metric or site explicitly, or open
                      the plan below to see which field it reached for.
                    </p>
                  </div>
                ) : (
                  <p
                    className="mt-3 text-[19px] leading-relaxed"
                    style={{ color: 'var(--text-primary)', textWrap: 'pretty' }}
                  >
                    {result.answer ||
                      `The query ran and returned ${(result.row_count ?? result.rows?.length ?? 0).toLocaleString()} rows.`}
                  </p>
                )}

                {result.fallback_used && (
                  <div className="mt-3">
                    <Banner tone="warning">
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        Answered without the model.
                      </span>{' '}
                      The deterministic keyword interpreter built this plan — that is the documented fallback when the
                      model call fails or is rate limited. The rows below are still a real query against your data;
                      only the planning was rule-based, so the phrasing is blunter and unusual questions may be read
                      loosely.
                    </Banner>
                  </div>
                )}
              </Card>

              {!rejected && (
                <Card>
                  <SectionHeader
                    title="Results"
                    subtitle="The rows the validated plan returned, exactly as Xano executed it"
                  />
                  <ResultsSection result={result} />
                </Card>
              )}

              <HowPanel result={result} open={showPlan} onToggle={() => setShowPlan((v) => !v)} />
            </div>
          )}

          {/* Nothing asked yet. */}
          {!result && !pending && !error && !asked && (
            <Card>
              <EmptyState
                title="Ask a question to begin"
                hint="Pick one of the examples above, or type your own — device names, metrics, sites and time windows all work. Every answer arrives with the plan that produced it."
              />
            </Card>
          )}
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Recent questions                                                   */}
        {/* ------------------------------------------------------------------ */}
        <aside className="min-w-0">
          <Card>
            <SectionHeader
              title="Recent questions"
              subtitle="Every query is logged with its plan, rows and latency"
              action={
                <Button size="sm" variant="ghost" onClick={historyReload} title="Refresh history">
                  Refresh
                </Button>
              }
            />

            {history.initial ? (
              <div className="space-y-2">
                <Skeleton height={54} />
                <Skeleton height={54} />
                <Skeleton height={54} />
              </div>
            ) : history.error ? (
              <ErrorState
                error={history.error as Error & { status?: number; isRateLimit?: boolean }}
                onRetry={historyReload}
              />
            ) : !history.data?.length ? (
              <EmptyState
                title="No questions yet"
                hint="Ask something above and it will show up here with its row count and latency — the log is written server-side, so it survives a reload."
              />
            ) : (
              <ul className="max-h-[560px] list-none space-y-1.5 overflow-y-auto p-0">
                {history.data.map((entry) => (
                  <HistoryItem key={entry.id} entry={entry} onRerun={(q) => void run(q)} />
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  )
}
