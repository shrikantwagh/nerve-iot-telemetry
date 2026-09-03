/**
 * Incidents — the triage queue.
 *
 * This screen is the product's argument, so it is deliberately *not* a dense table. The
 * whole pitch is that forty alerts collapse into one incident that already carries a
 * root-cause hypothesis, so each incident gets a card with room for that hypothesis to be
 * read. A row of truncated cells would hide the exact thing worth showing.
 *
 * The AI text is always labelled as AI text, with its confidence beside it, and when the
 * model call failed the card says the analysis is deterministic instead. An unmarked
 * hypothesis is indistinguishable from a fact, and in an incident queue that is dangerous.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { useAction, useAsync } from '../lib/useAsync'
import { useAuth } from '../lib/auth'
import { compact, duration, timeAgo } from '../lib/format'
import type { Incident, IncidentState, Severity } from '../lib/types'
import {
  AiTag,
  ConfidenceMeter,
  AssigneeChip,
  INCIDENT_STATE_LABEL,
  INCIDENT_STATES,
  StateChip,
  isUnresolved,
} from '../components/IncidentUi'
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  SectionHeader,
  Select,
  SeverityBadge,
  Skeleton,
} from '../components/ui'
import { StatTile } from '../components/StatTile'

/** `unresolved` is a UI-side filter, not a backend state — see the note in `params`. */
type StateFilter = IncidentState | 'unresolved' | 'all'
type SeverityFilter = Severity | 'all'

const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: 'unresolved', label: 'Unresolved' },
  ...INCIDENT_STATES.map((s) => ({ value: s as StateFilter, label: INCIDENT_STATE_LABEL[s] })),
  { value: 'all', label: 'All states' },
]

const SEVERITY_OPTIONS: { value: SeverityFilter; label: string }[] = [
  { value: 'all', label: 'All severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
]

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

export default function Incidents() {
  const { can, isDemo } = useAuth()

  const [stateFilter, setStateFilter] = useState<StateFilter>('unresolved')
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [siteId, setSiteId] = useState('')
  const [triageResult, setTriageResult] = useState<string | null>(null)

  const sites = useAsync(() => api.sites.list(), [])

  /**
   * The backend filters by a concrete state, so "Unresolved" — the default, and the only
   * view that matters during triage — is applied here rather than sent as a state the API
   * does not know. Sending `state=unresolved` would silently return everything.
   */
  const incidents = useAsync(
    (signal) =>
      api.incidents.list(
        {
          state: stateFilter === 'unresolved' || stateFilter === 'all' ? undefined : stateFilter,
          severity: severity === 'all' ? undefined : severity,
          site_id: siteId ? Number(siteId) : undefined,
        },
        signal
      ),
    [stateFilter, severity, siteId],
    { pollMs: 30_000 }
  )

  const triage = useAction(async () => {
    const res = await api.ai.triage()
    setTriageResult(
      `Triage complete — ${res.incidents_created} incident${res.incidents_created === 1 ? '' : 's'} created, ` +
        `${res.incidents_touched} updated, ${res.alerts_grouped} alert${
          res.alerts_grouped === 1 ? '' : 's'
        } grouped.`
    )
    incidents.reload()
    return res
  })

  const rows = useMemo(() => {
    const all = incidents.data?.items ?? []
    const filtered = stateFilter === 'unresolved' ? all.filter((i) => isUnresolved(i.state)) : all
    // Worst first, then freshest — the order you would actually work the queue in.
    return filtered.slice().sort((a, b) => {
      const bySeverity = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
      if (bySeverity !== 0) return bySeverity
      return new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime()
    })
  }, [incidents.data, stateFilter])

  const totals = useMemo(() => {
    let critical = 0
    let devices = 0
    let alerts = 0
    let analyzed = 0
    for (const i of rows) {
      if (i.severity === 'critical') critical += 1
      devices += i.device_count ?? 0
      alerts += i.alert_count ?? 0
      if (i.ai_root_cause || i.ai_summary) analyzed += 1
    }
    return { critical, devices, alerts, analyzed }
  }, [rows])

  const filtersActive = stateFilter !== 'unresolved' || severity !== 'all' || siteId !== ''

  const siteOptions = [
    { value: '', label: 'All sites' },
    ...(sites.data ?? []).map((s) => ({ value: String(s.id), label: s.name })),
  ]

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <SectionHeader
        title="Incidents"
        subtitle={
          rows.length > 0
            ? `${compact(totals.alerts)} correlated alert${totals.alerts === 1 ? '' : 's'} collapsed into ${
                rows.length
              } incident${rows.length === 1 ? '' : 's'}.`
            : 'Alerts are clustered into incidents by site, device type, metric and time window.'
        }
        action={
          can('operator') ? (
            <Button
              variant="primary"
              onClick={() => triage.run()}
              pending={triage.pending}
              disabled={isDemo}
              title={
                isDemo
                  ? 'Disabled on the shared demo account so the live fleet stays intact.'
                  : 'Cluster the currently firing alerts and generate root-cause hypotheses now.'
              }
            >
              {triage.pending ? 'Correlating alerts…' : 'Run triage now'}
            </Button>
          ) : undefined
        }
      />

      {triage.pending && (
        <Banner tone="accent">
          Correlating firing alerts and asking the model for a root cause on each new cluster. This
          runs two model calls per incident, so it can take a minute.
        </Banner>
      )}
      {triage.error && (
        <Banner tone="critical" onDismiss={triage.clearError}>
          Triage failed: {triage.error}
        </Banner>
      )}
      {triageResult && !triage.pending && (
        <Banner tone="accent" onDismiss={() => setTriageResult(null)}>
          {triageResult}
        </Banner>
      )}

      {/* Filters */}
      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="State">
            <Select
              value={stateFilter}
              onChange={(v) => setStateFilter(v as StateFilter)}
              options={STATE_OPTIONS}
            />
          </Field>
          <Field label="Severity">
            <Select
              value={severity}
              onChange={(v) => setSeverity(v as SeverityFilter)}
              options={SEVERITY_OPTIONS}
            />
          </Field>
          <Field label="Site" hint={sites.error ? 'Site list unavailable — showing all sites.' : undefined}>
            <Select value={siteId} onChange={setSiteId} options={siteOptions} disabled={!sites.data} />
          </Field>
        </div>
        {filtersActive && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Filters applied.
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStateFilter('unresolved')
                setSeverity('all')
                setSiteId('')
              }}
            >
              Reset to unresolved
            </Button>
          </div>
        )}
      </Card>

      {/* The shape of the queue, in four numbers. */}
      {!incidents.initial && !incidents.error && rows.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Incidents in view"
            value={rows.length}
            hint={stateFilter === 'unresolved' ? 'unresolved' : INCIDENT_STATE_LABEL[stateFilter as IncidentState] ?? 'all states'}
          />
          <StatTile
            label="Critical"
            value={totals.critical}
            accent={totals.critical > 0 ? 'var(--status-critical)' : undefined}
            hint="need attention first"
          />
          <StatTile label="Devices affected" value={totals.devices} hint="across all incidents in view" />
          <StatTile
            label="Alerts correlated"
            value={totals.alerts}
            hint={`${totals.analyzed} of ${rows.length} carry an AI analysis`}
          />
        </div>
      )}

      {/* The queue */}
      {incidents.initial ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <div className="flex flex-col gap-3">
                <Skeleton height={18} width="46%" />
                <Skeleton height={12} width="28%" />
                <Skeleton height={44} />
              </div>
            </Card>
          ))}
        </div>
      ) : incidents.error ? (
        <ErrorState error={incidents.error} onRetry={incidents.reload} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title={filtersActive ? 'No incidents match these filters' : 'Nothing needs your attention'}
            hint={
              filtersActive
                ? 'Widen the filters — reset State to Unresolved and clear the site to see the whole queue.'
                : 'Firing alerts are clustered into incidents every two minutes. If alerts are firing but no incident has formed yet, run triage to correlate them now.'
            }
            action={
              filtersActive ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setStateFilter('unresolved')
                    setSeverity('all')
                    setSiteId('')
                  }}
                >
                  Reset filters
                </Button>
              ) : can('operator') ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => triage.run()}
                  pending={triage.pending}
                  disabled={isDemo}
                  title={isDemo ? 'Disabled on the shared demo account.' : undefined}
                >
                  Run triage now
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((incident) => (
            <li key={incident.id}>
              <IncidentCard incident={incident} />
            </li>
          ))}
        </ul>
      )}

      {!incidents.initial && !incidents.error && rows.length > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Refreshed {timeAgo(new Date().toISOString())} · updates every 30 seconds while this tab is visible.
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* One incident                                                               */
/* -------------------------------------------------------------------------- */

function IncidentCard({ incident }: { incident: Incident }) {
  const resolved = incident.state === 'resolved'
  const age = duration(incident.opened_at, incident.resolved_at)
  const hasAi = Boolean(incident.ai_summary || incident.ai_root_cause)

  const scope = [
    `${incident.device_count ?? 0} device${(incident.device_count ?? 0) === 1 ? '' : 's'}`,
    `${incident.alert_count ?? 0} alert${(incident.alert_count ?? 0) === 1 ? '' : 's'}`,
    incident.site_name ?? 'site unknown',
  ].join(' · ')

  return (
    <Link
      to={`/incidents/${incident.id}`}
      className="block rounded-[10px] no-underline transition-opacity hover:opacity-95"
      style={{ color: 'inherit' }}
    >
      <Card
        style={{
          // A hairline of severity down the leading edge: it makes the queue scannable
          // without painting the title text a color that would fail on its own.
          borderLeftWidth: 3,
          borderLeftColor: resolved
            ? 'var(--surface-3)'
            : incident.severity === 'critical'
              ? 'var(--status-critical)'
              : incident.severity === 'warning'
                ? 'var(--status-warning)'
                : 'var(--text-muted)',
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <SeverityBadge severity={incident.severity} />
              <StateChip state={incident.state} />
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                #{incident.id}
              </span>
            </div>
            <h3
              className="text-[15px] leading-snug font-semibold"
              style={{ color: 'var(--text-primary)' }}
            >
              {incident.title}
            </h3>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {scope}
            </p>
          </div>

          <div className="shrink-0 text-right">
            <p className="num-tabular text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {age}
            </p>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {resolved ? 'time to resolve' : 'open'}
            </p>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              opened {timeAgo(incident.opened_at)}
            </p>
          </div>
        </div>

        {/* The hypothesis. Recessed panel so it reads as a quotation, not as the app's
            own assertion. */}
        {hasAi ? (
          <div
            className="mt-3 rounded-[8px] px-3 py-2.5"
            style={{ background: 'var(--surface-2)' }}
          >
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <AiTag>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {incident.ai_fallback_used ? 'Deterministic correlation' : 'Root-cause hypothesis'}
                </span>
              </AiTag>
              <ConfidenceMeter value={incident.ai_confidence} compactLayout width={56} />
            </div>
            <p
              className="line-clamp-3 text-[13px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              {incident.ai_summary || incident.ai_root_cause}
            </p>
            {incident.ai_fallback_used && (
              <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Computed from the correlated alerts by the deterministic analyzer — not written by a
                model.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-3 rounded-[8px] px-3 py-2.5" style={{ background: 'var(--surface-2)' }}>
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              No analysis yet. Open the incident and run Re-analyze to generate a root-cause
              hypothesis from its alerts.
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <AssigneeChip name={incident.assignee_name} id={incident.assigned_to} />
            {incident.correlation_reason && (
              <Badge>{`Grouped: ${incident.correlation_reason}`}</Badge>
            )}
          </div>
          <span className="text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
            View incident →
          </span>
        </div>
      </Card>
    </Link>
  )
}
