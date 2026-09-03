/**
 * Rules.
 *
 * The natural-language composer is the hero, and deliberately so: the pitch of this
 * product is that you describe the condition you care about in the words you would use
 * to a colleague, read back what the system understood, and save it. So the proposal
 * card leads with the restatement — reading your own intent back in plain English is
 * what makes a person comfortable pressing Save on something that will page them at 3am.
 *
 * Everything below the composer exists to keep that honest: the rule list shows the
 * English sentence a rule was born from, and "Test" replays the rule against stored
 * history so threshold tuning is measured instead of guessed. The test creates nothing —
 * that promise is on screen next to the result, not buried in a tooltip.
 */

import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'
import { useAction, useAsync } from '../lib/useAsync'
import { useAuth } from '../lib/auth'
import { CONDITION_LABEL, metricValue, num, timeAgo } from '../lib/format'
import type {
  AlertRule,
  Device,
  DeviceType,
  MetricSchemaEntry,
  RuleCondition,
  RuleProposal,
  Severity,
  Site,
} from '../lib/types'
import {
  Badge,
  Banner,
  Button,
  Card,
  Cell,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LinkCell,
  Modal,
  Row,
  SectionHeader,
  Segmented,
  Select,
  SeverityBadge,
  Skeleton,
  Table,
  Textarea,
} from '../components/ui'
import { HeroFigure } from '../components/StatTile'

type RuleTestResult = Awaited<ReturnType<typeof api.rules.test>>

const EXAMPLES = [
  'page me if any freezer sits above -15C for 10 minutes',
  'warn me when an AMR battery drains faster than 20% an hour',
  'critical if CNC vibration is 3 sigma above its own baseline',
  'tell me when a gateway stops reporting for 5 minutes',
]

const CONDITIONS: RuleCondition[] = [
  'gt',
  'lt',
  'outside_range',
  'rate_of_change',
  'flatline',
  'offline',
  'anomaly',
]

/** Conditions that read a metric. `offline` is about the device itself. */
const NEEDS_METRIC = (c: RuleCondition) => c !== 'offline'
const NEEDS_THRESHOLD = (c: RuleCondition) => c === 'gt' || c === 'lt' || c === 'rate_of_change'
const NEEDS_RANGE = (c: RuleCondition) => c === 'outside_range'
const NEEDS_Z = (c: RuleCondition) => c === 'anomaly'

/* -------------------------------------------------------------------------- */
/* Small formatting helpers, local because they are only about rules          */
/* -------------------------------------------------------------------------- */

/** Seconds to something a human says out loud: 600 -> "10m", 5400 -> "1h 30m". */
function windowText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const mins = Math.floor(s / 60)
  const remSecs = s % 60
  if (mins < 60) return remSecs ? `${mins}m ${remSecs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hours < 24) return remMins ? `${hours}h ${remMins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours ? `${days}d ${remHours}h` : `${days}d`
}

/**
 * A threshold is a magnitude, never an on/off state — so a `state` metric's schema is
 * borrowed for its unit and precision but not for its On/Off rendering.
 */
function fmtThreshold(value: number | null | undefined, entry?: MetricSchemaEntry): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return metricValue(value, entry && entry.kind === 'state' ? { ...entry, kind: 'gauge' } : entry)
}

type RuleLike = Partial<AlertRule> & { device_type_code?: string; site_code?: string }

/** The condition as a sentence, built from the shared CONDITION_LABEL vocabulary. */
function conditionText(rule: RuleLike, schema: Map<string, MetricSchemaEntry>): string {
  if (!rule.condition) return '—'
  const label = CONDITION_LABEL[rule.condition] ?? rule.condition
  const entry = rule.metric_key ? schema.get(rule.metric_key) : undefined
  const subject =
    rule.condition === 'offline' ? 'Device' : (entry?.label ?? rule.metric_key ?? 'metric')

  let core = `${subject} ${label}`

  if (NEEDS_THRESHOLD(rule.condition)) {
    if (rule.threshold !== null && rule.threshold !== undefined) {
      core += ` ${fmtThreshold(rule.threshold, entry)}`
    }
  } else if (NEEDS_RANGE(rule.condition)) {
    core += ` ${fmtThreshold(rule.threshold, entry)} – ${fmtThreshold(rule.threshold_high, entry)}`
  } else if (NEEDS_Z(rule.condition)) {
    core += ` (z ≥ ${num(rule.z_threshold ?? 3, 1)})`
  }

  const w = windowText(rule.window_seconds)
  if (w) core += rule.condition === 'rate_of_change' ? ` per ${w}` : ` for ${w}`
  return core
}

function scopeText(rule: RuleLike, types: DeviceType[], sites: Site[], devices: Device[]): string {
  if (rule.scope_label) return rule.scope_label
  const parts: string[] = []

  const deviceName =
    rule.device_name ?? (rule.device_id ? devices.find((d) => d.id === rule.device_id)?.name : undefined)
  if (deviceName) parts.push(deviceName)
  else if (rule.device_id) parts.push(`Device #${rule.device_id}`)

  const typeName =
    rule.device_type_name ??
    (rule.device_type_id ? types.find((t) => t.id === rule.device_type_id)?.name : undefined) ??
    rule.device_type_code
  if (typeName) parts.push(typeName)

  const siteName =
    rule.site_name ??
    (rule.site_id ? sites.find((s) => s.id === rule.site_id)?.name : undefined) ??
    rule.site_code
  if (siteName) parts.push(siteName)

  return parts.length ? parts.join(' · ') : 'Whole fleet'
}

/* -------------------------------------------------------------------------- */
/* Form model                                                                 */
/* -------------------------------------------------------------------------- */

interface FormState {
  id?: number
  name: string
  description: string
  device_type_id: string
  site_id: string
  device_id: string
  metric_key: string
  condition: RuleCondition
  threshold: string
  threshold_high: string
  window_seconds: string
  z_threshold: string
  severity: Severity
  cooldown_seconds: string
  enabled: boolean
  natural_language_source: string
  ai_generated: boolean
}

const blankForm = (): FormState => ({
  name: '',
  description: '',
  device_type_id: '',
  site_id: '',
  device_id: '',
  metric_key: '',
  condition: 'gt',
  threshold: '',
  threshold_high: '',
  window_seconds: '300',
  z_threshold: '3',
  severity: 'warning',
  cooldown_seconds: '900',
  enabled: true,
  natural_language_source: '',
  ai_generated: false,
})

const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))

function formFromRule(rule: AlertRule): FormState {
  return {
    id: rule.id,
    name: rule.name ?? '',
    description: rule.description ?? '',
    device_type_id: str(rule.device_type_id),
    site_id: str(rule.site_id),
    device_id: str(rule.device_id),
    metric_key: rule.metric_key ?? '',
    condition: rule.condition ?? 'gt',
    threshold: str(rule.threshold),
    threshold_high: str(rule.threshold_high),
    window_seconds: str(rule.window_seconds ?? 300),
    z_threshold: str(rule.z_threshold ?? 3),
    severity: rule.severity ?? 'warning',
    cooldown_seconds: str(rule.cooldown_seconds ?? 900),
    enabled: rule.enabled ?? true,
    natural_language_source: rule.natural_language_source ?? '',
    ai_generated: Boolean(rule.ai_generated),
  }
}

function formFromProposal(p: RuleProposal, source: string, types: DeviceType[], sites: Site[]): FormState {
  const r = p.proposal ?? {}
  const typeId =
    r.device_type_id ??
    (r.device_type_code ? types.find((t) => t.code === r.device_type_code)?.id : undefined)
  const siteId = r.site_id ?? (r.site_code ? sites.find((s) => s.code === r.site_code)?.id : undefined)

  return {
    name: r.name ?? '',
    description: r.description ?? '',
    device_type_id: str(typeId),
    site_id: str(siteId),
    device_id: str(r.device_id),
    metric_key: r.metric_key ?? '',
    condition: r.condition ?? 'gt',
    threshold: str(r.threshold),
    threshold_high: str(r.threshold_high),
    window_seconds: str(r.window_seconds ?? 300),
    z_threshold: str(r.z_threshold ?? 3),
    severity: r.severity ?? 'warning',
    cooldown_seconds: str(r.cooldown_seconds ?? 900),
    enabled: r.enabled ?? true,
    // Keep the sentence the human actually typed — that is what makes the saved rule
    // self-documenting later.
    natural_language_source: r.natural_language_source ?? source,
    ai_generated: true,
  }
}

const numOrNull = (s: string): number | null => {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** The same shape the backend enforces, checked here so the message lands next to the field. */
function validate(f: FormState): Record<string, string> {
  const e: Record<string, string> = {}

  if (f.name.trim().length < 2) e.name = 'Give the rule a name — it is what appears on the alert.'

  if (NEEDS_METRIC(f.condition) && !f.metric_key.trim()) {
    e.metric_key = 'This condition reads a metric, so a metric key is required.'
  }

  if (NEEDS_THRESHOLD(f.condition)) {
    if (numOrNull(f.threshold) === null) e.threshold = 'Enter a numeric threshold.'
  }

  if (NEEDS_RANGE(f.condition)) {
    const lo = numOrNull(f.threshold)
    const hi = numOrNull(f.threshold_high)
    if (lo === null) e.threshold = 'Enter the low bound.'
    if (hi === null) e.threshold_high = 'Enter the high bound.'
    if (lo !== null && hi !== null && lo >= hi) {
      e.threshold_high = 'The high bound has to be greater than the low bound.'
    }
  }

  if (NEEDS_Z(f.condition)) {
    const z = numOrNull(f.z_threshold)
    if (z === null) e.z_threshold = 'Enter a sigma (z) threshold.'
    else if (z <= 0) e.z_threshold = 'Sigma has to be greater than zero.'
    else if (z > 12) e.z_threshold = 'Above 12 sigma nothing will ever fire.'
  }

  const w = numOrNull(f.window_seconds)
  if (w === null) e.window_seconds = 'Enter a window in seconds (0 for instantaneous).'
  else if (w < 0) e.window_seconds = 'A window cannot be negative.'
  else if ((f.condition === 'flatline' || f.condition === 'offline') && w <= 0) {
    e.window_seconds = 'This condition is defined by its window, so it needs one.'
  }

  const cd = numOrNull(f.cooldown_seconds)
  if (cd === null) e.cooldown_seconds = 'Enter a cooldown in seconds (0 for none).'
  else if (cd < 0) e.cooldown_seconds = 'A cooldown cannot be negative.'

  return e
}

function payloadFromForm(f: FormState): Partial<AlertRule> {
  const usesMetric = NEEDS_METRIC(f.condition)
  return {
    name: f.name.trim(),
    description: f.description.trim() || null,
    device_type_id: numOrNull(f.device_type_id),
    site_id: numOrNull(f.site_id),
    device_id: numOrNull(f.device_id),
    metric_key: usesMetric ? f.metric_key.trim() : null,
    condition: f.condition,
    threshold: NEEDS_THRESHOLD(f.condition) || NEEDS_RANGE(f.condition) ? numOrNull(f.threshold) : null,
    threshold_high: NEEDS_RANGE(f.condition) ? numOrNull(f.threshold_high) : null,
    window_seconds: numOrNull(f.window_seconds) ?? 0,
    z_threshold: NEEDS_Z(f.condition) ? (numOrNull(f.z_threshold) ?? 3) : 3,
    severity: f.severity,
    cooldown_seconds: numOrNull(f.cooldown_seconds) ?? 0,
    enabled: f.enabled,
    natural_language_source: f.natural_language_source.trim() || null,
    ai_generated: f.ai_generated,
  }
}

/* -------------------------------------------------------------------------- */
/* Bits of chrome                                                             */
/* -------------------------------------------------------------------------- */

/** A switch that says On/Off in words, so state never rides on hue alone. */
function Toggle({
  on,
  onToggle,
  disabled,
  title,
  label,
}: {
  on: boolean
  onToggle: () => void
  disabled?: boolean
  title?: string
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex items-center gap-2 rounded-[6px] ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      }`}
    >
      <span
        className="relative inline-block shrink-0 rounded-full transition-colors"
        style={{ width: 28, height: 16, background: on ? 'var(--status-good)' : 'var(--surface-3)' }}
        aria-hidden="true"
      >
        <span
          className="absolute top-[2px] block rounded-full transition-all"
          style={{ width: 12, height: 12, left: on ? 14 : 2, background: 'var(--surface-1)' }}
        />
      </span>
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {on ? 'On' : 'Off'}
      </span>
    </button>
  )
}

function FormField({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div>
      <Field label={label} hint={error ? undefined : hint}>
        {children}
      </Field>
      {error && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--status-critical)' }}>
          {error}
        </p>
      )}
    </div>
  )
}

/** One label/value pair in the proposal read-back. */
function ProposalField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <div className="mt-0.5 text-[13px] break-words" style={{ color: 'var(--text-primary)' }}>
        {children}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function Rules() {
  const { can, isDemo } = useAuth()
  const canEdit = can('operator')
  const demoBlock = isDemo
    ? 'Disabled on the shared demo account so the live fleet stays intact.'
    : undefined

  const list = useAsync<AlertRule[]>(() => api.rules.list(), [])
  const ref = useAsync(
    async (signal) => {
      const [types, siteList, deviceList] = await Promise.all([
        api.deviceTypes.list(),
        api.sites.list(),
        // The scope picker needs the whole fleet, and /devices rejects a per_page above
        // 100 rather than clamping it — so page, don't ask for a big number.
        api.devices.listAll({ sort: 'name' }, signal),
      ])
      return { types, sites: siteList, devices: deviceList }
    },
    []
  )

  const types = ref.data?.types ?? []
  const sites = ref.data?.sites ?? []
  const devices = ref.data?.devices ?? []

  /** Every metric key any device type declares — nobody should have to remember these. */
  const metricSchema = useMemo(() => {
    const map = new Map<string, MetricSchemaEntry>()
    for (const t of types) {
      for (const entry of t.metric_schema ?? []) {
        if (entry?.key && !map.has(entry.key)) map.set(entry.key, entry)
      }
    }
    return map
  }, [types])

  const metricKeys = useMemo(
    () => [...metricSchema.keys()].sort((a, b) => a.localeCompare(b)),
    [metricSchema]
  )

  /* ---------------------------- composer state ---------------------------- */

  const [text, setText] = useState('')
  const [proposal, setProposal] = useState<RuleProposal | null>(null)
  const [proposalSource, setProposalSource] = useState('')
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const compose = useAction(async (t: string) => api.ai.ruleFromText(t, false))
  const saveFromText = useAction(async (t: string) => api.ai.ruleFromText(t, true))

  const proposalErrors = proposal?.errors ?? []

  const runCompose = async () => {
    const t = text.trim()
    if (!t) return
    setSavedNote(null)
    setProposal(null)
    const res = await compose.run(t)
    if (res) {
      setProposal(res)
      setProposalSource(t)
    }
  }

  const runSave = async () => {
    const t = (proposalSource || text).trim()
    if (!t) return
    const res = await saveFromText.run(t)
    if (!res) return
    if (res.saved) {
      setSavedNote(
        `Saved “${res.rule?.name ?? proposal?.proposal?.name ?? 'the rule'}” — it is evaluating live telemetry from the next reading on.`
      )
      setProposal(null)
      setText('')
      setProposalSource('')
      list.reload()
    } else {
      // The backend refused it. Show what it said rather than pretending it saved.
      setProposal(res)
    }
  }

  /* ------------------------------ form state ------------------------------ */

  const [form, setForm] = useState<FormState | null>(null)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const patch = (p: Partial<FormState>) => setForm((f) => (f ? { ...f, ...p } : f))

  const openCreate = () => {
    setFormErrors({})
    setForm(blankForm())
  }
  const openEdit = (rule: AlertRule) => {
    setFormErrors({})
    setForm(formFromRule(rule))
  }
  const openEditFromProposal = () => {
    if (!proposal) return
    setFormErrors({})
    setForm(formFromProposal(proposal, proposalSource || text, types, sites))
  }

  const saveForm = useAction(async (f: FormState) => {
    const body = payloadFromForm(f)
    return f.id ? api.rules.update(f.id, body) : api.rules.create(body)
  })

  const submitForm = async () => {
    if (!form) return
    const errs = validate(form)
    setFormErrors(errs)
    if (Object.keys(errs).length) return
    const res = await saveForm.run(form)
    if (!res) return
    setSavedNote(form.id ? `Updated “${res.name}”.` : `Created “${res.name}”.`)
    setForm(null)
    list.reload()
  }

  /* ------------------------------ row actions ----------------------------- */

  const [busy, setBusy] = useState<number[]>([])
  const [rowError, setRowError] = useState<string | null>(null)
  const markBusy = (id: number, on: boolean) =>
    setBusy((b) => (on ? [...b, id] : b.filter((x) => x !== id)))

  const toggleEnabled = async (rule: AlertRule) => {
    const next = !rule.enabled
    setRowError(null)
    markBusy(rule.id, true)
    // Optimistic: a toggle that lags behind the click reads as a broken switch.
    list.setData((prev) => prev?.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)) ?? prev)
    try {
      const updated = await api.rules.update(rule.id, { enabled: next })
      list.setData((prev) => prev?.map((r) => (r.id === rule.id ? { ...r, ...updated } : r)) ?? prev)
    } catch (err) {
      list.setData(
        (prev) => prev?.map((r) => (r.id === rule.id ? { ...r, enabled: rule.enabled } : r)) ?? prev
      )
      setRowError(
        `Could not ${next ? 'enable' : 'disable'} “${rule.name}”: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    } finally {
      markBusy(rule.id, false)
    }
  }

  const [deleteTarget, setDeleteTarget] = useState<AlertRule | null>(null)
  const removeRule = useAction(async (id: number) => api.rules.remove(id))

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const res = await removeRule.run(deleteTarget.id)
    if (!res) return
    setSavedNote(`Deleted “${deleteTarget.name}”. Alerts it already raised are kept.`)
    setDeleteTarget(null)
    list.reload()
  }

  /* --------------------------------- test --------------------------------- */

  const [testRule, setTestRule] = useState<AlertRule | null>(null)
  const [testHours, setTestHours] = useState<'6' | '24' | '72'>('24')
  const [testResult, setTestResult] = useState<RuleTestResult | null>(null)
  const {
    run: runRuleTest,
    pending: testPending,
    error: testError,
  } = useAction(api.rules.test)

  // Run as soon as the panel opens, and again when the window changes — the point of the
  // dry run is to compare windows, and making that a second click hides it.
  useEffect(() => {
    if (!testRule) return
    let cancelled = false
    setTestResult(null)
    void runRuleTest(testRule.id, Number(testHours)).then((res) => {
      if (!cancelled && res) setTestResult(res)
    })
    return () => {
      cancelled = true
    }
  }, [testRule, testHours, runRuleTest])

  const rules = list.data ?? []
  const enabledCount = rules.filter((r) => r.enabled).length
  const aiCount = rules.filter((r) => r.ai_generated).length

  /* -------------------------------- render -------------------------------- */

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      {/* ---------------------------- The composer ---------------------------- */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] leading-tight font-semibold" style={{ color: 'var(--text-primary)' }}>
              Describe what should page you
            </h1>
            <p className="mt-1 max-w-2xl text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Write the condition the way you would say it to a colleague. Nerve turns it into a real
              rule, reads it back to you, and saves the sentence alongside it.
            </p>
          </div>
          <Badge tone="accent">AI composer</Badge>
        </div>

        <div className="mt-3">
          <Textarea
            value={text}
            onChange={setText}
            rows={3}
            placeholder="page me if any freezer sits above -15C for 10 minutes"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Try
          </span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setText(ex)}
              className="cursor-pointer rounded-full border px-2.5 py-1 text-[11px] hover:opacity-80"
              style={{
                borderColor: 'var(--surface-3)',
                background: 'var(--surface-2)',
                color: 'var(--text-secondary)',
              }}
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={runCompose} pending={compose.pending} disabled={!text.trim()}>
            Compose rule
          </Button>
          <Button variant="ghost" onClick={openCreate} disabled={!canEdit} title={!canEdit ? 'Requires operator access' : undefined}>
            Write one by hand instead
          </Button>
          {compose.pending && (
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Reading your sentence and matching it to the metric schema…
            </span>
          )}
        </div>

        {compose.error && (
          <div className="mt-3">
            <ErrorState error={new Error(compose.error)} onRetry={runCompose} />
          </div>
        )}

        {/* ---------------------------- The read-back ---------------------------- */}
        {proposal && (
          <div
            className="mt-4 rounded-[10px] border"
            style={{ borderColor: 'var(--accent)', background: 'var(--surface-1)' }}
          >
            <div className="px-4 pt-3 pb-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                  What Nerve understood
                </span>
                {proposal.fallback_used && <Badge tone="warning">Deterministic fallback</Badge>}
                {proposalErrors.length > 0 && <Badge tone="critical">Needs a fix</Badge>}
              </div>

              {/* The restatement is the whole point of this card, so it is the largest
                  thing in it. */}
              <p
                className="mt-2 text-[18px] leading-snug font-medium"
                style={{ color: 'var(--text-primary)' }}
              >
                {proposal.restatement ??
                  conditionText(proposal.proposal ?? {}, metricSchema) ??
                  'No restatement returned.'}
              </p>

              {proposal.fallback_used && (
                <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  The model was unavailable, so this was parsed by the deterministic analyzer instead.
                  It gets simple sentences right and nuance wrong — read the fields below before saving.
                </p>
              )}
            </div>

            <div
              className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 border-t px-4 py-3 sm:grid-cols-3 lg:grid-cols-4"
              style={{ borderColor: 'var(--surface-3)' }}
            >
              <ProposalField label="Name">{proposal.proposal?.name ?? '—'}</ProposalField>
              <ProposalField label="Metric">
                {proposal.proposal?.metric_key ? (
                  <span>
                    {metricSchema.get(proposal.proposal.metric_key)?.label ?? proposal.proposal.metric_key}
                    <span className="ml-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {proposal.proposal.metric_key}
                    </span>
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {proposal.proposal?.condition === 'offline' ? 'not needed' : '—'}
                  </span>
                )}
              </ProposalField>
              <ProposalField label="Condition">
                {proposal.proposal?.condition
                  ? (CONDITION_LABEL[proposal.proposal.condition] ?? proposal.proposal.condition)
                  : '—'}
              </ProposalField>
              <ProposalField label="Threshold">
                {(() => {
                  const p = proposal.proposal ?? {}
                  const entry = p.metric_key ? metricSchema.get(p.metric_key) : undefined
                  if (!p.condition) return '—'
                  if (NEEDS_RANGE(p.condition))
                    return `${fmtThreshold(p.threshold, entry)} – ${fmtThreshold(p.threshold_high, entry)}`
                  if (NEEDS_Z(p.condition)) return `${num(p.z_threshold ?? 3, 1)} σ from baseline`
                  if (NEEDS_THRESHOLD(p.condition)) return fmtThreshold(p.threshold, entry)
                  return <span style={{ color: 'var(--text-muted)' }}>not used</span>
                })()}
              </ProposalField>
              <ProposalField label="Window">
                {windowText(proposal.proposal?.window_seconds) || 'instantaneous'}
              </ProposalField>
              <ProposalField label="Severity">
                {proposal.proposal?.severity ? (
                  <SeverityBadge severity={proposal.proposal.severity} />
                ) : (
                  '—'
                )}
              </ProposalField>
              <ProposalField label="Scope">
                {scopeText(proposal.proposal ?? {}, types, sites, devices)}
              </ProposalField>
              <ProposalField label="Cooldown">
                {windowText(proposal.proposal?.cooldown_seconds) || 'none'}
              </ProposalField>
            </div>

            {proposalErrors.length > 0 && (
              <div className="px-4 pb-3">
                <div
                  className="rounded-[10px] border px-3 py-2"
                  style={{ borderColor: 'var(--status-critical)' }}
                >
                  <p className="text-[12px] font-medium" style={{ color: 'var(--status-critical)' }}>
                    Validation rejected this proposal
                  </p>
                  <ul className="mt-1 list-disc pl-4 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {proposalErrors.map((msg, i) => (
                      <li key={i}>{msg}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    Open the editor to correct it, or rephrase the sentence and compose again.
                  </p>
                </div>
              </div>
            )}

            {saveFromText.error && (
              <div className="px-4 pb-3">
                <ErrorState error={new Error(saveFromText.error)} />
              </div>
            )}

            <div
              className="flex flex-wrap items-center gap-2 border-t px-4 py-3"
              style={{ borderColor: 'var(--surface-3)' }}
            >
              {canEdit && (
                <Button
                  variant="primary"
                  onClick={runSave}
                  pending={saveFromText.pending}
                  disabled={Boolean(demoBlock) || proposalErrors.length > 0}
                  title={
                    demoBlock ??
                    (proposalErrors.length > 0 ? 'Fix the validation errors first.' : undefined)
                  }
                >
                  Save rule
                </Button>
              )}
              {canEdit && (
                <Button onClick={openEditFromProposal}>Edit before saving</Button>
              )}
              <Button variant="ghost" onClick={() => setProposal(null)}>
                Discard
              </Button>
              {!canEdit && (
                <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  Viewer access — you can compose and read a proposal, but not save it.
                </span>
              )}
            </div>
          </div>
        )}
      </Card>

      {savedNote && (
        <Banner tone="accent" onDismiss={() => setSavedNote(null)}>
          {savedNote}
        </Banner>
      )}

      {rowError && (
        <Banner tone="critical" onDismiss={() => setRowError(null)}>
          {rowError}
        </Banner>
      )}

      {/* ------------------------------ The list ------------------------------ */}
      <Card padded={false}>
        <div className="p-4 pb-0">
          <SectionHeader
            title="Rules"
            subtitle={
              list.initial
                ? 'Loading…'
                : `${rules.length} rule${rules.length === 1 ? '' : 's'} · ${enabledCount} enabled · ${aiCount} written from a sentence`
            }
            action={
              canEdit ? (
                <Button onClick={openCreate} disabled={Boolean(demoBlock)} title={demoBlock}>
                  New rule
                </Button>
              ) : undefined
            }
          />
        </div>

        {list.initial ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={34} />
            ))}
          </div>
        ) : list.error ? (
          <div className="p-4">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            title="No rules yet"
            hint="Nothing is watching the fleet. Describe a condition in the box above — “page me if any freezer sits above -15C for 10 minutes” — and save the proposal."
            action={
              canEdit ? (
                <Button onClick={openCreate} disabled={Boolean(demoBlock)} title={demoBlock}>
                  Write one by hand
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="mt-1">
            <Table
              head={[
                'Rule',
                'Scope',
                'Condition',
                'Severity',
                'Enabled',
                'Fires',
                'Last fired',
                <span key="a" className="sr-only">
                  Actions
                </span>,
              ]}
            >
              {rules.map((rule) => (
                <Row key={rule.id}>
                  <Cell>
                    <div className="min-w-0 max-w-[22rem]">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {rule.name}
                        </span>
                        {rule.ai_generated && <Badge tone="accent">AI</Badge>}
                      </div>
                      {rule.natural_language_source ? (
                        <p className="mt-0.5 text-[12px] italic" style={{ color: 'var(--text-secondary)' }}>
                          “{rule.natural_language_source}”
                        </p>
                      ) : rule.description ? (
                        <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                          {rule.description}
                        </p>
                      ) : null}
                    </div>
                  </Cell>

                  <Cell muted nowrap>
                    {scopeText(rule, types, sites, devices)}
                  </Cell>

                  <Cell>
                    <span className="block max-w-[20rem]">{conditionText(rule, metricSchema)}</span>
                  </Cell>

                  <Cell nowrap>
                    <SeverityBadge severity={rule.severity} />
                  </Cell>

                  <Cell nowrap>
                    {canEdit ? (
                      <Toggle
                        on={rule.enabled}
                        label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                        disabled={Boolean(demoBlock) || busy.includes(rule.id)}
                        title={demoBlock}
                        onToggle={() => void toggleEnabled(rule)}
                      />
                    ) : (
                      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                        {rule.enabled ? 'On' : 'Off'}
                      </span>
                    )}
                  </Cell>

                  <Cell align="right" nowrap>
                    <span className="num-tabular">{rule.fire_count ?? 0}</span>
                  </Cell>

                  <Cell muted nowrap>
                    {timeAgo(rule.last_fired_at)}
                  </Cell>

                  <Cell nowrap>
                    <span className="flex items-center gap-1">
                      <Button
                        size="sm"
                        onClick={() => {
                          setTestResult(null)
                          setTestRule(rule)
                        }}
                        title="Replay this rule against stored history. Creates no alerts."
                      >
                        Test
                      </Button>
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(rule)}
                          disabled={Boolean(demoBlock)}
                          title={demoBlock}
                        >
                          Edit
                        </Button>
                      )}
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget(rule)}
                          disabled={Boolean(demoBlock)}
                          title={demoBlock}
                        >
                          Delete
                        </Button>
                      )}
                    </span>
                  </Cell>
                </Row>
              ))}
            </Table>
          </div>
        )}
      </Card>

      {ref.error && (
        <Banner tone="warning">
          Device types, sites and devices could not be loaded, so metric-key suggestions and scope
          names are unavailable. Rules themselves are unaffected. {ref.error.message}
        </Banner>
      )}

      {/* ------------------------------ Test panel ---------------------------- */}
      <Modal
        open={Boolean(testRule)}
        onClose={() => {
          setTestRule(null)
          setTestResult(null)
        }}
        title={`Dry run — ${testRule?.name ?? ''}`}
        wide
        footer={
          <Button variant="secondary" onClick={() => setTestRule(null)}>
            Close
          </Button>
        }
      >
        {testRule && (
          <div className="flex flex-col gap-3">
            <Banner tone="accent">
              This replays the rule against telemetry already stored. <strong>No alerts were created</strong>,
              nothing was sent, and nobody was paged — it only counts what would have happened.
            </Banner>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                {conditionText(testRule, metricSchema)} · {scopeText(testRule, types, sites, devices)}
              </span>
              <Segmented<'6' | '24' | '72'>
                value={testHours}
                onChange={setTestHours}
                options={[
                  { value: '6', label: 'Last 6h' },
                  { value: '24', label: 'Last 24h' },
                  { value: '72', label: 'Last 3d' },
                ]}
              />
            </div>

            {testPending ? (
              <div className="flex flex-col gap-2">
                <Skeleton height={64} />
                <Skeleton height={120} />
              </div>
            ) : testError ? (
              <ErrorState
                error={new Error(testError)}
                onRetry={() => {
                  const r = testRule
                  setTestRule(null)
                  window.setTimeout(() => setTestRule(r), 0)
                }}
              />
            ) : testResult ? (
              <>
                <div
                  className="flex flex-wrap items-end justify-between gap-4 rounded-[10px] border p-4"
                  style={{ borderColor: 'var(--surface-3)', background: 'var(--surface-2)' }}
                >
                  <HeroFigure
                    label="Would have fired"
                    value={testResult.would_fire_count}
                    unit={testResult.would_fire_count === 1 ? 'time' : 'times'}
                    accent={
                      testResult.would_fire_count === 0
                        ? 'var(--text-primary)'
                        : testResult.would_fire_count > 25
                          ? 'var(--status-critical)'
                          : 'var(--status-warning)'
                    }
                    sub={`across ${testResult.device_count} device${
                      testResult.device_count === 1 ? '' : 's'
                    } in the last ${windowText(Number(testHours) * 3600)}`}
                  />
                  {testResult.verdict && (
                    <p
                      className="max-w-sm text-[13px] leading-snug"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {testResult.verdict}
                    </p>
                  )}
                </div>

                {testResult.matches?.length ? (
                  <Table head={['Device', 'Extreme value', 'Would fire']}>
                    {testResult.matches.map((m) => {
                      const entry = testRule.metric_key ? metricSchema.get(testRule.metric_key) : undefined
                      return (
                        <Row key={m.device_id}>
                          <LinkCell to={`/devices/${m.device_id}`}>
                            {m.device_name ??
                              devices.find((d) => d.id === m.device_id)?.name ??
                              `Device #${m.device_id}`}
                          </LinkCell>
                          <Cell align="right" nowrap>
                            <span className="num-tabular">{fmtThreshold(m.extreme_value, entry)}</span>
                          </Cell>
                          <Cell align="right" nowrap>
                            <span className="num-tabular">{m.fire_count}</span>
                          </Cell>
                        </Row>
                      )
                    })}
                  </Table>
                ) : (
                  <EmptyState
                    title="No device would have fired"
                    hint="Either the fleet stayed inside this rule's bounds, or the rule is too loose to catch what you meant. Try a longer window, or tighten the threshold and run it again."
                  />
                )}
              </>
            ) : null}
          </div>
        )}
      </Modal>

      {/* ----------------------------- Manual form ---------------------------- */}
      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? `Edit rule — ${form.name || 'untitled'}` : 'New rule'}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={submitForm}
              pending={saveForm.pending}
              disabled={Boolean(demoBlock)}
              title={demoBlock}
            >
              {form?.id ? 'Save changes' : 'Create rule'}
            </Button>
          </>
        }
      >
        {form && (
          <div className="flex flex-col gap-3">
            {form.natural_language_source && (
              <div
                className="rounded-[10px] border px-3 py-2"
                style={{ borderColor: 'var(--surface-3)', background: 'var(--surface-2)' }}
              >
                <p className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                  Original request — saved with the rule
                </p>
                <p className="mt-0.5 text-[13px] italic" style={{ color: 'var(--text-primary)' }}>
                  “{form.natural_language_source}”
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Name" error={formErrors.name}>
                <Input value={form.name} onChange={(v) => patch({ name: v })} autoFocus />
              </FormField>
              <FormField label="Description" hint="Optional. Shown on the rule when there is no sentence.">
                <Input value={form.description} onChange={(v) => patch({ description: v })} />
              </FormField>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                Scope — leave all three as “Any” to watch the whole fleet
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <FormField label="Device type">
                  <Select
                    value={form.device_type_id}
                    onChange={(v) => patch({ device_type_id: v })}
                    options={[
                      { value: '', label: 'Any type' },
                      ...types.map((t) => ({ value: String(t.id), label: t.name })),
                    ]}
                  />
                </FormField>
                <FormField label="Site">
                  <Select
                    value={form.site_id}
                    onChange={(v) => patch({ site_id: v })}
                    options={[
                      { value: '', label: 'Any site' },
                      ...sites.map((s) => ({ value: String(s.id), label: s.name })),
                    ]}
                  />
                </FormField>
                <FormField
                  label="Single device"
                  hint={form.device_id ? 'A single device overrides the type and site above.' : undefined}
                >
                  <Select
                    value={form.device_id}
                    onChange={(v) => patch({ device_id: v })}
                    options={[
                      { value: '', label: 'Any device' },
                      ...devices.map((d) => ({ value: String(d.id), label: `${d.name} (${d.serial})` })),
                    ]}
                  />
                </FormField>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Condition">
                <Select
                  value={form.condition}
                  onChange={(v) => patch({ condition: v as RuleCondition })}
                  options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABEL[c] ?? c }))}
                />
              </FormField>

              {NEEDS_METRIC(form.condition) ? (
                <FormField
                  label="Metric key"
                  hint={
                    metricKeys.length
                      ? `${metricKeys.length} keys declared across your device types — start typing to filter.`
                      : 'Device types are still loading; you can type a key directly.'
                  }
                  error={formErrors.metric_key}
                >
                  {/* A datalist rather than a select: the schema union covers everything the
                      seeded fleet reports, but a new device type can add a key today. */}
                  <input
                    type="text"
                    list="nerve-metric-keys"
                    value={form.metric_key}
                    onChange={(e) => patch({ metric_key: e.target.value })}
                    placeholder="temp_c"
                    className="w-full rounded-[6px] border px-2.5 py-1.5 text-[13px] outline-none"
                    style={{
                      background: 'var(--surface-1)',
                      borderColor: 'var(--surface-3)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  <datalist id="nerve-metric-keys">
                    {metricKeys.map((k) => {
                      const entry = metricSchema.get(k)
                      return (
                        <option key={k} value={k}>
                          {entry?.label ?? k}
                          {entry?.unit ? ` (${entry.unit})` : ''}
                        </option>
                      )
                    })}
                  </datalist>
                </FormField>
              ) : (
                <div className="flex items-end">
                  <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    “Offline” watches the device's own heartbeat, so it needs no metric.
                  </p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {NEEDS_THRESHOLD(form.condition) && (
                <FormField
                  label={
                    form.condition === 'rate_of_change' ? 'Change per window' : 'Threshold'
                  }
                  hint={
                    form.metric_key && metricSchema.get(form.metric_key)?.unit
                      ? `In ${metricSchema.get(form.metric_key)?.unit}`
                      : undefined
                  }
                  error={formErrors.threshold}
                >
                  <Input
                    type="number"
                    step={0.1}
                    value={form.threshold}
                    onChange={(v) => patch({ threshold: v })}
                  />
                </FormField>
              )}

              {NEEDS_RANGE(form.condition) && (
                <>
                  <FormField label="Low bound" error={formErrors.threshold}>
                    <Input
                      type="number"
                      step={0.1}
                      value={form.threshold}
                      onChange={(v) => patch({ threshold: v })}
                    />
                  </FormField>
                  <FormField label="High bound" error={formErrors.threshold_high}>
                    <Input
                      type="number"
                      step={0.1}
                      value={form.threshold_high}
                      onChange={(v) => patch({ threshold_high: v })}
                    />
                  </FormField>
                </>
              )}

              {NEEDS_Z(form.condition) && (
                <FormField
                  label="Sigma (z) from baseline"
                  hint="The learned EWMA baseline replaces a fixed number. 3σ is the usual starting point."
                  error={formErrors.z_threshold}
                >
                  <Input
                    type="number"
                    step={0.5}
                    min={0}
                    value={form.z_threshold}
                    onChange={(v) => patch({ z_threshold: v })}
                  />
                </FormField>
              )}

              <FormField
                label="Window (seconds)"
                hint={windowText(numOrNull(form.window_seconds)) || 'Instantaneous — fires on a single reading.'}
                error={formErrors.window_seconds}
              >
                <Input
                  type="number"
                  min={0}
                  value={form.window_seconds}
                  onChange={(v) => patch({ window_seconds: v })}
                />
              </FormField>

              <FormField label="Severity">
                <Select
                  value={form.severity}
                  onChange={(v) => patch({ severity: v as Severity })}
                  options={[
                    { value: 'critical', label: 'Critical' },
                    { value: 'warning', label: 'Warning' },
                    { value: 'info', label: 'Info' },
                  ]}
                />
              </FormField>

              <FormField
                label="Cooldown (seconds)"
                hint={
                  windowText(numOrNull(form.cooldown_seconds))
                    ? `${windowText(numOrNull(form.cooldown_seconds))} of quiet after each alert.`
                    : 'No cooldown — every match raises an alert.'
                }
                error={formErrors.cooldown_seconds}
              >
                <Input
                  type="number"
                  min={0}
                  value={form.cooldown_seconds}
                  onChange={(v) => patch({ cooldown_seconds: v })}
                />
              </FormField>
            </div>

            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border px-3 py-2"
              style={{ borderColor: 'var(--surface-3)' }}
            >
              <div className="min-w-0">
                <p className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  Reads as
                </p>
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {conditionText(
                    {
                      condition: form.condition,
                      metric_key: form.metric_key,
                      threshold: numOrNull(form.threshold),
                      threshold_high: numOrNull(form.threshold_high),
                      window_seconds: numOrNull(form.window_seconds) ?? 0,
                      z_threshold: numOrNull(form.z_threshold) ?? 3,
                    },
                    metricSchema
                  )}
                  {' · '}
                  {scopeText(
                    {
                      device_type_id: numOrNull(form.device_type_id),
                      site_id: numOrNull(form.site_id),
                      device_id: numOrNull(form.device_id),
                    },
                    types,
                    sites,
                    devices
                  )}
                </p>
              </div>
              <Toggle
                on={form.enabled}
                label="Rule enabled"
                onToggle={() => patch({ enabled: !form.enabled })}
              />
            </div>

            {saveForm.error && <ErrorState error={new Error(saveForm.error)} />}
          </div>
        )}
      </Modal>

      {/* ------------------------------ Delete ------------------------------- */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete rule"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirmDelete}
              pending={removeRule.pending}
              disabled={Boolean(demoBlock)}
              title={demoBlock}
            >
              Delete rule
            </Button>
          </>
        }
      >
        <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Delete <strong style={{ color: 'var(--text-primary)' }}>{deleteTarget?.name}</strong>? Nothing
          will evaluate this condition afterwards. Alerts it already raised stay in the history.
        </p>
        {deleteTarget?.natural_language_source && (
          <p className="mt-2 text-[12px] italic" style={{ color: 'var(--text-muted)' }}>
            “{deleteTarget.natural_language_source}”
          </p>
        )}
        {(deleteTarget?.fire_count ?? 0) > 0 && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            It has fired {deleteTarget?.fire_count} time
            {deleteTarget?.fire_count === 1 ? '' : 's'}
            {deleteTarget?.last_fired_at ? `, most recently ${timeAgo(deleteTarget.last_fired_at)}` : ''}. If you
            only want it quiet, disabling it keeps the history.
          </p>
        )}
        {removeRule.error && (
          <div className="mt-3">
            <ErrorState error={new Error(removeRule.error)} />
          </div>
        )}
      </Modal>
    </div>
  )
}
