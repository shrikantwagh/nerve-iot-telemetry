/**
 * Overview — the landing screen.
 *
 * It answers two questions and nothing else: is the fleet okay, and if not, what do I
 * open first. So the reading order is deliberate: one hero number, the AI digest that
 * says what changed, then the ranked incident queue. Everything below that is context.
 *
 * The overview payload itself arrives as a prop — App.tsx owns that fetch because the
 * sidebar badges read the same numbers, and fetching it twice on a rate-limited free-tier
 * instance is a self-inflicted outage. This screen adds three calls of its own.
 */

import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { useAsync, useAction } from '../lib/useAsync'
import type { AsyncState } from '../lib/useAsync'
import { useAuth } from '../lib/auth'
import type { AiInsight, FleetOverview, Incident, Severity, Site } from '../lib/types'
import { compact, dateTime, duration, num, timeAgo } from '../lib/format'
import {
  Badge,
  Button,
  Card,
  Cell,
  EmptyState,
  ErrorState,
  HealthMeter,
  LinkCell,
  Row,
  SectionHeader,
  SeverityBadge,
  Skeleton,
  StatusDot,
  Table,
} from '../components/ui'
import { HeroFigure, StatTile } from '../components/StatTile'
import { HealthHistogram } from '../components/charts/HealthHistogram'

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }
const SEVERITIES: Severity[] = ['critical', 'warning', 'info']

/** Two lines, then an ellipsis. The full text lives on the incident page. */
const CLAMP_2: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  color: 'var(--text-secondary)',
}

const sumCounts = (counts: Partial<Record<Severity, number>> | undefined) =>
  SEVERITIES.reduce((total, s) => total + (counts?.[s] ?? 0), 0)

/** Worst site = most open incidents, tie broken by the lower average health. */
function worstSite(sites: Site[] | undefined): Site | null {
  if (!sites?.length) return null
  const ranked = [...sites].sort((a, b) => {
    const byIncidents = (b.open_incidents ?? 0) - (a.open_incidents ?? 0)
    if (byIncidents !== 0) return byIncidents
    return (a.avg_health ?? 101) - (b.avg_health ?? 101)
  })
  const top = ranked[0]
  return (top.open_incidents ?? 0) > 0 ? top : null
}

/**
 * The digest body comes back as prose with bullet lines. Rendering it as one blob loses
 * the structure the model was asked for, so lines that start a bullet become a list.
 */
function DigestBody({ body }: { body: string }) {
  const blocks = useMemo(() => {
    const lines = body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const out: { kind: 'p' | 'ul'; items: string[] }[] = []
    for (const line of lines) {
      const bullet = /^([-*•]|\d+[.)])\s+/.exec(line)
      const text = bullet ? line.slice(bullet[0].length) : line
      const kind = bullet ? 'ul' : 'p'
      const last = out[out.length - 1]
      if (last && last.kind === kind && kind === 'ul') last.items.push(text)
      else out.push({ kind, items: [text] })
    }
    return out
  }, [body])

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) =>
        block.kind === 'ul' ? (
          <ul key={i} className="flex flex-col gap-1 pl-4">
            {block.items.map((item, j) => (
              <li key={j} className="list-disc text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {block.items[0]}
          </p>
        )
      )}
    </div>
  )
}

/** Small labelled shell so each section reads the same whether it has data or not. */
function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <SectionHeader title={title} subtitle={subtitle} action={action} />
      {children}
    </Card>
  )
}

function RowsSkeleton({ rows = 4, height = 18 }: { rows?: number; height?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} />
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function Overview({ overview }: { overview: AsyncState<FleetOverview> }) {
  const { can, isDemo } = useAuth()
  const data = overview.data

  // Only meaningful once we know there is a fleet at all — a cold instance should not
  // spend its request budget on three empty lists.
  const hasFleet = (data?.device_total ?? 0) > 0

  const distribution = useAsync(() => api.fleet.healthDistribution(), [hasFleet], { enabled: hasFleet })

  const incidentList = useAsync(
    (signal) => api.incidents.list({ state: 'open', page: 1 }, signal),
    [hasFleet],
    { enabled: hasFleet, pollMs: 90_000 }
  )

  // The overview embeds the newest digest. Fetch it separately only when it did not.
  const wantsDigestFetch = Boolean(data) && !data?.digest
  const digestFetch = useAsync(() => api.ai.digest(), [wantsDigestFetch], { enabled: wantsDigestFetch })

  const [refreshed, setRefreshed] = useState<AiInsight | null>(null)
  const refreshDigest = useAction(async () => {
    const next = await api.ai.digest(true)
    if (next) setRefreshed(next)
    return next
  })

  const digest: AiInsight | null = refreshed ?? data?.digest ?? digestFetch.data ?? null

  /* ---- derived numbers ---- */

  const onlineCount = data?.status_counts?.online ?? 0
  const offlineCount = data?.status_counts?.offline ?? 0
  const degradedCount = data?.status_counts?.degraded ?? 0
  const openIncidents = data?.open_incident_total ?? sumCounts(data?.incident_counts)
  const firingAlerts = data?.firing_alert_total ?? sumCounts(data?.alert_counts)
  const sites = data?.sites ?? []
  const worstDevices = data?.worst_devices ?? []
  const worst = worstSite(sites)

  const topIncidents = useMemo(() => {
    const items = incidentList.data?.items ?? []
    return [...items]
      .filter((i) => i.state !== 'resolved')
      .sort((a, b) => {
        const bySeverity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
        if (bySeverity !== 0) return bySeverity
        // Then oldest first: an incident that has been burning for a day outranks a
        // fresh one of the same severity.
        return new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime()
      })
      .slice(0, 5)
  }, [incidentList.data])

  /* ---- whole-page states ---- */

  if (overview.error && !data) {
    return (
      <div className="flex flex-col gap-4">
        <ErrorState error={overview.error} onRetry={overview.reload} />
      </div>
    )
  }

  if (overview.initial || !data) {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <div className="grid items-center gap-4 lg:grid-cols-[minmax(200px,260px)_1fr]">
            <div className="flex flex-col gap-2">
              <Skeleton height={12} width={120} />
              <Skeleton height={44} width={160} />
              <Skeleton height={12} width={180} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} height={92} />
              ))}
            </div>
          </div>
        </Card>
        <Card>
          <RowsSkeleton rows={5} />
        </Card>
        <Card>
          <RowsSkeleton rows={5} height={28} />
        </Card>
      </div>
    )
  }

  /* ---- cold instance: no devices have ever reported ---- */

  if (!hasFleet) {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <EmptyState
            title="No devices have reported yet"
            hint={
              <>
                Nerve is connected to your Xano instance, but the fleet is empty — so every
                number on this screen would be a zero. Two steps fix that: seed the reference
                data (sites, device types, starter alert rules) from <strong>Admin</strong>, then
                run the simulator so virtual devices register themselves and start streaming
                telemetry.
              </>
            }
            action={
              <div className="mt-2 flex flex-col items-center gap-3">
                <div className="flex flex-wrap justify-center gap-2">
                  {can('admin') ? (
                    <Link to="/admin" className="no-underline">
                      <Button variant="primary">Go to Admin and seed</Button>
                    </Link>
                  ) : (
                    <Button variant="primary" disabled title="Seeding reference data requires an admin account.">
                      Go to Admin and seed
                    </Button>
                  )}
                  <Link to="/admin" className="no-underline">
                    <Button>Create an ingest API key</Button>
                  </Link>
                </div>
                <div className="w-full max-w-md text-left">
                  <p className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Then, from the repo root, backfill 24 hours of history:
                  </p>
                  <pre
                    className="scroll-x rounded-[6px] border px-3 py-2"
                    style={{
                      background: 'var(--surface-2)',
                      borderColor: 'var(--surface-3)',
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      color: 'var(--text-primary)',
                      margin: 0,
                    }}
                  >
                    <code>node simulator/index.js --backfill 24</code>
                  </pre>
                  <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    The simulator registers its devices through the ingest API, so no manual
                    device setup is needed. This screen refreshes on its own every 60 seconds.
                  </p>
                </div>
              </div>
            }
          />
        </Card>
      </div>
    )
  }

  /* ---- the live screen ---- */

  const alertHint = (
    <span className="flex flex-wrap items-center gap-1">
      {SEVERITIES.filter((s) => (data.alert_counts?.[s] ?? 0) > 0).map((s) => (
        <SeverityBadge key={s} severity={s} count={data.alert_counts?.[s] ?? 0} />
      ))}
      {firingAlerts === 0 && <span style={{ color: 'var(--text-muted)' }}>nothing firing</span>}
    </span>
  )

  return (
    <div className="flex flex-col gap-4">
      {/* 1 — one hero number, plus the supporting row */}
      <Card>
        <div className="grid items-center gap-5 lg:grid-cols-[minmax(210px,270px)_1fr]">
          {openIncidents > 0 ? (
            <HeroFigure
              label="Open incidents"
              value={openIncidents}
              unit={openIncidents === 1 ? 'incident' : 'incidents'}
              accent="var(--status-critical)"
              sub={
                worst ? (
                  <>
                    Worst site: <strong style={{ color: 'var(--text-primary)' }}>{worst.name}</strong> —{' '}
                    {worst.open_incidents ?? 0} open, avg health {num(worst.avg_health, 0)}
                  </>
                ) : (
                  <>Spread across the fleet — no single site dominates.</>
                )
              }
            />
          ) : (
            <HeroFigure
              label="Average fleet health"
              value={num(data.avg_health, 0)}
              unit="/ 100"
              accent="var(--status-good)"
              sub={
                <>
                  All clear — no open incidents across {compact(data.device_total)}{' '}
                  {data.device_total === 1 ? 'device' : 'devices'}
                  {data.unhealthy_count > 0 ? `, though ${data.unhealthy_count} need watching.` : '.'}
                </>
              }
            />
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            <StatTile
              label="Devices online"
              value={`${compact(onlineCount)}/${compact(data.device_total)}`}
              to="/fleet"
              hint={
                degradedCount > 0
                  ? `${degradedCount} degraded`
                  : `${data.device_total ? Math.round((onlineCount / data.device_total) * 100) : 0}% reporting`
              }
            />
            <StatTile
              label="Firing alerts"
              value={firingAlerts}
              accent={firingAlerts > 0 ? 'var(--status-warning)' : undefined}
              to="/alerts"
              hint={alertHint}
            />
            <StatTile
              label="Offline devices"
              value={offlineCount}
              accent={offlineCount > 0 ? 'var(--status-critical)' : undefined}
              to="/fleet?status=offline"
              hint={offlineCount === 0 ? 'everything reporting' : 'not reporting in'}
            />
            <StatTile
              label="Average health"
              value={num(data.avg_health, 0)}
              unit="/100"
              hint={`${data.unhealthy_count} below par`}
            />
            <StatTile
              label="Readings"
              value={data.readings_last_hour}
              hint="last hour"
            />
          </div>
        </div>
      </Card>

      {/* 2 — the AI digest, with its provenance stated out loud */}
      <Section
        title="AI fleet digest"
        subtitle="What changed across the fleet in the last 24 hours, written by the model that read it."
        action={
          can('operator') ? (
            <Button
              size="sm"
              onClick={() => refreshDigest.run()}
              pending={refreshDigest.pending}
              disabled={isDemo}
              title={
                isDemo
                  ? 'The demo account is read-only, so it cannot spend a model call. Sign in as an operator to regenerate.'
                  : 'Regenerate the digest now (one model call)'
              }
            >
              {refreshDigest.pending ? 'Generating…' : 'Refresh'}
            </Button>
          ) : undefined
        }
      >
        {refreshDigest.error && (
          <p className="mb-2 text-[12px]" style={{ color: 'var(--status-critical)' }}>
            Could not regenerate: {refreshDigest.error}
          </p>
        )}

        {digestFetch.initial && wantsDigestFetch && !digest ? (
          <RowsSkeleton rows={3} />
        ) : digestFetch.error && !digest ? (
          <ErrorState error={digestFetch.error} onRetry={digestFetch.reload} />
        ) : !digest ? (
          <EmptyState
            title="No digest has been generated yet"
            hint={
              can('operator')
                ? 'The daily digest task runs at 06:00. Use Refresh above to generate one right now.'
                : 'The daily digest task runs at 06:00. An operator can generate one on demand.'
            }
          />
        ) : (
          <div>
            {digest.title && (
              <h3 className="mb-1.5 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {digest.title}
              </h3>
            )}

            {digest.fallback_used && (
              <div
                className="mb-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                style={{ borderColor: 'var(--status-serious)', color: 'var(--text-secondary)' }}
              >
                <strong style={{ color: 'var(--text-primary)' }}>Generated without the AI model.</strong>{' '}
                The model call did not complete, so this summary came from the deterministic
                fallback analyzer — accurate on the numbers, but none of the wording is inference.
              </div>
            )}

            {digest.body ? (
              <DigestBody body={digest.body} />
            ) : (
              <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                The digest was recorded with an empty body.
              </p>
            )}

            {/* Provenance. This line is the answer to "can I trust this?", so it is
                always rendered — model, latency, cost and age, never hidden. */}
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <Badge tone={digest.fallback_used ? 'warning' : 'accent'}>
                {digest.fallback_used ? 'Deterministic fallback' : 'Model output'}
              </Badge>
              <span>{digest.fallback_used ? 'no model was called' : (digest.model ?? 'model not recorded')}</span>
              {digest.latency_ms !== undefined && digest.latency_ms !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="num-tabular">{num(digest.latency_ms / 1000, 1)}s</span>
                </>
              )}
              {(digest.input_tokens || digest.output_tokens) && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="num-tabular">
                    {compact(digest.input_tokens ?? 0)} in / {compact(digest.output_tokens ?? 0)} out tokens
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span title={dateTime(digest.created_at)}>generated {timeAgo(digest.created_at)}</span>
              {digest.confidence !== undefined && digest.confidence !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="num-tabular">confidence {Math.round(digest.confidence * 100)}%</span>
                </>
              )}
            </p>
          </div>
        )}
      </Section>

      {/* 3 — the queue. The most important list on the screen. */}
      <Section
        title="Open incidents"
        subtitle={
          openIncidents > 0
            ? `${openIncidents} open — the ${Math.min(topIncidents.length || 5, 5)} most urgent first, by severity then age.`
            : 'Correlated clusters of alerts, ranked by severity then age.'
        }
        action={
          <Link to="/incidents" className="text-[12px] font-medium hover:underline" style={{ color: 'var(--accent)' }}>
            All incidents →
          </Link>
        }
      >
        {incidentList.initial ? (
          <RowsSkeleton rows={3} height={52} />
        ) : incidentList.error ? (
          <ErrorState error={incidentList.error} onRetry={incidentList.reload} />
        ) : topIncidents.length === 0 ? (
          <EmptyState
            title={openIncidents > 0 ? 'No incidents in the open queue' : 'Nothing needs your attention'}
            hint={
              openIncidents > 0 ? (
                <>
                  The fleet summary counts {openIncidents} open, but none came back in this
                  queue — they may be assigned a different state. Open the{' '}
                  <Link to="/incidents" style={{ color: 'var(--accent)' }}>
                    incidents list
                  </Link>{' '}
                  to see all of them.
                </>
              ) : (
                'No alerts have correlated into an incident. Alerts still firing individually show up under Alerts, and the correlation task sweeps every 2 minutes.'
              )
            }
          />
        ) : (
          <ul className="flex flex-col">
            {topIncidents.map((incident, idx) => (
              <IncidentRow key={incident.id} incident={incident} first={idx === 0} />
            ))}
          </ul>
        )}
      </Section>

      {/* 4 — health distribution */}
      <Card>
        {distribution.initial ? (
          <RowsSkeleton rows={5} height={30} />
        ) : distribution.error ? (
          <ErrorState error={distribution.error} onRetry={distribution.reload} />
        ) : !distribution.data || distribution.data.buckets.length === 0 ? (
          <EmptyState
            title="No health scores yet"
            hint="Health is computed once a device has reported telemetry. Run the simulator, or wait for the next ingest."
          />
        ) : (
          <HealthHistogram buckets={distribution.data.buckets} total={data.device_total} />
        )}
      </Card>

      {/* 5 — sites */}
      <Section title="Sites" subtitle="Where the fleet lives, and where the trouble is concentrated.">
        {sites.length === 0 ? (
          <EmptyState
            title="No sites defined"
            hint="Sites come from the seed step in Admin, or you can add them there by hand."
          />
        ) : (
          <Table head={['Site', 'Devices', 'Open incidents', 'Avg health']}>
            {[...sites]
              .sort((a, b) => (b.open_incidents ?? 0) - (a.open_incidents ?? 0))
              .map((site) => (
                <Row key={site.id}>
                  <LinkCell to={`/fleet?site_id=${site.id}`}>
                    {site.name}
                    {site.code && (
                      <span className="ml-1.5 text-[11px] font-normal" style={{ color: 'var(--text-muted)' }}>
                        {site.code}
                      </span>
                    )}
                  </LinkCell>
                  <Cell align="right" muted nowrap>
                    <span className="num-tabular">{compact(site.device_count ?? 0)}</span>
                  </Cell>
                  <Cell align="right" nowrap>
                    {(site.open_incidents ?? 0) > 0 ? (
                      <Badge tone="critical">{site.open_incidents} open</Badge>
                    ) : (
                      <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                        none
                      </span>
                    )}
                  </Cell>
                  <Cell nowrap>
                    <HealthMeter score={site.avg_health} />
                  </Cell>
                </Row>
              ))}
          </Table>
        )}
      </Section>

      {/* 6 — worst devices */}
      <Section
        title="Devices needing attention"
        subtitle="Lowest composite health first — the shortlist to triage after the incidents."
        action={
          <Link to="/fleet" className="text-[12px] font-medium hover:underline" style={{ color: 'var(--accent)' }}>
            Full fleet →
          </Link>
        }
      >
        {worstDevices.length === 0 ? (
          <EmptyState
            title="Every device is healthy"
            hint="Nothing is scoring low enough to shortlist. The full fleet grid is one click away."
          />
        ) : (
          <Table head={['Device', 'Type', 'Site', 'Health', 'Status', 'Last seen']}>
            {worstDevices.map((device) => (
              <Row key={device.id}>
                <LinkCell to={`/devices/${device.id}`}>{device.name}</LinkCell>
                <Cell muted nowrap>
                  {device.device_type_name ?? device.device_type?.name ?? '—'}
                </Cell>
                <Cell muted nowrap>
                  {device.site_name ?? device.site?.name ?? '—'}
                </Cell>
                <Cell nowrap>
                  <HealthMeter score={device.health_score} />
                </Cell>
                <Cell nowrap>
                  <StatusDot status={device.status} />
                </Cell>
                <Cell muted nowrap>
                  <span title={dateTime(device.last_seen_at)}>{timeAgo(device.last_seen_at)}</span>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Incident row                                                               */
/* -------------------------------------------------------------------------- */

function IncidentRow({ incident, first }: { incident: Incident; first: boolean }) {
  return (
    <li
      className={`${first ? '' : 'border-t'} py-3 first:pt-0 last:pb-0`}
      style={{ borderColor: 'var(--surface-3)' }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SeverityBadge severity={incident.severity} />
        <Link
          to={`/incidents/${incident.id}`}
          className="min-w-0 text-[14px] font-semibold hover:underline"
          style={{ color: 'var(--text-primary)' }}
        >
          {incident.title}
        </Link>
        {incident.state !== 'open' && <Badge>{incident.state}</Badge>}
      </div>

      <div
        className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        <span className="num-tabular">
          {incident.device_count} {incident.device_count === 1 ? 'device' : 'devices'}
        </span>
        <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
          ·
        </span>
        <span className="num-tabular">
          {incident.alert_count} {incident.alert_count === 1 ? 'alert' : 'alerts'}
        </span>
        <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
          ·
        </span>
        <span>{incident.site_name ?? 'Multiple sites'}</span>
        <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
          ·
        </span>
        <span title={dateTime(incident.opened_at)}>open {duration(incident.opened_at)}</span>
      </div>

      {incident.ai_summary ? (
        <p className="mt-1.5 max-w-3xl text-[13px]" style={CLAMP_2} title={incident.ai_summary}>
          {incident.ai_summary}
        </p>
      ) : (
        <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          No AI summary yet — the correlation task writes one on its next sweep, or you can
          run the analysis from the incident page.
        </p>
      )}
    </li>
  )
}
