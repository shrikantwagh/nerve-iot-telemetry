/**
 * Alerts — the triage queue.
 *
 * This screen is optimised for one job: working a backlog down to zero. That drives three
 * decisions worth naming.
 *
 * 1. **Selection is independent of data.** The queue polls every 20s, and a poll that
 *    wiped your checkboxes would make bulk ack unusable on a live fleet. Checked ids live
 *    in their own state and survive every refresh; they are cleared only when the filter
 *    changes (a different question) or after a bulk action (the work is done).
 * 2. **Only firing alerts get a checkbox.** Bulk ack on an already-resolved alert is a
 *    request the backend would reject, so the UI does not offer it.
 * 3. **Observed value and threshold are printed together** (`47.2 / limit 40`). A triage
 *    queue that makes you subtract two numbers to see how bad a breach is has moved the
 *    work onto the reader.
 *
 * The ungrouped counter is a product claim, not decoration: the pitch is that AI
 * correlation collapses a wall of alerts into a handful of incidents, so a screen full of
 * ungrouped alerts is itself the signal that correlation has not run.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import type { Alert, AlertState, Severity } from '../lib/types'
import { dateTime, num, timeAgo } from '../lib/format'
import { useAction, useAsync } from '../lib/useAsync'
import { useAuth } from '../lib/auth'
import {
  Badge,
  Banner,
  Button,
  Card,
  Cell,
  EmptyState,
  ErrorState,
  Field,
  Select,
  SectionHeader,
  Segmented,
  SeverityBadge,
  Skeleton,
  Table,
} from '../components/ui'
import { StatTile } from '../components/StatTile'

/* -------------------------------------------------------------------------- */
/* Filter vocabulary                                                          */
/* -------------------------------------------------------------------------- */

type StateView = 'firing' | 'acknowledged' | 'resolved' | 'all'

const STATE_VIEWS: { value: StateView; label: string }[] = [
  { value: 'firing', label: 'Firing' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
]

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
]

const WINDOW_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: 'Last hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '24', label: 'Last 24 hours' },
  { value: '168', label: 'Last 7 days' },
  { value: '720', label: 'Last 30 days' },
  { value: '', label: 'All time' },
]

const PER_PAGE = 50

const STATE_BADGE: Record<AlertState, { tone: 'critical' | 'warning' | 'good'; label: string }> = {
  firing: { tone: 'critical', label: 'Firing' },
  acknowledged: { tone: 'warning', label: 'Acked' },
  resolved: { tone: 'good', label: 'Resolved' },
}

const isoHoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

/**
 * Adaptive precision: a temperature reads as `-18.4`, a pressure as `1013`, a current as
 * `0.42`. One fixed digit count would misprint two of the three.
 */
function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  return num(v, abs >= 100 ? 0 : abs >= 10 ? 1 : 2)
}

/**
 * Merge a server response into a row without letting absent keys erase the joined fields
 * (`device_name`, `site_name`) that the list endpoint supplies and the ack endpoint may
 * not. A naive spread would blank the device column on every ack.
 */
function mergeDefined(base: Alert, patch: Partial<Alert>): Alert {
  const out: Alert = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v
  }
  return out
}

/** Native checkbox, themed via accent-color so it follows light/dark. */
function CheckBox({
  checked,
  indeterminate = false,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  disabled?: boolean
  label: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
      title={label}
      className={`h-3.5 w-3.5 align-middle ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
      style={{ accentColor: 'var(--accent)' }}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function Alerts() {
  const { can, isDemo, user } = useAuth()

  // Role gating. A demo account still sees the controls — disabled, with the reason — so
  // the capability is visible without letting a shared login mutate the live fleet.
  const canAct = can('operator')
  const showActions = canAct || isDemo
  const actionsDisabled = !canAct || isDemo
  const disabledReason = isDemo
    ? 'Disabled on the shared demo account so the live fleet stays intact.'
    : 'Acknowledging and resolving alerts requires the operator role.'

  const [stateView, setStateView] = useState<StateView>('firing')
  const [severity, setSeverity] = useState('')
  const [siteId, setSiteId] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [windowHours, setWindowHours] = useState('24')
  const [page, setPage] = useState(1)

  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [busy, setBusy] = useState<Set<number>>(() => new Set())
  const [actionError, setActionError] = useState<string | null>(null)

  /* ----- Filter option sources. Fetched once, unpolled: sites and devices do not
     change on a triage timescale, and this instance is rate-limited. ----- */
  const sitesQ = useAsync(() => api.sites.list(), [])
  const devicesQ = useAsync((signal) => api.devices.list({ per_page: 200, sort: 'name' }, signal), [])

  /* ----- The queue itself ----- */
  const list = useAsync(
    (signal) =>
      api.alerts.list(
        {
          state: stateView === 'all' ? undefined : stateView,
          severity: severity || undefined,
          site_id: siteId ? Number(siteId) : undefined,
          device_id: deviceId ? Number(deviceId) : undefined,
          // Recomputed on every fetch rather than captured in a dep, so a 20s poll gives
          // a sliding window instead of a frozen one.
          since: windowHours ? isoHoursAgo(Number(windowHours)) : undefined,
          page,
          per_page: PER_PAGE,
        },
        signal
      ),
    [stateView, severity, siteId, deviceId, windowHours, page],
    { pollMs: 20_000 }
  )

  const rows = list.data?.items ?? []
  const total = list.data?.itemsTotal
  const pageTotal = list.data?.pageTotal ?? 1

  // A filter change is a different question, so the old selection no longer applies.
  // Crucially this does NOT depend on the data, so polling never clears it.
  useEffect(() => {
    setSelected(new Set())
    setActionError(null)
  }, [stateView, severity, siteId, deviceId, windowHours, page])

  // Reset to page 1 whenever the filters narrow, so you are never stranded on page 4 of a
  // one-page result.
  useEffect(() => {
    setPage(1)
  }, [stateView, severity, siteId, deviceId, windowHours])

  const filtersNarrowed = Boolean(severity || siteId || deviceId) || windowHours !== '24'

  /* ----- Reassuring empty state. The resolved-count request is made only when the queue
     is genuinely clear and unfiltered — an empty *filtered* queue is not good news, and
     on a rate-limited instance a speculative extra call is a real cost. ----- */
  const queueIsClear =
    !list.initial && !list.error && rows.length === 0 && stateView === 'firing' && !filtersNarrowed
  const resolvedRecently = useAsync(
    (signal) => api.alerts.list({ state: 'resolved', since: isoHoursAgo(24), per_page: 1 }, signal),
    [queueIsClear],
    { enabled: queueIsClear }
  )

  /* ----- Derived counts ----- */
  const ackable = useMemo(() => rows.filter((r) => r.state === 'firing'), [rows])
  const criticalOnPage = rows.filter((r) => r.severity === 'critical').length
  const ungroupedOnPage = rows.filter((r) => !r.incident_id).length
  const selectedOnPage = ackable.filter((r) => selected.has(r.id)).length
  const allPageSelected = ackable.length > 0 && selectedOnPage === ackable.length

  const deviceOptions = useMemo(() => {
    const all = devicesQ.data?.items ?? []
    const scoped = siteId ? all.filter((d) => String(d.site_id) === siteId) : all
    return [
      { value: '', label: devicesQ.error ? 'Devices unavailable' : 'Any device' },
      ...scoped.map((d) => ({ value: String(d.id), label: `${d.name} · ${d.serial}` })),
    ]
  }, [devicesQ.data, devicesQ.error, siteId])

  const siteOptions = useMemo(
    () => [
      { value: '', label: sitesQ.error ? 'Sites unavailable' : 'Any site' },
      ...(sitesQ.data ?? []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.code})` })),
    ],
    [sitesQ.data, sitesQ.error]
  )

  /* ----- Mutations ----- */

  const patchRow = (id: number, patch: Partial<Alert>) =>
    list.setData((prev) =>
      prev ? { ...prev, items: prev.items.map((r) => (r.id === id ? mergeDefined(r, patch) : r)) } : prev
    )

  /**
   * Per-row ack/resolve. Optimistic: the row's new state is painted from the response
   * without re-fetching, so working down a page of twenty alerts does not cost twenty
   * round-trips of visible flicker. The 20s poll is the reconciler.
   */
  async function rowAction(id: number, kind: 'ack' | 'resolve') {
    setBusy((s) => new Set(s).add(id))
    setActionError(null)
    try {
      const updated = kind === 'ack' ? await api.alerts.ack(id) : await api.alerts.resolve(id)
      patchRow(id, updated)
      if (kind === 'resolve') {
        setSelected((s) => {
          if (!s.has(id)) return s
          const next = new Set(s)
          next.delete(id)
          return next
        })
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }

  const bulkAck = useAction(async (ids: number[]) => {
    const res = await api.alerts.bulkAck(ids)
    return res
  })

  async function runBulkAck() {
    const ids = Array.from(selected)
    if (!ids.length) return
    setActionError(null)
    const res = await bulkAck.run(ids)
    if (!res) return
    // Paint the outcome immediately, then reconcile — a bulk write can touch incident
    // grouping and health, and only the server knows the final shape.
    const now = new Date().toISOString()
    list.setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((r) =>
              selected.has(r.id) && r.state === 'firing'
                ? { ...r, state: 'acknowledged' as AlertState, acknowledged_at: now, acked_by_name: user?.name }
                : r
            ),
          }
        : prev
    )
    setSelected(new Set())
    list.reload()
  }

  const toggleRow = (id: number) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAllOnPage = () =>
    setSelected((s) => {
      const next = new Set(s)
      if (allPageSelected) ackable.forEach((r) => next.delete(r.id))
      else ackable.forEach((r) => next.add(r.id))
      return next
    })

  const resetFilters = () => {
    setSeverity('')
    setSiteId('')
    setDeviceId('')
    setWindowHours('24')
  }

  /* ------------------------------------------------------------------------ */
  /* Render                                                                   */
  /* ------------------------------------------------------------------------ */

  const windowLabel = WINDOW_OPTIONS.find((w) => w.value === windowHours)?.label ?? 'Last 24 hours'

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Triage queue"
        subtitle={
          <>
            Every threshold breach and statistical anomaly, newest first. Refreshes every 20 seconds; your
            selection is kept across refreshes.
          </>
        }
        action={
          <Button size="sm" variant="ghost" onClick={list.reload} pending={list.loading && !list.initial}>
            Refresh
          </Button>
        }
      />

      {/* Summary strip. Page-scoped numbers say so — a tile that silently means
          "on this page" while looking fleet-wide is a lie with a border round it. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label={stateView === 'all' ? 'Matching alerts' : `${STATE_VIEWS.find((v) => v.value === stateView)?.label} alerts`}
          value={list.initial ? '—' : (total ?? rows.length)}
          hint={windowLabel.toLowerCase()}
        />
        <StatTile
          label="Critical on this page"
          value={list.initial ? '—' : criticalOnPage}
          accent={criticalOnPage > 0 ? 'var(--status-critical)' : undefined}
          hint={`of ${rows.length} shown`}
        />
        <StatTile
          label="Ungrouped on this page"
          value={list.initial ? '—' : ungroupedOnPage}
          accent={ungroupedOnPage > 0 ? 'var(--status-serious)' : undefined}
          hint="not yet part of an incident"
        />
      </div>

      {/* The correlation claim, stated only when the evidence is on screen. */}
      {!list.initial && rows.length >= 4 && ungroupedOnPage > rows.length / 2 && (
        <Banner tone="warning">
          <strong style={{ color: 'var(--text-primary)' }}>
            {ungroupedOnPage} of {rows.length} alerts here belong to no incident.
          </strong>{' '}
          Correlation is what turns a wall of alerts into one thing to fix. The correlation task runs every two
          minutes; if this stays high, the alerts are genuinely unrelated — or the rules are too chatty.
        </Banner>
      )}

      {(actionError || bulkAck.error) && (
        <Banner tone="critical" onDismiss={() => {
          setActionError(null)
          bulkAck.clearError()
        }}>
          <strong style={{ color: 'var(--status-critical)' }}>Action failed.</strong>{' '}
          {actionError || bulkAck.error}
        </Banner>
      )}

      {/* Filters */}
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented value={stateView} onChange={setStateView} options={STATE_VIEWS} />
            {filtersNarrowed && (
              <Button size="sm" variant="ghost" onClick={resetFilters}>
                Clear filters
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Severity">
              <Select value={severity} onChange={setSeverity} options={SEVERITY_OPTIONS} />
            </Field>
            <Field label="Site">
              <Select
                value={siteId}
                onChange={(v) => {
                  setSiteId(v)
                  setDeviceId('')
                }}
                options={siteOptions}
                disabled={sitesQ.initial}
              />
            </Field>
            <Field label="Device" hint={siteId ? 'Narrowed to the selected site.' : undefined}>
              <Select value={deviceId} onChange={setDeviceId} options={deviceOptions} disabled={devicesQ.initial} />
            </Field>
            <Field label="Fired within">
              <Select value={windowHours} onChange={setWindowHours} options={WINDOW_OPTIONS} />
            </Field>
          </div>
        </div>
      </Card>

      {/* Bulk action bar. Appears only with a selection, and states the count it will act
          on — a bulk button that does not say how much it will change is a trap. */}
      {showActions && selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-[10px] border px-3 py-2"
          style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}
        >
          <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            <span className="num-tabular">{selected.size}</span> alert{selected.size === 1 ? '' : 's'} selected
          </span>
          {selectedOnPage !== selected.size && (
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <span className="num-tabular">{selectedOnPage}</span> on this page
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={runBulkAck}
              pending={bulkAck.pending}
              disabled={actionsDisabled}
              title={actionsDisabled ? disabledReason : `Acknowledge ${selected.size} alerts`}
            >
              Acknowledge {selected.size}
            </Button>
          </span>
        </div>
      )}

      {/* Queue */}
      <Card padded={false}>
        {list.initial ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} height={34} />
            ))}
          </div>
        ) : list.error ? (
          <div className="p-4">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-2">
            {queueIsClear ? (
              <EmptyState
                title="Nothing is firing."
                hint={
                  <>
                    The fleet is inside every threshold and baseline it has a rule for.
                    {resolvedRecently.data?.itemsTotal !== undefined && resolvedRecently.data.itemsTotal > 0 && (
                      <>
                        {' '}
                        <span style={{ color: 'var(--text-primary)' }}>
                          {resolvedRecently.data.itemsTotal} alert
                          {resolvedRecently.data.itemsTotal === 1 ? '' : 's'} resolved in the last 24 hours.
                        </span>
                      </>
                    )}{' '}
                    New breaches land here within a minute of the reading that causes them.
                  </>
                }
                action={
                  <Button size="sm" variant="ghost" onClick={() => setStateView('all')}>
                    Show all alerts
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No alerts match these filters."
                hint={`No ${stateView === 'all' ? '' : `${stateView} `}alerts ${
                  windowHours ? `in the ${windowLabel.replace(/^Last /, 'last ')}` : 'on record'
                } for this severity, site and device. Widen the time window or clear the filters to see the rest of the queue.`}
                action={
                  filtersNarrowed ? (
                    <Button size="sm" onClick={resetFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            )}
          </div>
        ) : (
          <>
            <Table
              head={[
                // The header cells are built conditionally rather than blanked out, so the
                // column count always matches the body for a viewer with no actions.
                ...(showActions
                  ? [
                      <CheckBox
                        key="all"
                        checked={allPageSelected}
                        indeterminate={selectedOnPage > 0}
                        onChange={toggleAllOnPage}
                        disabled={ackable.length === 0}
                        label={
                          ackable.length === 0
                            ? 'No firing alerts on this page to select'
                            : allPageSelected
                              ? 'Clear selection on this page'
                              : `Select all ${ackable.length} firing alerts on this page`
                        }
                      />,
                    ]
                  : []),
                'Severity',
                'Device',
                'Metric',
                'Observed',
                'z-score',
                'Message',
                'Fired',
                'Incident',
                'State',
                ...(showActions ? ['Actions'] : []),
              ]}
            >
              {rows.map((a) => {
                const rowBusy = busy.has(a.id)
                const isSelected = selected.has(a.id)
                const state = STATE_BADGE[a.state] ?? STATE_BADGE.firing
                return (
                  <tr
                    key={a.id}
                    style={{
                      borderColor: 'var(--surface-3)',
                      background: isSelected ? 'var(--accent-soft)' : 'transparent',
                    }}
                  >
                    {showActions && (
                      <Cell nowrap>
                        {a.state === 'firing' ? (
                          <CheckBox
                            checked={isSelected}
                            onChange={() => toggleRow(a.id)}
                            label={`Select alert ${a.id} on ${a.device_name ?? `device ${a.device_id}`}`}
                          />
                        ) : (
                          <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
                            —
                          </span>
                        )}
                      </Cell>
                    )}

                    <Cell nowrap>
                      <SeverityBadge severity={a.severity as Severity} />
                    </Cell>

                    <Cell nowrap>
                      <Link
                        to={`/devices/${a.device_id}`}
                        className="font-medium hover:underline"
                        style={{ color: 'var(--accent)' }}
                      >
                        {a.device_name ?? `Device ${a.device_id}`}
                      </Link>
                      {a.site_name && (
                        <span className="ml-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {a.site_name}
                        </span>
                      )}
                    </Cell>

                    <Cell nowrap muted>
                      <span className="font-mono text-[12px]" style={{ fontFamily: 'var(--mono)' }}>
                        {a.metric_key ?? '—'}
                      </span>
                    </Cell>

                    {/* Observed vs threshold in one cell: the breach is legible without
                        the reader doing arithmetic. */}
                    <Cell nowrap>
                      <span className="num-tabular font-medium">{fmtNum(a.observed_value)}</span>
                      {a.threshold !== null && a.threshold !== undefined && (
                        <span className="num-tabular ml-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                          / limit {fmtNum(a.threshold)}
                        </span>
                      )}
                    </Cell>

                    <Cell nowrap align="right" muted>
                      {a.z_score !== null && a.z_score !== undefined ? (
                        <span className="num-tabular" title="Standard deviations from this device's own baseline">
                          {num(a.z_score, 1)}σ
                        </span>
                      ) : (
                        '—'
                      )}
                    </Cell>

                    <Cell muted>
                      <span className="block max-w-[26rem] truncate" title={a.message ?? undefined}>
                        {a.message || a.rule_name || '—'}
                      </span>
                    </Cell>

                    <Cell nowrap muted>
                      <span title={dateTime(a.fired_at)}>{timeAgo(a.fired_at)}</span>
                    </Cell>

                    <Cell nowrap>
                      {a.incident_id ? (
                        <Link
                          to={`/incidents/${a.incident_id}`}
                          className="text-[12px] hover:underline"
                          style={{ color: 'var(--accent)' }}
                        >
                          part of incident #{a.incident_id}
                        </Link>
                      ) : (
                        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                          ungrouped
                        </span>
                      )}
                    </Cell>

                    <Cell nowrap>
                      <Badge tone={state.tone}>{state.label}</Badge>
                      {a.state === 'acknowledged' && a.acked_by_name && (
                        <span className="ml-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {a.acked_by_name}
                        </span>
                      )}
                    </Cell>

                    {showActions && (
                      <Cell nowrap align="right">
                        <span className="inline-flex gap-1.5">
                          {a.state === 'firing' && (
                            <Button
                              size="sm"
                              onClick={() => rowAction(a.id, 'ack')}
                              pending={rowBusy}
                              disabled={actionsDisabled}
                              title={actionsDisabled ? disabledReason : 'Acknowledge — you are on it'}
                            >
                              Ack
                            </Button>
                          )}
                          {a.state !== 'resolved' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => rowAction(a.id, 'resolve')}
                              pending={rowBusy}
                              disabled={actionsDisabled}
                              title={actionsDisabled ? disabledReason : 'Resolve — the condition is gone'}
                            >
                              Resolve
                            </Button>
                          )}
                        </span>
                      </Cell>
                    )}
                  </tr>
                )
              })}
            </Table>

            <div
              className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2"
              style={{ borderColor: 'var(--surface-3)' }}
            >
              <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                Showing <span className="num-tabular">{rows.length}</span>
                {total !== undefined && (
                  <>
                    {' '}
                    of <span className="num-tabular">{total}</span>
                  </>
                )}{' '}
                · page <span className="num-tabular">{page}</span> of{' '}
                <span className="num-tabular">{pageTotal}</span>
              </span>
              <span className="flex items-center gap-2">
                <Button size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  Previous
                </Button>
                <Button size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= pageTotal}>
                  Next
                </Button>
              </span>
            </div>
          </>
        )}
      </Card>

      {!showActions && !list.initial && rows.length > 0 && (
        <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          You are signed in as a viewer. Acknowledging and resolving alerts requires the operator role.
        </p>
      )}
    </div>
  )
}
