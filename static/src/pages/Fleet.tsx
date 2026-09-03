/**
 * Fleet — the filterable device grid.
 *
 * Two decisions worth naming:
 *
 * 1. **Filter state lives in the URL**, not in component state. `/fleet?site_id=2` from
 *    the Overview has to land on the filtered view, and an operator pasting the view into
 *    a chat has to hand over what they were looking at, not a blank grid.
 * 2. **The "live signals" column is chosen per row.** It shows the reading that is
 *    actually outside its declared nominal band rather than whichever metric the device
 *    type happened to list first — see `DeviceMetricPicks`.
 */

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MetricPills, pickInterestingMetrics, resolveSchema } from '../components/DeviceMetricPicks'
import {
  Button,
  Card,
  Cell,
  EmptyState,
  ErrorState,
  Field,
  HealthMeter,
  Input,
  LinkCell,
  Row,
  SectionHeader,
  Select,
  Skeleton,
  StatusDot,
  Table,
} from '../components/ui'
import api from '../lib/api'
import { STATUS_TOKEN, timeAgo } from '../lib/format'
import type { DeviceStatus, DeviceType } from '../lib/types'
import { useAsync, useDebounced } from '../lib/useAsync'

const PER_PAGE = 25
const POLL_MS = 20_000

const SORTS = ['health', 'name', 'last_seen'] as const
type SortKey = (typeof SORTS)[number]

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'health', label: 'Worst health first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'last_seen', label: 'Most recently seen' },
]

const STATUS_ORDER: DeviceStatus[] = ['online', 'degraded', 'offline', 'maintenance', 'provisioning']

export default function Fleet() {
  const [params, setParams] = useSearchParams()

  const siteId = params.get('site_id') ?? ''
  const typeId = params.get('device_type_id') ?? ''
  const status = params.get('status') ?? ''
  const rawSort = params.get('sort') ?? ''
  const sort: SortKey = (SORTS as readonly string[]).includes(rawSort) ? (rawSort as SortKey) : 'health'
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)
  const urlQ = params.get('q') ?? ''

  // The text box is local so typing stays instant; the debounced value is what reaches
  // both the API and the URL.
  const [queryText, setQueryText] = useState(urlQ)
  const debouncedQuery = useDebounced(queryText.trim(), 350)

  /** Write a filter change back to the URL. Any filter change resets to page 1. */
  const update = (patch: Record<string, string | null>, replace = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        if (!('page' in patch)) next.delete('page')
        return next
      },
      { replace }
    )
  }

  useEffect(() => {
    if (debouncedQuery === urlQ) return
    update({ q: debouncedQuery || null }, true)
    // `update` is recreated each render; the guard above makes this idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, urlQ])

  const sites = useAsync(() => api.sites.list(), [])
  const deviceTypes = useAsync(() => api.deviceTypes.list(), [])

  const list = useAsync(
    (signal) =>
      api.devices.list(
        {
          site_id: siteId ? Number(siteId) : undefined,
          device_type_id: typeId ? Number(typeId) : undefined,
          status: status || undefined,
          q: debouncedQuery || undefined,
          sort,
          page,
          per_page: PER_PAGE,
        },
        signal
      ),
    [siteId, typeId, status, debouncedQuery, sort, page],
    { pollMs: POLL_MS }
  )

  const typeMap = useMemo(() => {
    const map = new Map<number, DeviceType>()
    for (const t of deviceTypes.data ?? []) map.set(t.id, t)
    return map
  }, [deviceTypes.data])

  const devices = list.data?.items ?? []
  const total = list.data?.itemsTotal ?? devices.length
  const pageTotal = Math.max(1, list.data?.pageTotal ?? 1)
  const firstIndex = devices.length ? (page - 1) * PER_PAGE + 1 : 0
  const lastIndex = (page - 1) * PER_PAGE + devices.length

  const filtersActive = Boolean(siteId || typeId || status || debouncedQuery)

  const clearFilters = () => {
    setQueryText('')
    setParams(new URLSearchParams(), { replace: false })
  }

  const siteOptions = [
    { value: '', label: 'All sites' },
    ...(sites.data ?? []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.code})` })),
  ]
  const typeOptions = [
    { value: '', label: 'All device types' },
    ...(deviceTypes.data ?? []).map((t) => ({ value: String(t.id), label: t.name })),
  ]
  const statusOptions = [
    { value: '', label: 'Any status' },
    ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_TOKEN[s].label })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Fleet"
        subtitle={
          list.initial
            ? 'Loading devices…'
            : `${total.toLocaleString()} device${total === 1 ? '' : 's'} match${
                total === 1 ? 'es' : ''
              } these filters. Status and readings refresh every 20 seconds.`
        }
        action={
          filtersActive ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : undefined
        }
      />

      {/* One filter row above the results. */}
      <Card>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Field label="Site">
            <Select
              value={siteId}
              onChange={(v) => update({ site_id: v || null })}
              options={siteOptions}
              disabled={sites.loading && sites.initial}
            />
          </Field>
          <Field label="Device type">
            <Select
              value={typeId}
              onChange={(v) => update({ device_type_id: v || null })}
              options={typeOptions}
              disabled={deviceTypes.loading && deviceTypes.initial}
            />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(v) => update({ status: v || null })} options={statusOptions} />
          </Field>
          <Field label="Sort">
            <Select
              value={sort}
              onChange={(v) => update({ sort: v === 'health' ? null : v })}
              options={SORT_OPTIONS}
            />
          </Field>
          <Field label="Search" hint="Matches name, serial and location.">
            <Input value={queryText} onChange={setQueryText} placeholder="Name, serial or location…" />
          </Field>
        </div>
        {(sites.error || deviceTypes.error) && (
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Site and device-type filters could not load, so their lists are empty. Search and status still work.
          </p>
        )}
      </Card>

      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.initial ? (
        <Card padded={false}>
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} height={34} />
            ))}
          </div>
        </Card>
      ) : devices.length === 0 ? (
        <Card>
          <EmptyState
            title="No devices match these filters"
            hint={
              filtersActive
                ? 'Widen the site or status filter, or clear the search box. A device that has never reported still appears under the Provisioning status.'
                : 'Nothing is registered yet. A device provisions itself on its first call to POST /ingest/register with a site API key — no console screens required.'
            }
            action={
              filtersActive ? (
                <Button size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <Table
            head={[
              'Device',
              'Serial',
              'Type',
              'Site',
              'Status',
              'Health',
              'Live signals',
              'Last seen',
            ]}
          >
            {devices.map((d) => {
              const schema = resolveSchema(d, typeMap)
              const picks = pickInterestingMetrics(d, schema, 2)
              return (
                <Row key={d.id}>
                  <LinkCell to={`/devices/${d.id}`}>{d.name}</LinkCell>
                  <Cell nowrap muted>
                    <span className="text-[12px]" style={{ fontFamily: 'var(--mono)' }}>
                      {d.serial}
                    </span>
                  </Cell>
                  <Cell nowrap muted>
                    {typeMap.get(d.device_type_id)?.name ?? d.device_type_name ?? '—'}
                  </Cell>
                  <Cell nowrap muted>
                    <span>{d.site_name ?? '—'}</span>
                    {d.location_label && (
                      <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {d.location_label}
                      </span>
                    )}
                  </Cell>
                  <Cell nowrap>
                    <StatusDot status={d.status} />
                  </Cell>
                  <Cell nowrap>
                    <HealthMeter score={d.health_score} />
                  </Cell>
                  <Cell>
                    <MetricPills picks={picks} />
                  </Cell>
                  <Cell nowrap muted>
                    {timeAgo(d.last_seen_at)}
                  </Cell>
                </Row>
              )
            })}
          </Table>

          <div
            className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3"
            style={{ borderColor: 'var(--surface-3)' }}
          >
            <p className="num-tabular text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              Showing {firstIndex.toLocaleString()}–{lastIndex.toLocaleString()} of {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={page <= 1}
                onClick={() => update({ page: String(page - 1) })}
                title={page <= 1 ? 'Already on the first page' : undefined}
              >
                Previous
              </Button>
              <span className="num-tabular text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Page {page} of {pageTotal}
              </span>
              <Button
                size="sm"
                disabled={page >= pageTotal}
                onClick={() => update({ page: String(page + 1) })}
                title={page >= pageTotal ? 'Already on the last page' : undefined}
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
