/**
 * Incident detail — diagnosis on the left, evidence on the right, and the fix in the
 * same screen as both.
 *
 * The layout is the argument. Every other tool in this category shows you a red graph and
 * stops: you read the alerts here, form a theory in your head, then go to a different
 * console to act. This page puts the model's hypothesis, the evidence it used, the
 * remediation runbook, and the button that actually issues that remediation to every
 * affected device inside one column of reading. Diagnosis to fix is one motion.
 *
 * Two things are handled carefully rather than conveniently:
 *
 * 1. **Provenance is never implied.** When `ai_fallback_used` is set, the analysis came
 *    from the deterministic analyzer, and the page says so in words. An unlabelled
 *    hypothesis is indistinguishable from a measurement.
 * 2. **The model is slow, and the UI says why.** `/analyze` and `/postmortem` make two
 *    sequential model calls and can run past a minute. A bare spinner for that long reads
 *    as a hang, so both show what is happening and how long it has been going.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import api from '../lib/api'
import { useAction, useAsync } from '../lib/useAsync'
import { useAuth } from '../lib/auth'
import { dateTime, duration, num, seriesColorFor, timeAgo } from '../lib/format'
import type {
  Alert,
  CommandName,
  Incident,
  IncidentState,
  MetricSchemaEntry,
  Severity,
} from '../lib/types'
import {
  AiProvenance,
  AiTag,
  AssigneeChip,
  ConfidenceMeter,
  INCIDENT_STATES,
  INCIDENT_STATE_LABEL,
  StateChip,
  remediationParts,
  remediationText,
} from '../components/IncidentUi'
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
  Row,
  SectionHeader,
  Segmented,
  Select,
  SeverityBadge,
  Skeleton,
  StatusDot,
  Table,
} from '../components/ui'
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart'
import type { SeriesSpec } from '../components/charts/TimeSeriesChart'

/* -------------------------------------------------------------------------- */
/* Command vocabulary                                                         */
/* -------------------------------------------------------------------------- */

const COMMAND_LABEL: Record<CommandName, string> = {
  restart: 'Restart',
  firmware_update: 'Push firmware update',
  calibrate: 'Calibrate',
  set_config: 'Apply configuration',
  return_to_dock: 'Return to dock',
  enter_maintenance: 'Enter maintenance',
  clear_fault: 'Clear fault',
}

const COMMAND_ORDER: CommandName[] = [
  'restart',
  'clear_fault',
  'calibrate',
  'return_to_dock',
  'enter_maintenance',
  'firmware_update',
  'set_config',
]

/**
 * Which command the remediation text is actually asking for.
 *
 * The runbook is prose, so this is a keyword match rather than a parse — but pre-selecting
 * the right command is the difference between "the AI suggested a restart" and one click
 * that restarts the fleet. Ordered most-specific first so "push firmware" does not lose to
 * a stray "restart" in the same sentence.
 */
const COMMAND_HINTS: [CommandName, RegExp][] = [
  ['firmware_update', /\bfirmware\b|\bflash\b|\bota\b/i],
  ['return_to_dock', /\bdock(ing)?\b|\brecall\b|\breturn to (the )?(dock|charger)\b/i],
  ['enter_maintenance', /\bmaintenance mode\b|\btake (it |them )?offline\b|\bquarantine\b/i],
  ['calibrate', /\bcalibrat/i],
  ['clear_fault', /\bclear (the )?fault\b|\bfault code\b|\backnowledge the fault\b/i],
  ['set_config', /\bconfig(uration)?\b|\bsetpoint\b|\bthreshold\b/i],
  ['restart', /\brestart\b|\breboot\b|\bpower[- ]cycle\b|\bcycle the\b/i],
]

function suggestCommand(incident: Incident | null): CommandName | null {
  if (!incident) return null

  // Some deployments return an explicit shortlist. Prefer it over guessing from prose.
  const explicit = (incident as Incident & { suggested_commands?: unknown }).suggested_commands
  if (Array.isArray(explicit)) {
    const match = explicit.find((c): c is CommandName => typeof c === 'string' && c in COMMAND_LABEL)
    if (match) return match
  }

  const haystack = [
    remediationText(incident.ai_remediation),
    incident.ai_root_cause ?? '',
    incident.ai_summary ?? '',
  ].join(' ')
  if (!haystack.trim()) return null

  for (const [command, pattern] of COMMAND_HINTS) {
    if (pattern.test(haystack)) return command
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function IncidentDetail() {
  const { incidentId } = useParams()
  const id = Number(incidentId)
  const valid = Number.isFinite(id) && id > 0

  const { can, isDemo } = useAuth()
  const [editingTitle, setEditingTitle] = useState(false)

  const incident = useAsync((signal) => api.incidents.get(id, signal), [id], {
    enabled: valid,
    // Polling pauses while the title is being edited, so a refresh cannot yank the
    // field out from under someone mid-sentence.
    pollMs: editingTitle ? undefined : 30_000,
  })

  const data = incident.data

  if (!valid) {
    return (
      <Card>
        <EmptyState
          title="That is not an incident id"
          hint={`"${incidentId ?? ''}" is not a number. Incident links look like /incidents/42.`}
          action={
            <Link to="/incidents" className="text-[13px] font-medium" style={{ color: 'var(--accent)' }}>
              Back to incidents
            </Link>
          }
        />
      </Card>
    )
  }

  if (incident.initial) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col gap-4" aria-busy="true">
        <Card>
          <div className="flex flex-col gap-3">
            <Skeleton height={14} width="24%" />
            <Skeleton height={24} width="60%" />
            <Skeleton height={12} width="40%" />
          </div>
        </Card>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <Card>
            <div className="flex flex-col gap-3">
              <Skeleton height={16} width="30%" />
              <Skeleton height={8} />
              <Skeleton height={72} />
              <Skeleton height={56} />
            </div>
          </Card>
          <Card>
            <div className="flex flex-col gap-3">
              <Skeleton height={16} width="40%" />
              <Skeleton height={96} />
            </div>
          </Card>
        </div>
      </div>
    )
  }

  if (incident.error) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <ErrorState error={incident.error} onRetry={incident.reload} />
        <Link to="/incidents" className="text-[13px] font-medium" style={{ color: 'var(--accent)' }}>
          Back to incidents
        </Link>
      </div>
    )
  }

  if (!data) {
    return (
      <Card>
        <EmptyState
          title="Incident not found"
          hint="It may have been merged into another incident, or pruned by retention. The queue shows what is live."
          action={
            <Link to="/incidents" className="text-[13px] font-medium" style={{ color: 'var(--accent)' }}>
              Back to incidents
            </Link>
          }
        />
      </Card>
    )
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <IncidentHeader
        incident={data}
        canEdit={can('operator')}
        isDemo={isDemo}
        editingTitle={editingTitle}
        setEditingTitle={setEditingTitle}
        onChanged={incident.reload}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {/* Left: the analysis */}
        <div className="flex min-w-0 flex-col gap-4">
          <RootCauseCard
            incident={data}
            canAct={can('operator')}
            isDemo={isDemo}
            onChanged={incident.reload}
          />
          <PostmortemCard incident={data} canAct={can('operator')} isDemo={isDemo} />
          <ActOnItCard
            incident={data}
            canAct={can('operator')}
            isDemo={isDemo}
            onChanged={incident.reload}
          />
        </div>

        {/* Right: the evidence */}
        <div className="flex min-w-0 flex-col gap-4">
          <AffectedDevicesCard incident={data} />
          <MemberAlertsCard incident={data} canAct={can('operator')} isDemo={isDemo} onChanged={incident.reload} />
          <AlertTimelineCard alerts={data.alerts ?? []} />
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function IncidentHeader({
  incident,
  canEdit,
  isDemo,
  editingTitle,
  setEditingTitle,
  onChanged,
}: {
  incident: Incident
  canEdit: boolean
  isDemo: boolean
  editingTitle: boolean
  setEditingTitle: (v: boolean) => void
  onChanged: () => void
}) {
  const [draft, setDraft] = useState(incident.title)

  const saveTitle = useAction(async (next: string) => {
    const res = await api.incidents.update(incident.id, { title: next })
    setEditingTitle(false)
    onChanged()
    return res
  })

  const changeState = useAction(async (next: IncidentState) => {
    const res = await api.incidents.update(incident.id, { state: next })
    onChanged()
    return res
  })

  const startEditing = () => {
    setDraft(incident.title)
    setEditingTitle(true)
  }

  const editable = canEdit && !isDemo
  const disabledReason = isDemo
    ? 'Disabled on the shared demo account so the live fleet stays intact.'
    : 'Requires the operator role.'

  return (
    <Card
      style={{
        borderLeftWidth: 3,
        borderLeftColor:
          incident.state === 'resolved'
            ? 'var(--status-good)'
            : incident.severity === 'critical'
              ? 'var(--status-critical)'
              : incident.severity === 'warning'
                ? 'var(--status-warning)'
                : 'var(--text-muted)',
      }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Link
          to="/incidents"
          className="text-[12px] no-underline hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          Incidents
        </Link>
        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          /
        </span>
        <span className="num-tabular text-[12px]" style={{ color: 'var(--text-muted)' }}>
          #{incident.id}
        </span>
        <SeverityBadge severity={incident.severity} />
        <StateChip state={incident.state} />
        {incident.ai_fallback_used && <Badge tone="warning">Deterministic analysis</Badge>}
      </div>

      {editingTitle ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field label="Incident title">
              <Input
                value={draft}
                onChange={setDraft}
                autoFocus
                onEnter={() => {
                  if (draft.trim()) saveTitle.run(draft.trim())
                }}
                disabled={saveTitle.pending}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => draft.trim() && saveTitle.run(draft.trim())}
              pending={saveTitle.pending}
              disabled={!draft.trim() || draft.trim() === incident.title}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditingTitle(false)} disabled={saveTitle.pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-2">
          <h1
            className="min-w-0 text-[20px] leading-snug font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            {incident.title}
          </h1>
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={startEditing}
              disabled={!editable}
              title={editable ? 'Rename this incident' : disabledReason}
            >
              Rename
            </Button>
          )}
        </div>
      )}

      {saveTitle.error && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--status-critical)' }}>
          Could not rename: {saveTitle.error}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Fact label="Opened" value={dateTime(incident.opened_at)} sub={timeAgo(incident.opened_at)} />
        <Fact
          label={incident.resolved_at ? 'Resolved' : 'Open for'}
          value={
            incident.resolved_at ? dateTime(incident.resolved_at) : duration(incident.opened_at, null)
          }
          sub={
            incident.resolved_at
              ? `lasted ${duration(incident.opened_at, incident.resolved_at)}`
              : 'still running'
          }
        />
        <Fact
          label="Scope"
          value={`${incident.device_count ?? 0} device${(incident.device_count ?? 0) === 1 ? '' : 's'}`}
          sub={`${incident.alert_count ?? 0} correlated alert${(incident.alert_count ?? 0) === 1 ? '' : 's'}${
            incident.site_name ? ` · ${incident.site_name}` : ''
          }`}
        />
        <div>
          <dt className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
            Assignee
          </dt>
          <dd className="mt-1">
            <AssigneeChip name={incident.assignee_name} id={incident.assigned_to} />
          </dd>
        </div>
      </dl>

      <div
        className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3"
        style={{ borderColor: 'var(--surface-3)' }}
      >
        <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          State
        </span>
        {canEdit ? (
          <div className="scroll-x">
            <Segmented
              value={incident.state}
              onChange={(next) => {
                if (!isDemo && next !== incident.state) changeState.run(next)
              }}
              options={INCIDENT_STATES.map((s) => ({ value: s, label: INCIDENT_STATE_LABEL[s] }))}
            />
          </div>
        ) : (
          <StateChip state={incident.state} />
        )}
        {changeState.pending && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Saving…
          </span>
        )}
        {!canEdit && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Changing state requires the operator role.
          </span>
        )}
        {canEdit && isDemo && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {disabledReason}
          </span>
        )}
        {incident.correlation_reason && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Grouped because: {incident.correlation_reason}
          </span>
        )}
      </div>

      {changeState.error && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--status-critical)' }}>
          Could not change state: {changeState.error}
        </p>
      )}
    </Card>
  )
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
        {label}
      </dt>
      <dd className="mt-1 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {value}
      </dd>
      {sub && (
        <dd className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </dd>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The centrepiece: AI root cause                                             */
/* -------------------------------------------------------------------------- */

function RootCauseCard({
  incident,
  canAct,
  isDemo,
  onChanged,
}: {
  incident: Incident
  canAct: boolean
  isDemo: boolean
  onChanged: () => void
}) {
  const [done, setDone] = useState<string[]>([])
  // Latency is only on the /analyze response, not on the stored incident, so it is
  // reported for the run you just watched and omitted on a cold page load.
  const [latencyMs, setLatencyMs] = useState<number | null>(null)

  const analyze = useAction(async () => {
    const res = await api.incidents.analyze(incident.id)
    setLatencyMs(typeof res.latency_ms === 'number' ? res.latency_ms : null)
    onChanged()
    return res
  })

  const hasAnalysis = Boolean(incident.ai_root_cause || incident.ai_summary)
  const remediation = incident.ai_remediation ?? []
  const evidence = incident.ai_evidence ?? []

  const reanalyzeButton = canAct ? (
    <Button
      onClick={() => analyze.run()}
      pending={analyze.pending}
      disabled={isDemo}
      variant={hasAnalysis ? 'secondary' : 'primary'}
      title={
        isDemo
          ? 'Disabled on the shared demo account so the live fleet stays intact.'
          : 'Re-read this incident’s alerts and telemetry and regenerate the root cause.'
      }
    >
      {hasAnalysis ? 'Re-analyze' : 'Analyze this incident'}
    </Button>
  ) : undefined

  return (
    <Card>
      <SectionHeader
        title="AI root cause"
        subtitle={
          incident.ai_fallback_used
            ? 'Deterministic correlation of this incident’s alerts — the model call did not return.'
            : 'A hypothesis, drawn from this incident’s alerts and the telemetry around them.'
        }
        action={reanalyzeButton}
      />

      {analyze.error && (
        <div className="mb-3">
          <Banner tone="critical" onDismiss={analyze.clearError}>
            Analysis failed: {analyze.error}. The incident and its alerts are untouched — the previous
            analysis, if any, is still shown below.
          </Banner>
        </div>
      )}

      {analyze.pending ? (
        <ModelWorkingPanel
          headline="The model is working on this incident."
          detail="It is reading every correlated alert, the telemetry window around each one, and the device types involved, then drafting a root cause with evidence and a remediation runbook. Two sequential model calls — usually 20 to 60 seconds, occasionally longer."
        />
      ) : !hasAnalysis ? (
        <EmptyState
          title="No analysis on this incident yet"
          hint={
            canAct
              ? 'Correlation runs every two minutes and analyses new clusters automatically. This one has not been analysed — run it now and the root cause, evidence and remediation appear here.'
              : 'Correlation runs every two minutes and analyses new clusters automatically. Ask an operator to run the analysis if this stays empty.'
          }
          action={reanalyzeButton}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <ConfidenceMeter value={incident.ai_confidence} />

          {/* The hypothesis itself. */}
          <div>
            <div className="mb-1.5">
              <AiTag>
                <span className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                  Hypothesis
                </span>
              </AiTag>
            </div>
            <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
              {incident.ai_root_cause || incident.ai_summary}
            </p>
            {incident.ai_root_cause && incident.ai_summary && incident.ai_summary !== incident.ai_root_cause && (
              <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {incident.ai_summary}
              </p>
            )}
          </div>

          {/* What it based that on. */}
          {evidence.length > 0 && (
            <div>
              <h4
                className="mb-1.5 text-[11px] tracking-wide uppercase"
                style={{ color: 'var(--text-muted)' }}
              >
                Evidence used ({evidence.length})
              </h4>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {evidence.map((line, i) => (
                  <li key={i} className="flex gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    <span
                      aria-hidden="true"
                      className="mt-[7px] inline-block shrink-0 rounded-full"
                      style={{ width: 5, height: 5, background: 'var(--accent)' }}
                    />
                    <span className="min-w-0">{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The runbook. */}
          {remediation.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <h4 className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                  Remediation runbook
                </h4>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {done.length} of {remediation.length} ticked · local to this browser
                </span>
              </div>
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {remediation.map((item, i) => {
                  const { head, detail } = remediationParts(item)
                  const key = `${i}:${head}`
                  const checked = done.includes(key)
                  return (
                    <li key={key}>
                      <label
                        className="flex cursor-pointer gap-2.5 rounded-[8px] px-2.5 py-2"
                        style={{ background: 'var(--surface-2)' }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setDone((prev) =>
                              prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
                            )
                          }
                          className="mt-0.5 shrink-0"
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        <span className="min-w-0">
                          <span
                            className="num-tabular mr-1.5 text-[12px] font-semibold"
                            style={{ color: 'var(--accent)' }}
                          >
                            {i + 1}.
                          </span>
                          <span
                            className="text-[13px]"
                            style={{
                              color: checked ? 'var(--text-muted)' : 'var(--text-primary)',
                              textDecoration: checked ? 'line-through' : undefined,
                            }}
                          >
                            {head}
                          </span>
                          {detail && (
                            <span className="mt-0.5 block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                              {detail}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ol>
            </div>
          )}

          <div className="border-t pt-2.5" style={{ borderColor: 'var(--surface-3)' }}>
            <AiProvenance
              model={incident.ai_model}
              generatedAt={incident.ai_generated_at}
              latencyMs={latencyMs}
              fallbackUsed={incident.ai_fallback_used}
              what="analysis"
            />
          </div>
        </div>
      )}
    </Card>
  )
}

/**
 * The waiting state for a long model call.
 *
 * The elapsed counter is the point: a request that takes ninety seconds with no visible
 * progress is indistinguishable from a hang, and people reload — which loses the call
 * that was about to land.
 */
function ModelWorkingPanel({ headline, detail }: { headline: string; detail: string }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div
      className="rounded-[8px] border px-3.5 py-3"
      style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <span
          className="live-dot inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: 'var(--accent)' }}
          aria-hidden="true"
        />
        <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {headline}
        </p>
        <span className="num-tabular ml-auto text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {detail}
      </p>
      {elapsed > 75 && (
        <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          Still going. The request has its own two-minute ceiling — if the model does not answer, the
          backend falls back to deterministic analysis and you will still get a result.
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Postmortem                                                                 */
/* -------------------------------------------------------------------------- */

function PostmortemCard({
  incident,
  canAct,
  isDemo,
}: {
  incident: Incident
  canAct: boolean
  isDemo: boolean
}) {
  const [text, setText] = useState<string | null>(incident.ai_postmortem ?? null)
  const [meta, setMeta] = useState<{ model?: string; fallbackUsed?: boolean } | null>(
    incident.ai_postmortem ? { model: incident.ai_model ?? undefined, fallbackUsed: incident.ai_fallback_used } : null
  )

  const draft = useAction(async () => {
    const res = await api.incidents.postmortem(incident.id)
    setText(res.ai_postmortem ?? '')
    setMeta({ model: res.model, fallbackUsed: res.fallback_used })
    return res
  })

  /**
   * A postmortem can also arrive from the server — another operator drafts one, or the
   * correlation task writes it — and the page polls every 30s. Without this, the card
   * would keep showing "No postmortem yet" over an incident that has one, because the
   * initial state was captured on mount. `adopted` tracks what we last took from the
   * server so this cannot fight with a draft made in this browser.
   */
  const stored = incident.ai_postmortem ?? null
  const [adopted, setAdopted] = useState<string | null>(stored)
  useEffect(() => {
    if (!stored || stored === adopted) return
    setAdopted(stored)
    setText(stored)
    setMeta({ model: incident.ai_model ?? undefined, fallbackUsed: incident.ai_fallback_used })
  }, [stored, adopted, incident.ai_model, incident.ai_fallback_used])

  const button = canAct ? (
    <Button
      onClick={() => draft.run()}
      pending={draft.pending}
      disabled={isDemo}
      title={
        isDemo
          ? 'Disabled on the shared demo account so the live fleet stays intact.'
          : 'Draft the writeup from this incident’s timeline.'
      }
    >
      {text ? 'Redraft' : 'Draft postmortem'}
    </Button>
  ) : undefined

  return (
    <Card>
      <SectionHeader
        title="Postmortem"
        subtitle="Drafted from the incident timeline — the alerts, their order, and what was done about them."
        action={
          <div className="flex items-center gap-2">
            {text && <CopyButton text={text} label="Copy" />}
            {button}
          </div>
        }
      />

      {draft.error && (
        <div className="mb-3">
          <Banner tone="critical" onDismiss={draft.clearError}>
            Could not draft the postmortem: {draft.error}
          </Banner>
        </div>
      )}

      {draft.pending ? (
        <ModelWorkingPanel
          headline="Drafting the postmortem."
          detail="Reading the incident timeline in order — when each alert fired, which devices it touched, what commands were issued — and writing it up as a summary, impact, timeline and follow-up."
        />
      ) : text ? (
        <>
          <PostmortemText text={text} />
          <div className="mt-3 border-t pt-2.5" style={{ borderColor: 'var(--surface-3)' }}>
            <AiProvenance
              model={meta?.model ?? incident.ai_model}
              generatedAt={incident.ai_generated_at}
              fallbackUsed={meta?.fallbackUsed}
              what="postmortem"
            />
          </div>
        </>
      ) : (
        <EmptyState
          title="No postmortem yet"
          hint={
            canAct
              ? 'Draft one and it is written from this incident’s own timeline — no blank template to fill in. You can copy it straight into your own doc.'
              : 'Drafting a postmortem requires the operator role. Ask an operator to generate one and it will appear here.'
          }
          action={button}
        />
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Postmortem text rendering                                                  */
/* -------------------------------------------------------------------------- */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'ordered'; items: string[] }

/**
 * Parse the postmortem's plain text into blocks.
 *
 * Deliberately not a markdown dependency: the backend emits a handful of shapes —
 * `## Heading`, `**Heading**`, `- bullet`, `1. step`, and paragraphs — and pulling in a
 * parser (plus its sanitizer) to handle five patterns would be more risk than it removes,
 * since a real markdown renderer would also happily render raw HTML from model output.
 */
function parsePostmortem(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')

  let paragraph: string[] = []
  let bullets: string[] = []
  let ordered: string[] = []

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'para', text: paragraph.join(' ') })
      paragraph = []
    }
    if (bullets.length) {
      blocks.push({ kind: 'bullets', items: bullets })
      bullets = []
    }
    if (ordered.length) {
      blocks.push({ kind: 'ordered', items: ordered })
      ordered = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }

    const atx = /^(#{1,6})\s+(.*)$/.exec(line)
    if (atx) {
      flush()
      blocks.push({ kind: 'heading', level: atx[1].length, text: atx[2].trim() })
      continue
    }

    // A line that is nothing but bold text is a heading in practice.
    const boldOnly = /^\s*\*\*(.+?)\*\*:?\s*$/.exec(line)
    if (boldOnly) {
      flush()
      blocks.push({ kind: 'heading', level: 3, text: boldOnly[1].trim() })
      continue
    }

    // A short line ending in a colon, with no sentence after it, is also a heading.
    const colonOnly = /^([A-Z][^.!?:]{2,48}):\s*$/.exec(line.trim())
    if (colonOnly) {
      flush()
      blocks.push({ kind: 'heading', level: 3, text: colonOnly[1].trim() })
      continue
    }

    // A run of bullets is one list; a paragraph or a numbered run before it closes first.
    const bullet = /^\s*[-*•·]\s+(.*)$/.exec(line)
    if (bullet) {
      if (paragraph.length || ordered.length) flush()
      bullets.push(bullet[1].trim())
      continue
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      if (paragraph.length || bullets.length) flush()
      ordered.push(numbered[1].trim())
      continue
    }

    if (bullets.length || ordered.length) flush()
    paragraph.push(line.trim())
  }

  flush()
  return blocks
}

/** Inline `**bold**`, `*italic*` and `` `code` ``. Everything else is literal text. */
function renderInline(text: string) {
  const out: (string | React.ReactElement)[] = []
  const pattern = /\*\*(.+?)\*\*|`([^`]+?)`|(?<!\*)\*([^*]+?)\*(?!\*)/g
  let cursor = 0
  let key = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index))
    if (match[1] !== undefined) {
      out.push(
        <strong key={key++} style={{ color: 'var(--text-primary)' }}>
          {match[1]}
        </strong>
      )
    } else if (match[2] !== undefined) {
      out.push(
        <code
          key={key++}
          className="rounded-[4px] px-1 py-0.5"
          style={{ fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface-2)' }}
        >
          {match[2]}
        </code>
      )
    } else {
      out.push(<em key={key++}>{match[3]}</em>)
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

function PostmortemText({ text }: { text: string }) {
  const blocks = useMemo(() => parsePostmortem(text), [text])

  if (blocks.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
        The postmortem came back empty. Redraft it.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          const size = block.level <= 2 ? 'text-[14px]' : 'text-[13px]'
          return (
            <h4
              key={i}
              className={`${size} mt-1 font-semibold`}
              style={{ color: 'var(--text-primary)' }}
            >
              {block.text}
            </h4>
          )
        }
        if (block.kind === 'bullets') {
          return (
            <ul key={i} className="m-0 flex list-none flex-col gap-1 p-0">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  <span
                    aria-hidden="true"
                    className="mt-[7px] inline-block shrink-0 rounded-full"
                    style={{ width: 5, height: 5, background: 'var(--text-muted)' }}
                  />
                  <span className="min-w-0">{renderInline(item)}</span>
                </li>
              ))}
            </ul>
          )
        }
        if (block.kind === 'ordered') {
          return (
            <ol key={i} className="m-0 flex list-none flex-col gap-1 p-0">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  <span className="num-tabular shrink-0 font-medium" style={{ color: 'var(--text-muted)' }}>
                    {j + 1}.
                  </span>
                  <span className="min-w-0">{renderInline(item)}</span>
                </li>
              ))}
            </ol>
          )
        }
        return (
          <p key={i} className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {renderInline(block.text)}
          </p>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Act on it                                                                  */
/* -------------------------------------------------------------------------- */

function ActOnItCard({
  incident,
  canAct,
  isDemo,
  onChanged,
}: {
  incident: Incident
  canAct: boolean
  isDemo: boolean
  onChanged: () => void
}) {
  const devices = incident.devices ?? []
  const deviceIds = devices.map((d) => d.id)
  const suggested = useMemo(() => suggestCommand(incident), [incident])

  const [picked, setPicked] = useState<CommandName | ''>('')
  const [result, setResult] = useState<string | null>(null)
  const command: CommandName = picked || suggested || 'restart'

  const issue = useAction(async (cmd: CommandName, ids: number[]) => {
    const res = await api.incidents.issueCommands(incident.id, cmd, ids.length ? ids : undefined)
    setResult(
      `Queued ${COMMAND_LABEL[cmd].toLowerCase()} on ${res.created} device${
        res.created === 1 ? '' : 's'
      }. Each device picks it up on its next telemetry poll and acknowledges back.`
    )
    onChanged()
    return res
  })

  const issued = incident.commands ?? []
  const blocked = !canAct || isDemo
  const blockedReason = !canAct
    ? 'Issuing commands requires the operator role.'
    : 'Disabled on the shared demo account so the live fleet stays intact.'

  return (
    <Card>
      <SectionHeader
        title="Act on it"
        subtitle={`Issue one remediation command to every device in this incident${
          deviceIds.length ? ` — all ${deviceIds.length} of them` : ''
        }. Audit-logged, and acknowledged by each device.`}
      />

      {suggested && (
        <div className="mb-3">
          <Banner tone="accent">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <AiTag />
              <span>
                The remediation runbook asks for <strong>{COMMAND_LABEL[suggested]}</strong>, so it is
                pre-selected below.
              </span>
            </span>
          </Banner>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field
          label="Command"
          hint={
            deviceIds.length
              ? `Goes to ${devices
                  .slice(0, 3)
                  .map((d) => d.name)
                  .join(', ')}${deviceIds.length > 3 ? ` and ${deviceIds.length - 3} more` : ''}.`
              : 'This incident has no device list attached, so the backend will resolve the affected devices itself.'
          }
        >
          <Select
            value={command}
            onChange={(v) => setPicked(v as CommandName)}
            options={COMMAND_ORDER.map((c) => ({
              value: c,
              label: c === suggested ? `${COMMAND_LABEL[c]} — suggested` : COMMAND_LABEL[c],
            }))}
            disabled={blocked}
          />
        </Field>
        <Button
          variant="primary"
          onClick={() => issue.run(command, deviceIds)}
          pending={issue.pending}
          disabled={blocked}
          title={blocked ? blockedReason : undefined}
        >
          {issue.pending
            ? 'Queueing…'
            : `Issue to ${deviceIds.length || 'all'} device${deviceIds.length === 1 ? '' : 's'}`}
        </Button>
      </div>

      {blocked && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {blockedReason}
        </p>
      )}

      {issue.error && (
        <div className="mt-3">
          <Banner tone="critical" onDismiss={issue.clearError}>
            Could not issue the command: {issue.error}. Nothing was queued.
          </Banner>
        </div>
      )}
      {result && !issue.pending && (
        <div className="mt-3">
          <Banner tone="accent" onDismiss={() => setResult(null)}>
            {result}
          </Banner>
        </div>
      )}

      {issued.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-1.5 text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
            Commands issued for this incident ({issued.length})
          </h4>
          <Table head={['Command', 'Device', 'State', 'Issued', 'Acked']}>
            {issued.map((c) => (
              <Row key={c.id}>
                <Cell nowrap>{COMMAND_LABEL[c.command] ?? c.command}</Cell>
                <Cell nowrap muted>
                  {c.device_name ?? `#${c.device_id}`}
                </Cell>
                <Cell nowrap>
                  <Badge
                    tone={
                      c.state === 'acked'
                        ? 'good'
                        : c.state === 'failed' || c.state === 'expired'
                          ? 'critical'
                          : 'neutral'
                    }
                  >
                    {c.state}
                  </Badge>
                </Cell>
                <Cell nowrap muted>
                  {timeAgo(c.sent_at ?? c.created_at)}
                </Cell>
                <Cell nowrap muted>
                  {c.acked_at ? timeAgo(c.acked_at) : '—'}
                </Cell>
              </Row>
            ))}
          </Table>
        </div>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Right column: affected devices                                             */
/* -------------------------------------------------------------------------- */

function AffectedDevicesCard({ incident }: { incident: Incident }) {
  const devices = incident.devices ?? []

  return (
    <Card>
      <SectionHeader
        title="Affected devices"
        subtitle={`${devices.length || incident.device_count || 0} device${
          (devices.length || incident.device_count || 0) === 1 ? '' : 's'
        } are reporting alerts inside this incident.`}
      />
      {devices.length === 0 ? (
        <EmptyState
          title="No device list on this incident"
          hint="The detail endpoint attaches the devices behind the correlated alerts. An empty list usually means the alerts were resolved and their devices pruned from the cluster."
        />
      ) : (
        <Table head={['Device', 'Type', 'Site', 'Health', 'Status']}>
          {devices.map((d) => (
            <Row key={d.id}>
              <Cell nowrap>
                <Link
                  to={`/devices/${d.id}`}
                  className="font-medium hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  {d.name}
                </Link>
                {d.serial && (
                  <span className="ml-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {d.serial}
                  </span>
                )}
              </Cell>
              <Cell nowrap muted>
                {d.device_type_name ?? '—'}
              </Cell>
              <Cell nowrap muted>
                {d.site_name ?? '—'}
              </Cell>
              <Cell nowrap>
                <HealthMeter score={d.health_score} />
              </Cell>
              <Cell nowrap>
                <StatusDot status={d.status} />
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Right column: member alerts                                                */
/* -------------------------------------------------------------------------- */

function MemberAlertsCard({
  incident,
  canAct,
  isDemo,
  onChanged,
}: {
  incident: Incident
  canAct: boolean
  isDemo: boolean
  onChanged: () => void
}) {
  const alerts = useMemo(
    () =>
      (incident.alerts ?? [])
        .slice()
        .sort((a, b) => new Date(b.fired_at).getTime() - new Date(a.fired_at).getTime()),
    [incident.alerts]
  )

  const firing = alerts.filter((a) => a.state === 'firing').length

  return (
    <Card>
      <SectionHeader
        title="Member alerts"
        subtitle={
          alerts.length
            ? `${alerts.length} alert${alerts.length === 1 ? '' : 's'} correlated into this incident · ${firing} still firing. Newest first.`
            : 'The alerts that were collapsed into this incident.'
        }
      />
      {alerts.length === 0 ? (
        <EmptyState
          title="No alerts attached"
          hint="An incident is a cluster of alerts, so an empty list means they were all resolved and swept. Check the timeline below for what fired while it was open."
        />
      ) : (
        <Table
          head={[
            'Severity',
            'Device',
            'Metric',
            'Observed',
            'Threshold',
            'z',
            'Fired',
            // Named for screen readers; a visible label over two small buttons is noise.
            <span key="actions" className="sr-only">
              Actions
            </span>,
          ]}
        >
          {alerts.map((a) => (
            <Row key={a.id}>
              <Cell nowrap>
                <SeverityBadge severity={a.severity} />
              </Cell>
              <Cell nowrap>
                <Link
                  to={`/devices/${a.device_id}`}
                  className="font-medium hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  {a.device_name ?? `#${a.device_id}`}
                </Link>
              </Cell>
              <Cell nowrap muted>
                {a.metric_key ?? '—'}
              </Cell>
              <Cell align="right" nowrap>
                <span className="num-tabular">{num(a.observed_value, 2)}</span>
              </Cell>
              <Cell align="right" nowrap muted>
                <span className="num-tabular">{num(a.threshold, 2)}</span>
              </Cell>
              <Cell align="right" nowrap muted>
                <span className="num-tabular">{a.z_score === null || a.z_score === undefined ? '—' : num(a.z_score, 1)}</span>
              </Cell>
              <Cell nowrap muted>
                <span title={dateTime(a.fired_at)}>{timeAgo(a.fired_at)}</span>
              </Cell>
              <Cell nowrap>
                <AlertActions alert={a} canAct={canAct} isDemo={isDemo} onChanged={onChanged} />
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </Card>
  )
}

function AlertActions({
  alert,
  canAct,
  isDemo,
  onChanged,
}: {
  alert: Alert
  canAct: boolean
  isDemo: boolean
  onChanged: () => void
}) {
  const ack = useAction(async () => {
    const res = await api.alerts.ack(alert.id)
    onChanged()
    return res
  })
  const resolve = useAction(async () => {
    const res = await api.alerts.resolve(alert.id)
    onChanged()
    return res
  })

  if (!canAct) {
    return (
      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {alert.state === 'resolved' ? 'resolved' : alert.state === 'acknowledged' ? 'acked' : '—'}
      </span>
    )
  }

  if (alert.state === 'resolved') {
    return (
      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        resolved {timeAgo(alert.resolved_at)}
      </span>
    )
  }

  const title = isDemo ? 'Disabled on the shared demo account so the live fleet stays intact.' : undefined
  const error = ack.error ?? resolve.error

  return (
    <span className="inline-flex items-center gap-1.5">
      {alert.state === 'firing' && (
        <Button size="sm" onClick={() => ack.run()} pending={ack.pending} disabled={isDemo} title={title}>
          Ack
        </Button>
      )}
      {alert.state === 'acknowledged' && (
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          acked {timeAgo(alert.acknowledged_at)}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => resolve.run()}
        pending={resolve.pending}
        disabled={isDemo}
        title={title}
      >
        Resolve
      </Button>
      {error && (
        <span className="text-[11px]" style={{ color: 'var(--status-critical)' }}>
          {error}
        </span>
      )}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Right column: the shape of the incident over time                          */
/* -------------------------------------------------------------------------- */

const TIMELINE_BUCKETS = 14
const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info']

/**
 * Alert firings binned onto one time axis, split by severity.
 *
 * All three series are the same measure on the same scale — a count of alerts per bucket —
 * so they belong on one chart. Severity here is a *series*, so it takes categorical slots
 * rather than the reserved status colors, which are spoken for by the badges beside it.
 */
function buildTimeline(alerts: Alert[]): { series: SeriesSpec[]; bucketMs: number } | null {
  const stamped = alerts
    .map((a) => ({ t: new Date(a.fired_at).getTime(), severity: a.severity }))
    .filter((a) => Number.isFinite(a.t))
  if (stamped.length === 0) return null

  const times = stamped.map((a) => a.t)
  const from = Math.min(...times)
  // A floor on the span keeps a burst of alerts inside one minute from collapsing into a
  // single point, which a line chart cannot draw.
  const span = Math.max(Math.max(...times) - from, 30 * 60 * 1000)
  const bucketMs = span / TIMELINE_BUCKETS

  const present = SEVERITY_ORDER.filter((s) => stamped.some((a) => a.severity === s))
  const counts = new Map<Severity, number[]>(present.map((s) => [s, new Array(TIMELINE_BUCKETS).fill(0)]))

  for (const a of stamped) {
    const idx = Math.min(TIMELINE_BUCKETS - 1, Math.max(0, Math.floor((a.t - from) / bucketMs)))
    const row = counts.get(a.severity)
    if (row) row[idx] += 1
  }

  const series: SeriesSpec[] = present.map((s) => ({
    key: s,
    label: s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Info',
    color: seriesColorFor(s, SEVERITY_ORDER),
    unit: 'alerts',
    points: (counts.get(s) ?? []).map((count, i) => ({
      ts: new Date(from + i * bucketMs).toISOString(),
      value: count,
    })),
  }))

  return { series, bucketMs }
}

const COUNT_SCHEMA: MetricSchemaEntry = {
  key: 'alerts_fired',
  label: 'Alerts fired',
  unit: '',
  kind: 'counter',
  nominal_min: null,
  nominal_max: null,
  precision: 0,
}

function AlertTimelineCard({ alerts }: { alerts: Alert[] }) {
  const built = useMemo(() => buildTimeline(alerts), [alerts])

  return (
    <Card>
      {built ? (
        <TimeSeriesChart
          title="Alert firings over the incident"
          subtitle={`Alerts per ${Math.max(1, Math.round(built.bucketMs / 60_000))}-minute bucket, split by severity`}
          series={built.series}
          schema={COUNT_SCHEMA}
          showBand={false}
          height={200}
          footnote="Counts are binned from each alert's fired_at, so a tall bucket is a burst — several devices tripping the same rule within minutes of each other."
        />
      ) : (
        <>
          <SectionHeader title="Alert firings over the incident" />
          <EmptyState
            title="Nothing to plot yet"
            hint="The timeline is built from the fired_at of the incident's member alerts. Once an alert is attached, its shape over time appears here."
          />
        </>
      )}
    </Card>
  )
}
