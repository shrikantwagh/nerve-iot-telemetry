/**
 * Admin — configuration and provenance.
 *
 * Six panels on one screen rather than six screens, because they are all answers to the
 * same question: what is this instance made of, and who did what to it. Two of them are
 * the argument rather than the plumbing — **AI activity** puts the model, token count and
 * latency of every inference on the record (an AI feature that hides its own cost is
 * asking to be trusted rather than checked), and **Setup** carries the literal commands
 * that make the project reproducible by someone who just cloned it.
 *
 * Each panel fetches only when it is the visible tab: this instance is rate-limited, and
 * loading five datasets to show one is a self-inflicted outage.
 */

import { Fragment, useState } from 'react'
import api, { INSTANCE_BASE } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useAction, useAsync } from '../lib/useAsync'
import type { AsyncState } from '../lib/useAsync'
import { CATEGORY_LABEL, compact, dateTime, num, timeAgo } from '../lib/format'
import type { AiInsight, ApiKey, AuditEntry, DeviceType, MetricSchemaEntry, Site } from '../lib/types'
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
  Skeleton,
  Table,
} from '../components/ui'
import { StatTile } from '../components/StatTile'

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                */
/* -------------------------------------------------------------------------- */

type Tab = 'keys' | 'sites' | 'types' | 'ai' | 'audit' | 'setup'

const INSIGHT_KIND_LABEL: Record<string, string> = {
  fleet_digest: 'Fleet digest',
  predictive_maintenance: 'Predictive maintenance',
  anomaly_explanation: 'Anomaly explanation',
  incident_triage: 'Incident triage',
  postmortem: 'Postmortem',
  rule_synthesis: 'Rule synthesis',
  nl_query: 'Natural-language query',
}

const SOURCE_LABEL: Record<AuditEntry['source'], string> = {
  ui: 'UI',
  api: 'API',
  task: 'Task',
  device: 'Device',
  system: 'System',
}

const METRIC_KIND_LABEL: Record<string, string> = {
  gauge: 'Gauge',
  counter: 'Counter',
  state: 'State',
}

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : num(value, 2)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** Detail payloads are small json objects; a key/value table beats a wall of JSON. */
function KeyValues({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data)
  if (entries.length === 0)
    return (
      <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
        No detail recorded.
      </p>
    )
  return (
    <div className="scroll-x">
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <th
                scope="row"
                className="py-1 pr-3 text-left font-normal align-top whitespace-nowrap"
                style={{ color: 'var(--text-muted)' }}
              >
                {humanize(k)}
              </th>
              <td className="py-1 break-all" style={{ color: 'var(--text-primary)' }}>
                {scalarText(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2">
      <code
        className="scroll-x block flex-1 rounded-[6px] px-2.5 py-1.5 text-[12px] whitespace-pre"
        style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', fontFamily: 'var(--mono)' }}
      >
        {children}
      </code>
      <CopyButton text={children} />
    </div>
  )
}

function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-1">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={18} />
      ))}
    </div>
  )
}

function AdminOnly({ what }: { what: string }) {
  return (
    <Card>
      <EmptyState
        title={`${what} is admin-only`}
        hint="Your account has the operator or viewer role. The backend rejects these endpoints for non-admins, so the UI does not offer them — ask an admin on this workspace, or sign in with an admin account."
      />
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* 1 · API keys                                                               */
/* -------------------------------------------------------------------------- */

function ApiKeysTab({ sites }: { sites: AsyncState<Site[]> }) {
  const { can, isDemo } = useAuth()
  const isAdmin = can('admin')

  const keys = useAsync(() => api.admin.apiKeys(), [], { enabled: isAdmin })

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [siteId, setSiteId] = useState('')
  const [created, setCreated] = useState<{ api_key: ApiKey; plaintext: string; warning?: string } | null>(
    null
  )
  const [stored, setStored] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)

  const create = useAction((n: string, s?: number) => api.admin.createApiKey(n, s))
  const revoke = useAction((id: number) => api.admin.revokeApiKey(id))

  if (!isAdmin) return <AdminOnly what="API key management" />

  const disabledTitle = isDemo
    ? 'Disabled on the shared demo account — a real ingest key must not be mintable from a public login.'
    : undefined

  const submitCreate = async () => {
    if (name.trim().length < 2) return
    const result = await create.run(name.trim(), siteId ? Number(siteId) : undefined)
    if (result) {
      setCreateOpen(false)
      setName('')
      setSiteId('')
      setStored(false)
      setCreated(result)
      keys.reload()
    }
  }

  const submitRevoke = async () => {
    if (!revoking) return
    const result = await revoke.run(revoking.id)
    if (result) {
      setRevoking(null)
      keys.reload()
    }
  }

  const items = keys.data ?? []

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <SectionHeader
          title="Ingest API keys"
          subtitle="Devices and the simulator authenticate with a hashed API key, never a user token. The plaintext is shown once, at creation, and is not recoverable afterwards."
          action={
            <Button
              variant="primary"
              size="sm"
              disabled={isDemo}
              title={disabledTitle}
              onClick={() => {
                create.clearError()
                setCreateOpen(true)
              }}
            >
              Create key
            </Button>
          }
        />

        {keys.initial ? (
          <TableSkeleton />
        ) : keys.error ? (
          <ErrorState error={keys.error} onRetry={keys.reload} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No API keys yet"
            hint="Create one before running the simulator — it is the NERVE_API_KEY in simulator/.env. Scope it to a single site if the device population it feeds belongs to one."
          />
        ) : (
          <Table head={['Name', 'Prefix', 'Site', 'Status', 'Last used', 'Uses', '']}>
            {items.map((k) => (
              <Row key={k.id}>
                <Cell nowrap>
                  <span style={{ color: 'var(--text-primary)' }}>{k.name}</span>
                </Cell>
                <Cell nowrap>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {k.key_prefix}…
                  </span>
                </Cell>
                <Cell nowrap muted>
                  {k.site_name ?? (k.site_id ? `Site ${k.site_id}` : 'All sites')}
                </Cell>
                <Cell nowrap>
                  {k.enabled ? <Badge tone="good">Enabled</Badge> : <Badge>Revoked</Badge>}
                </Cell>
                <Cell nowrap muted>
                  {k.last_used_at ? timeAgo(k.last_used_at) : 'never'}
                </Cell>
                <Cell align="right" nowrap>
                  <span className="num-tabular">{compact(k.use_count ?? 0)}</span>
                </Cell>
                <Cell align="right" nowrap>
                  {k.enabled && (
                    <Button size="sm" disabled={isDemo} title={disabledTitle} onClick={() => setRevoking(k)}>
                      Revoke
                    </Button>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      {/* Create */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API key"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              pending={create.pending}
              disabled={name.trim().length < 2}
              onClick={submitCreate}
            >
              Create key
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name" hint="What holds this key — “Osaka simulator”, “freezer gateway fleet”.">
            <Input value={name} onChange={setName} placeholder="Osaka simulator" autoFocus onEnter={submitCreate} />
          </Field>
          <Field label="Site" hint="Scoping a key to a site limits what it can register and report for.">
            <Select
              value={siteId}
              onChange={setSiteId}
              options={[
                { value: '', label: 'All sites' },
                ...(sites.data ?? []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.code})` })),
              ]}
            />
          </Field>
          {create.error && (
            <p className="text-[12px]" style={{ color: 'var(--status-critical)' }}>
              {create.error}
            </p>
          )}
        </div>
      </Modal>

      {/* The one and only showing of the plaintext. Dismissal has to be deliberate. */}
      <Modal
        open={created !== null}
        onClose={() => {
          if (stored) setCreated(null)
        }}
        title="Copy this key now"
        footer={
          <Button variant="primary" disabled={!stored} onClick={() => setCreated(null)}>
            I have stored it — close
          </Button>
        }
      >
        {created && (
          <div className="flex flex-col gap-3">
            <Banner tone="critical">
              <strong style={{ color: 'var(--status-critical)' }}>
                This is the only time this key will ever be shown.
              </strong>{' '}
              Nerve stores a hash, not the key. Close this dialog without copying it and the only way
              forward is to revoke it and create another.
              {created.warning ? ` ${created.warning}` : ''}
            </Banner>

            <div
              className="rounded-[6px] border px-2.5 py-2 break-all"
              style={{
                borderColor: 'var(--status-critical)',
                background: 'var(--surface-2)',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--text-primary)',
              }}
            >
              {created.plaintext}
            </div>

            <div className="flex items-center gap-2">
              <CopyButton text={created.plaintext} label="Copy key" />
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Key “{created.api_key.name}”, prefix {created.api_key.key_prefix}… — the prefix is all you
                will see from here on.
              </span>
            </div>

            <label className="flex cursor-pointer items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={stored}
                onChange={(e) => setStored(e.target.checked)}
                style={{ accentColor: 'var(--accent)', marginTop: 2 }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>
                I have copied this key into <code style={{ fontFamily: 'var(--mono)' }}>simulator/.env</code>{' '}
                or a password manager.
              </span>
            </label>
            {!stored && (
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Escape and clicking outside are disabled until you confirm, on purpose.
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Revoke */}
      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke API key"
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button variant="danger" pending={revoke.pending} onClick={submitRevoke}>
              Revoke key
            </Button>
          </>
        }
      >
        {revoking && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Revoking “<strong style={{ color: 'var(--text-primary)' }}>{revoking.name}</strong>” (prefix{' '}
              {revoking.key_prefix}…) takes effect on the next ingest call. Any device or simulator still
              holding it stops reporting, and its devices will go offline on the next sweep.
            </p>
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Used {compact(revoking.use_count ?? 0)} times, last{' '}
              {revoking.last_used_at ? timeAgo(revoking.last_used_at) : 'never'}.
            </p>
            {revoke.error && (
              <p className="text-[12px]" style={{ color: 'var(--status-critical)' }}>
                {revoke.error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 2 · Sites                                                                  */
/* -------------------------------------------------------------------------- */

function SitesTab({ sites }: { sites: AsyncState<Site[]> }) {
  const { can, isDemo } = useAuth()
  const canWrite = can('admin')

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [timezone, setTimezone] = useState('')
  const [region, setRegion] = useState('')

  const create = useAction((payload: Partial<Site> & { code: string; name: string }) =>
    api.sites.create(payload)
  )

  const items = sites.data ?? []
  const disabledTitle = isDemo
    ? 'Disabled on the shared demo account.'
    : !canWrite
      ? 'Creating reference data requires the admin role.'
      : undefined

  const submit = async () => {
    if (code.trim().length < 2 || name.trim().length < 2) return
    const result = await create.run({
      code: code.trim().toUpperCase(),
      name: name.trim(),
      timezone: timezone.trim() || undefined,
      region: region.trim() || undefined,
    })
    if (result) {
      setCode('')
      setName('')
      setTimezone('')
      setRegion('')
      sites.reload()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <SectionHeader
          title="Sites"
          subtitle="A site is the tenancy boundary for devices, API keys and incident correlation. Its code is what a device sends at registration."
        />
        {sites.initial ? (
          <TableSkeleton />
        ) : sites.error ? (
          <ErrorState error={sites.error} onRetry={sites.reload} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No sites yet"
            hint="Seed the reference data from the Setup tab, or add the first site below. Nothing can be registered until at least one site exists."
          />
        ) : (
          <Table head={['Code', 'Name', 'Region', 'Timezone', 'Devices', 'Avg health', 'Open incidents']}>
            {items.map((s) => (
              <Row key={s.id}>
                <Cell nowrap>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{s.code}</span>
                </Cell>
                <Cell nowrap>{s.name}</Cell>
                <Cell nowrap muted>
                  {s.region || '—'}
                </Cell>
                <Cell nowrap muted>
                  {s.timezone || '—'}
                </Cell>
                <Cell align="right" nowrap>
                  <span className="num-tabular">{compact(s.device_count ?? 0)}</span>
                </Cell>
                <Cell nowrap>
                  {s.avg_health === undefined || s.avg_health === null ? (
                    <span style={{ color: 'var(--text-muted)' }}>—</span>
                  ) : (
                    <HealthMeter score={s.avg_health} />
                  )}
                </Cell>
                <Cell align="right" nowrap>
                  <span className="num-tabular">{s.open_incidents ?? 0}</span>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <SectionHeader title="Add a site" subtitle="Code is uppercase and permanent — devices register against it." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" hint="Short and stable, e.g. OSA-01.">
            <Input value={code} onChange={setCode} placeholder="OSA-01" disabled={!canWrite || isDemo} />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={setName} placeholder="Osaka Distribution Centre" disabled={!canWrite || isDemo} />
          </Field>
          <Field label="Timezone" hint="IANA name, e.g. Asia/Tokyo.">
            <Input value={timezone} onChange={setTimezone} placeholder="Asia/Tokyo" disabled={!canWrite || isDemo} />
          </Field>
          <Field label="Region">
            <Input value={region} onChange={setRegion} placeholder="APAC" disabled={!canWrite || isDemo} />
          </Field>
        </div>
        {create.error && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--status-critical)' }}>
            {create.error}
          </p>
        )}
        <div className="mt-3">
          <Button
            variant="primary"
            pending={create.pending}
            disabled={!canWrite || isDemo || code.trim().length < 2 || name.trim().length < 2}
            title={disabledTitle}
            onClick={submit}
          >
            Create site
          </Button>
        </div>
      </Card>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 3 · Device types                                                           */
/* -------------------------------------------------------------------------- */

function nominalRange(m: MetricSchemaEntry): string {
  const lo = m.nominal_min
  const hi = m.nominal_max
  if ((lo === null || lo === undefined) && (hi === null || hi === undefined)) return '—'
  const fmt = (v: number) => num(v, Math.abs(v) < 10 ? 1 : 0)
  if (lo !== null && lo !== undefined && hi !== null && hi !== undefined)
    return `${fmt(lo)} to ${fmt(hi)}${m.unit ? ` ${m.unit}` : ''}`
  if (lo !== null && lo !== undefined) return `≥ ${fmt(lo)}${m.unit ? ` ${m.unit}` : ''}`
  return `≤ ${fmt(hi as number)}${m.unit ? ` ${m.unit}` : ''}`
}

function DeviceTypeCard({ type }: { type: DeviceType }) {
  const [open, setOpen] = useState(false)
  const schema = type.metric_schema ?? []
  const panelId = `schema-${type.id}`

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {type.name}
            </h3>
            <Badge tone="accent">{CATEGORY_LABEL[type.category] ?? type.category}</Badge>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>
              {type.code}
            </span>
          </div>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {[type.manufacturer, type.model].filter(Boolean).join(' · ') || 'No manufacturer recorded'}
            {type.offline_after_seconds
              ? ` · offline after ${type.offline_after_seconds}s of silence`
              : ''}
          </p>
        </div>
        <div className="text-right">
          <span className="num-tabular block text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {compact(type.device_count ?? 0)}
          </span>
          <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
            devices
          </span>
        </div>
      </div>

      <div className="mt-3 rounded-[6px] border" style={{ borderColor: 'var(--surface-3)' }}>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left"
        >
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            Metric schema — {schema.length} {schema.length === 1 ? 'metric' : 'metrics'} declared
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {open ? 'Hide' : 'Show'}
          </span>
        </button>

        {open && (
          <div id={panelId} className="border-t" style={{ borderColor: 'var(--surface-3)' }}>
            {schema.length === 0 ? (
              <div className="px-2.5 py-2">
                <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  No metrics declared. A device of this type can still report, but nothing knows what its
                  values mean — no units on charts, no nominal bands, no anomaly baselines worth trusting.
                </p>
              </div>
            ) : (
              <Table head={['Key', 'Label', 'Unit', 'Kind', 'Nominal range', 'Precision']}>
                {schema.map((m) => (
                  <Row key={m.key}>
                    <Cell nowrap>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{m.key}</span>
                    </Cell>
                    <Cell nowrap>{m.label}</Cell>
                    <Cell nowrap muted>
                      {m.unit || '—'}
                    </Cell>
                    <Cell nowrap muted>
                      {METRIC_KIND_LABEL[m.kind] ?? m.kind}
                    </Cell>
                    <Cell nowrap muted>
                      {nominalRange(m)}
                    </Cell>
                    <Cell align="right" nowrap muted>
                      {m.precision ?? '—'}
                    </Cell>
                  </Row>
                ))}
              </Table>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

function DeviceTypesTab() {
  const types = useAsync(() => api.deviceTypes.list(), [])
  const items = types.data ?? []

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <SectionHeader
          title="Device types"
          subtitle="The declaration that makes onboarding one call instead of six console screens: a device sends a serial and a type code, and the type supplies its metric contract, units, nominal bands and offline threshold."
        />
        {types.initial ? (
          <TableSkeleton rows={4} />
        ) : types.error ? (
          <ErrorState error={types.error} onRetry={types.reload} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No device types yet"
            hint="Seed the reference data from the Setup tab — it creates the freezer, AMR, CNC, HVAC, power and gateway types the simulator reports against."
          />
        ) : (
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {items.length} types, {compact(items.reduce((a, t) => a + (t.device_count ?? 0), 0))} devices,{' '}
            {items.reduce((a, t) => a + (t.metric_schema?.length ?? 0), 0)} declared metrics in total.
          </p>
        )}
      </Card>

      {items.map((t) => (
        <DeviceTypeCard key={t.id} type={t} />
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 4 · AI activity                                                            */
/* -------------------------------------------------------------------------- */

function AiActivityTab() {
  const insights = useAsync(() => api.ai.insights(), [])
  const items: AiInsight[] = insights.data?.items ?? []

  const totalLogged = insights.data?.itemsTotal ?? items.length
  const fallbacks = items.filter((i) => i.fallback_used).length
  const tokensIn = items.reduce((a, i) => a + (i.input_tokens ?? 0), 0)
  const tokensOut = items.reduce((a, i) => a + (i.output_tokens ?? 0), 0)

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <SectionHeader
          title="AI activity"
          subtitle="Every inference is logged server-side with its model, token counts and latency. Cost and provenance are part of the product, not debug output — and a fallback is not a failure, it is the deterministic analyzer keeping a demo alive through a rate limit."
        />

        {insights.initial ? (
          <TableSkeleton />
        ) : insights.error ? (
          <ErrorState error={insights.error} onRetry={insights.reload} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No inferences logged yet"
            hint="The AI runs server-side on triage, digests, rule synthesis and questions asked on the Ask screen. Ask a question or run a triage and it shows up here with its cost."
          />
        ) : (
          <>
            <div className="mb-3 grid gap-3 sm:grid-cols-3">
              <StatTile label="Inferences logged" value={totalLogged} hint="all time" />
              <StatTile
                label="Fell back to the analyzer"
                value={fallbacks}
                accent={fallbacks > 0 ? 'var(--status-serious)' : undefined}
                hint={`of the ${items.length} most recent`}
              />
              <StatTile
                label="Tokens"
                value={tokensIn + tokensOut}
                hint={`${compact(tokensIn)} in · ${compact(tokensOut)} out, most recent ${items.length}`}
              />
            </div>

            <Table head={['Kind', 'Title', 'Model', 'Tokens in', 'Tokens out', 'Latency', 'Source', 'When']}>
              {items.map((i) => (
                <Row key={i.id}>
                  <Cell nowrap>{INSIGHT_KIND_LABEL[i.kind] ?? humanize(i.kind)}</Cell>
                  <Cell>
                    <span style={{ color: 'var(--text-primary)' }}>{i.title || '—'}</span>
                    {i.error && (
                      <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--status-critical)' }}>
                        {i.error}
                      </span>
                    )}
                  </Cell>
                  <Cell nowrap muted>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{i.model || '—'}</span>
                  </Cell>
                  <Cell align="right" nowrap muted>
                    <span className="num-tabular">{compact(i.input_tokens ?? 0)}</span>
                  </Cell>
                  <Cell align="right" nowrap muted>
                    <span className="num-tabular">{compact(i.output_tokens ?? 0)}</span>
                  </Cell>
                  <Cell align="right" nowrap muted>
                    <span className="num-tabular">
                      {i.latency_ms === undefined || i.latency_ms === null
                        ? '—'
                        : `${num(i.latency_ms / 1000, 1)}s`}
                    </span>
                  </Cell>
                  <Cell nowrap>
                    {i.fallback_used ? <Badge tone="warning">Fallback</Badge> : <Badge tone="accent">Model</Badge>}
                  </Cell>
                  <Cell nowrap muted>
                    {timeAgo(i.created_at)}
                  </Cell>
                </Row>
              ))}
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 5 · Audit log                                                              */
/* -------------------------------------------------------------------------- */

function AuditTab() {
  const log = useAsync(() => api.admin.auditLog(), [])
  const [openId, setOpenId] = useState<number | null>(null)
  const items: AuditEntry[] = log.data?.items ?? []

  return (
    <Card>
      <SectionHeader
        title="Audit log"
        subtitle="Who did what, from where. Written by post-middleware on the API groups, so device and task activity lands here alongside anything a person clicked."
      />

      {log.initial ? (
        <TableSkeleton rows={6} />
      ) : log.error ? (
        <ErrorState error={log.error} onRetry={log.reload} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing logged yet"
          hint="Acknowledge an alert, issue a command or create an API key and the entry appears here with its detail payload."
        />
      ) : (
        <Table head={['When', 'User', 'Action', 'Entity', 'Source', '']}>
          {items.map((e) => {
            const detail = (e.detail ?? {}) as Record<string, unknown>
            const hasDetail = Object.keys(detail).length > 0 || Boolean(e.ip)
            const open = openId === e.id
            return (
              <Fragment key={e.id}>
                <Row>
                  <Cell nowrap muted>
                    <span title={dateTime(e.created_at)}>{timeAgo(e.created_at)}</span>
                  </Cell>
                  <Cell nowrap>{e.user_name ?? (e.user_id ? `User ${e.user_id}` : 'system')}</Cell>
                  <Cell nowrap>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{e.action}</span>
                  </Cell>
                  <Cell nowrap muted>
                    {e.entity_type ? `${e.entity_type}${e.entity_id ? ` #${e.entity_id}` : ''}` : '—'}
                  </Cell>
                  <Cell nowrap>
                    <Badge>{SOURCE_LABEL[e.source] ?? e.source}</Badge>
                  </Cell>
                  <Cell align="right" nowrap>
                    {hasDetail && (
                      <button
                        onClick={() => setOpenId(open ? null : e.id)}
                        aria-expanded={open}
                        className="cursor-pointer text-[12px] font-medium"
                        style={{ color: 'var(--accent)' }}
                      >
                        {open ? 'Hide detail' : 'Detail'}
                      </button>
                    )}
                  </Cell>
                </Row>
                {open && (
                  <tr>
                    <td
                      colSpan={6}
                      className="border-b px-3 py-2"
                      style={{ borderColor: 'var(--surface-3)', background: 'var(--surface-2)' }}
                    >
                      <KeyValues data={e.ip ? { ...detail, ip: e.ip } : detail} />
                      <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {dateTime(e.created_at)}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </Table>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* 6 · Setup                                                                  */
/* -------------------------------------------------------------------------- */

function SetupTab({ sites }: { sites: AsyncState<Site[]> }) {
  const { can, isDemo } = useAuth()
  const isAdmin = can('admin')

  const seed = useAction(() => api.admin.seed())
  const [result, setResult] = useState<{
    sites: number
    device_types: number
    alert_rules: number
    message?: string
  } | null>(null)

  const firstSiteCode = sites.data?.[0]?.code ?? 'OSA-01'

  const runSeed = async () => {
    const res = await seed.run()
    if (res) {
      setResult(res)
      sites.reload()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <SectionHeader
          title="Seed reference data"
          subtitle="Idempotent: it ensures the demo sites, device types and starter alert rules exist, and leaves anything already present alone. Safe to run twice."
          action={
            <Button
              variant="primary"
              size="sm"
              pending={seed.pending}
              disabled={!isAdmin || isDemo}
              title={
                isDemo
                  ? 'Disabled on the shared demo account.'
                  : !isAdmin
                    ? 'Seeding requires the admin role.'
                    : undefined
              }
              onClick={runSeed}
            >
              Seed reference data
            </Button>
          }
        />
        {seed.error && (
          <p className="text-[12px]" style={{ color: 'var(--status-critical)' }}>
            {seed.error}
          </p>
        )}
        {result && (
          <div className="flex flex-col gap-2">
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Sites in place" value={result.sites} />
              <StatTile label="Device types in place" value={result.device_types} />
              <StatTile label="Alert rules in place" value={result.alert_rules} />
            </div>
            <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {result.message ??
                'These are the totals now present. Rows that already existed were left untouched rather than duplicated.'}
            </p>
          </div>
        )}
        {!result && !seed.error && (
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            Run this once on a fresh instance, before the simulator. Without device types there is nothing
            for a device to register as.
          </p>
        )}
      </Card>

      <Card>
        <SectionHeader
          title="Simulator quickstart"
          subtitle="The fleet in this demo is a Node script talking to the ingest API the way real devices would. These are the literal commands."
        />

        <ol className="flex flex-col gap-3">
          <li>
            <p className="mb-1.5 text-[13px]" style={{ color: 'var(--text-primary)' }}>
              1 · Give the simulator credentials. Create an ingest key on the{' '}
              <strong>API keys</strong> tab above, then put it in{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>simulator/.env</code>:
            </p>
            <CodeBlock>{`NERVE_API_BASE=${INSTANCE_BASE}\nNERVE_API_KEY=<the key shown once at creation>`}</CodeBlock>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              The plaintext key is unrecoverable, so if you skipped copying it, revoke and create another.
              The simulator appends the ingest group path itself.
            </p>
          </li>

          <li>
            <p className="mb-1.5 text-[13px]" style={{ color: 'var(--text-primary)' }}>
              2 · Backfill a day of history, so charts, baselines and the predictive sweep have something
              to fit:
            </p>
            <CodeBlock>node simulator/index.js --backfill 24</CodeBlock>
          </li>

          <li>
            <p className="mb-1.5 text-[13px]" style={{ color: 'var(--text-primary)' }}>
              3 · Inject a named fault to watch correlation work end to end:
            </p>
            <CodeBlock>{`node simulator/index.js --scenario freezer-door-ajar --site ${firstSiteCode}`}</CodeBlock>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              One site's freezers drift up together — the alerts collapse into a single incident with a
              root-cause hypothesis. Other scenarios: <code style={{ fontFamily: 'var(--mono)' }}>amr-battery-degradation</code>,{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>gateway-drop</code>,{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>spindle-bearing-wear</code>,{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>hvac-short-cycling</code>,{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>power-brownout</code>.
            </p>
          </li>
        </ol>

        <Banner tone="accent">
          Devices authenticate with the API key, never a user token — which is why no ingest credential
          appears anywhere in this bundle. The browser holds your session token and nothing else.
        </Banner>
      </Card>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function Admin() {
  const { can } = useAuth()
  const isAdmin = can('admin')
  const [tab, setTab] = useState<Tab>(() => (isAdmin ? 'keys' : 'sites'))

  // Sites are needed by three panels, so they are fetched once here.
  const sites = useAsync(() => api.sites.list(), [])

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Admin"
        subtitle="What this instance is made of, what the AI has cost, and who changed what."
      />

      <div className="scroll-x pb-1">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'keys', label: 'API keys' },
            { value: 'sites', label: 'Sites' },
            { value: 'types', label: 'Device types' },
            { value: 'ai', label: 'AI activity' },
            { value: 'audit', label: 'Audit log' },
            { value: 'setup', label: 'Setup' },
          ]}
        />
      </div>

      {tab === 'keys' && <ApiKeysTab sites={sites} />}
      {tab === 'sites' && <SitesTab sites={sites} />}
      {tab === 'types' && <DeviceTypesTab />}
      {tab === 'ai' && <AiActivityTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'setup' && <SetupTab sites={sites} />}
    </div>
  )
}
