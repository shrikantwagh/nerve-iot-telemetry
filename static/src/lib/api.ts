/**
 * The single Xano client.
 *
 * Every network call in the app goes through `request()`, which is the only place that
 * knows about base URLs, the bearer token, error shapes, and timeouts. Xano exposes each
 * API group under its own canonical segment, so there are three bases rather than one.
 *
 * Security note: the bundle is world-readable, so the ONLY credential here is the user's
 * own auth token. The device ingest API key never appears in frontend code — devices
 * hold it, browsers do not.
 */

import type {
  AiInsight,
  Alert,
  AlertRule,
  AnomalyExplanation,
  ApiKey,
  AuditEntry,
  Device,
  DeviceCategory,
  DeviceCommand,
  DeviceStatus,
  DeviceType,
  FleetOverview,
  HealthDistribution,
  Incident,
  MaintenancePrediction,
  MetricSeries,
  NlQueryLogEntry,
  NlQueryResult,
  Paged,
  RuleProposal,
  Severity,
  Site,
  TimelineEntry,
  User,
} from './types'

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const RAW_BASE = (import.meta.env.VITE_XANO_API_BASE as string | undefined)?.replace(/\/+$/, '')

/**
 * Instance origin, e.g. `https://x8ki-letl-twmt.n7.xano.io`.
 *
 * Falls back to a build-time constant so a freshly cloned repo runs without a `.env`,
 * but a real deploy should set `VITE_XANO_API_BASE`.
 */
export const INSTANCE_BASE = RAW_BASE || 'https://x8ki-letl-twmt.n7.xano.io'

/** Group canonicals, set on each `api_group` in the backend. */
const GROUP = {
  auth: 'nerve-auth',
  nerve: 'nerve',
} as const

export const apiUrl = (group: keyof typeof GROUP, path: string) =>
  `${INSTANCE_BASE}/api:${GROUP[group]}${path.startsWith('/') ? path : `/${path}`}`

const TOKEN_KEY = 'nerve.authToken'
const USER_KEY = 'nerve.user'

/* -------------------------------------------------------------------------- */
/* Token storage                                                              */
/* -------------------------------------------------------------------------- */

/**
 * localStorage throws outright in some contexts (private windows with site data
 * blocked, embedded previews), so every access is guarded. A storage failure must
 * degrade to "not logged in", never to a blank screen.
 */
function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    /* ignore — the session just won't persist across reloads */
  }
}

export const tokenStore = {
  get: () => safeGet(TOKEN_KEY),
  set: (t: string | null) => safeSet(TOKEN_KEY, t),
  getUser: (): User | null => {
    const raw = safeGet(USER_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as User
    } catch {
      return null
    }
  },
  setUser: (u: User | null) => safeSet(USER_KEY, u ? JSON.stringify(u) : null),
  clear: () => {
    safeSet(TOKEN_KEY, null)
    safeSet(USER_KEY, null)
  },
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class ApiError extends Error {
  status: number
  code?: string
  payload?: unknown

  constructor(message: string, status: number, code?: string, payload?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }

  /** Xano's free-plan throttle. Worth naming explicitly because the fix is a plan change. */
  get isRateLimit() {
    return this.status === 429 || this.code === 'ERROR_CODE_TOO_MANY_REQUESTS'
  }

  get isAuth() {
    return this.status === 401 || this.status === 403
  }
}

/** Called when a request comes back 401, so the app can bounce to login once. */
let onUnauthorized: (() => void) | null = null
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn
}

/* -------------------------------------------------------------------------- */
/* Core request                                                               */
/* -------------------------------------------------------------------------- */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  group?: keyof typeof GROUP
  timeoutMs?: number
  signal?: AbortSignal
  /** Skip the bearer token (login/signup/demo). */
  anonymous?: boolean
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    query,
    group = 'nerve',
    // AI endpoints make two sequential model calls, so they need a long ceiling.
    timeoutMs = 60_000,
    signal,
    anonymous = false,
  } = opts

  const url = new URL(apiUrl(group, path))
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (!anonymous) {
    const token = tokenStore.get()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  // Compose the caller's signal with our own timeout so either can cancel.
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new ApiError(
        signal?.aborted ? 'Request cancelled.' : `Request timed out after ${timeoutMs / 1000}s.`,
        0
      )
    }
    throw new ApiError(
      'Could not reach the Nerve backend. Check the instance URL and that the API group is published.',
      0
    )
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!res.ok) {
    const p = parsed as { message?: string; code?: string; error?: string } | string | null
    const message =
      (typeof p === 'object' && p && (p.message || p.error)) ||
      (typeof p === 'string' && p) ||
      `Request failed (${res.status})`
    const code = typeof p === 'object' && p ? p.code : undefined
    const error = new ApiError(String(message), res.status, code, parsed)
    if (error.isAuth && !anonymous) onUnauthorized?.()
    throw error
  }

  return parsed as T
}

/**
 * Xano returns a bare array for an unpaged list and an envelope when paging is on.
 * Normalizing here keeps every caller from having to branch.
 */
/**
 * Unwrap a list response into a `Paged<T>`, whatever envelope it arrived in.
 *
 * Every list endpoint returns an envelope rather than a bare array, and each one names
 * its fields differently — verified against the live instance:
 *
 *   /sites                   { sites,        total_sites }
 *   /device-types            { device_types, total_types }
 *   /devices                 { items,        items_total, page, page_total }
 *   /alerts                  { items,        itemsTotal,  curPage, pageTotal }
 *   /alert-rules             { items,        itemsTotal }
 *   /incidents               { items,        items_total, page, page_total }
 *   /predictions             { items,        count }
 *   /ai/insights             { items,        total, page, page_total }
 *   /devices/{id}/commands   { items,        total, page, pages }
 *   /devices/{id}/timeline   { events,       total_merged }
 *
 * Rather than hardcode ten shapes, this looks for the array under a named key, then any
 * known key, then any array-valued property — and reads the total and page numbers from
 * whichever spelling is present. Spreading an object that was assumed to be an array is
 * what blanked five of the app's seven screens, so this is deliberately tolerant: a new
 * endpoint with yet another field name degrades to "found the array anyway" instead of
 * throwing during render.
 */
const LIST_KEYS = ['items', 'events', 'sites', 'device_types', 'rules', 'devices', 'alerts', 'incidents', 'predictions', 'results', 'data'] as const

function pickNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function unwrapList<T>(value: unknown, preferredKey?: string): Paged<T> {
  if (Array.isArray(value)) {
    return { items: value as T[], itemsTotal: value.length, curPage: 1, pageTotal: 1 }
  }
  if (!value || typeof value !== 'object') {
    return { items: [], itemsTotal: 0, curPage: 1, pageTotal: 1 }
  }

  const o = value as Record<string, unknown>
  const keys = preferredKey ? [preferredKey, ...LIST_KEYS] : [...LIST_KEYS]
  let items: T[] | null = null
  for (const k of keys) {
    if (Array.isArray(o[k])) {
      items = o[k] as T[]
      break
    }
  }
  // Last resort: the first array-valued property, whatever it is called.
  if (!items) {
    const found = Object.values(o).find((v) => Array.isArray(v))
    items = (found as T[]) ?? []
  }

  return {
    items,
    itemsTotal:
      pickNumber(o, ['itemsTotal', 'items_total', 'total', 'count', 'total_merged', 'total_sites', 'total_types']) ??
      items.length,
    itemsReceived: pickNumber(o, ['itemsReceived', 'returned_count']) ?? items.length,
    curPage: pickNumber(o, ['curPage', 'page']) ?? 1,
    pageTotal: pickNumber(o, ['pageTotal', 'page_total', 'pages']) ?? 1,
    nextPage: pickNumber(o, ['nextPage', 'next_page']) ?? null,
    prevPage: pickNumber(o, ['prevPage', 'prev_page']) ?? null,
  }
}

/** For endpoints whose callers want a plain array. */
const unwrapArray = <T,>(value: unknown, preferredKey?: string): T[] => unwrapList<T>(value, preferredKey).items

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

interface AuthResponse {
  authToken: string
  user: User
}

export const auth = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/login', {
      method: 'POST',
      group: 'auth',
      anonymous: true,
      body: { email, password },
      timeoutMs: 20_000,
    }),

  signup: (name: string, email: string, password: string) =>
    request<AuthResponse>('/signup', {
      method: 'POST',
      group: 'auth',
      anonymous: true,
      body: { name, email, password },
      timeoutMs: 20_000,
    }),

  /** One-click login for judges — no credentials to type. */
  demo: () =>
    request<AuthResponse>('/demo', {
      method: 'POST',
      group: 'auth',
      anonymous: true,
      timeoutMs: 20_000,
    }),

  me: () => request<User>('/me', { group: 'auth' }),
}

/* -------------------------------------------------------------------------- */
/* Fleet                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The shape `GET /fleet/overview` actually returns, as observed live.
 *
 * The backend groups its counters under `totals` / `devices_by_status` / etc., while the
 * app's `FleetOverview` type is flat. Rather than churn the screen or loosen the type,
 * the adaptation lives here — the client is the one place designed to know the wire
 * format, and normalising once means a backend rename touches one function instead of
 * every component that reads a tile.
 */
/** A site as it arrives from the backend, which names the average differently. */
type SiteWire = Omit<Site, 'avg_health'> & { avg_health_score?: number; avg_health?: number }

const normalizeSite = (s: SiteWire): Site => ({
  ...s,
  avg_health: s.avg_health ?? s.avg_health_score ?? 0,
})

interface FleetOverviewWire {
  generated_at?: number | string
  totals?: {
    devices?: number
    avg_health_score?: number
    below_health_60?: number
    readings_last_hour?: number
    open_incidents?: number
    firing_alerts?: number
  }
  devices_by_status?: Partial<Record<DeviceStatus, number>>
  incidents_open_by_severity?: Partial<Record<Severity, number>>
  alerts_firing_by_severity?: Partial<Record<Severity, number>>
  sites?: SiteWire[]
  worst_devices?: Device[]
  ai_digest?: AiInsight | null
}

const ZERO_STATUS: Record<DeviceStatus, number> = {
  online: 0,
  degraded: 0,
  offline: 0,
  maintenance: 0,
  provisioning: 0,
}
const ZERO_SEVERITY: Record<Severity, number> = { critical: 0, warning: 0, info: 0 }

function normalizeOverview(wire: FleetOverviewWire | FleetOverview | null): FleetOverview {
  // Tolerate the flat shape too, so this keeps working if the backend is ever changed
  // to emit it directly.
  const flat = wire as FleetOverview | null
  if (flat && typeof flat.device_total === 'number') {
    return {
      ...flat,
      status_counts: { ...ZERO_STATUS, ...(flat.status_counts ?? {}) },
      incident_counts: { ...ZERO_SEVERITY, ...(flat.incident_counts ?? {}) },
      alert_counts: { ...ZERO_SEVERITY, ...(flat.alert_counts ?? {}) },
      sites: (flat.sites ?? []).map(normalizeSite),
      worst_devices: flat.worst_devices ?? [],
    }
  }

  const w = (wire ?? {}) as FleetOverviewWire
  const t = w.totals ?? {}
  return {
    device_total: t.devices ?? 0,
    status_counts: { ...ZERO_STATUS, ...(w.devices_by_status ?? {}) },
    incident_counts: { ...ZERO_SEVERITY, ...(w.incidents_open_by_severity ?? {}) },
    alert_counts: { ...ZERO_SEVERITY, ...(w.alerts_firing_by_severity ?? {}) },
    avg_health: t.avg_health_score ?? 0,
    unhealthy_count: t.below_health_60 ?? 0,
    readings_last_hour: t.readings_last_hour ?? 0,
    sites: (w.sites ?? []).map(normalizeSite),
    worst_devices: w.worst_devices ?? [],
    digest: w.ai_digest ?? null,
    // Authoritative totals from the backend rather than a sum of the severity buckets,
    // which is what the sidebar badges fall back to.
    open_incident_total: t.open_incidents ?? 0,
    firing_alert_total: t.firing_alerts ?? 0,
  }
}

/** The shape `GET /fleet/health-distribution` actually returns, as observed live. */
interface HealthDistributionWire {
  total_devices?: number
  bucket_size?: number
  buckets?: { index?: number; label?: string; min?: number; max?: number; count?: number }[]
  by_category?: {
    category?: string
    device_count?: number
    avg_health_score?: number
    below_health_60?: number
  }[]
}

function normalizeHealthDistribution(wire: HealthDistributionWire | null): HealthDistribution {
  const w = wire ?? {}
  return {
    buckets: (w.buckets ?? []).map((b, i) => ({
      // The chart keys and labels rows off `bucket`; the backend calls it `label`.
      bucket: b.label ?? `${b.min ?? i * 10}-${b.max ?? i * 10 + 9}`,
      from: b.min ?? 0,
      to: b.max ?? 0,
      count: b.count ?? 0,
    })),
    by_category: (w.by_category ?? []).map((c) => ({
      category: (c.category ?? 'other') as DeviceCategory,
      avg_health: c.avg_health_score ?? 0,
      count: c.device_count ?? 0,
    })),
  }
}

/**
 * Flatten the `GET /devices/{id}` envelope into the flat `Device` the screens expect.
 *
 * The endpoint returns `{ device, site, device_type, metrics_latest, uplink,
 * firing_alerts, open_predictions, recent_commands }` — verified live. The client typed
 * it as a flat Device, so `device.name` was undefined, and EditDeviceModal's
 * `useState(device.name)` then `name.trim()` threw during render. Same class of bug as
 * the list envelopes.
 *
 * Also derives `site_name` / `device_type_name`, so a component can render a row without
 * reaching into two nested objects.
 */
function normalizeDeviceDetail(wire: unknown): Device {
  if (!wire || typeof wire !== 'object') return {} as Device
  const w = wire as Record<string, unknown>

  // Tolerate a flat response too, in case the endpoint is ever simplified.
  const inner = (w.device && typeof w.device === 'object' ? w.device : w) as Partial<Device>
  const site = (w.site ?? undefined) as Site | undefined
  const deviceType = (w.device_type ?? undefined) as DeviceType | undefined

  return {
    ...(inner as Device),
    site,
    device_type: deviceType,
    site_name: site?.name ?? (inner as Device).site_name,
    site_code: site?.code ?? (inner as Device).site_code,
    device_type_name: deviceType?.name ?? (inner as Device).device_type_name,
    device_type_category: deviceType?.category ?? (inner as Device).device_type_category,
    // metrics_latest is promoted to the top level by the endpoint; prefer that, but fall
    // back to the column on the row itself.
    metrics_latest: (w.metrics_latest ?? inner.metrics_latest ?? null) as Device['metrics_latest'],
    firing_alerts: unwrapArray<Alert>(w.firing_alerts ?? [], 'alerts'),
    open_predictions: unwrapArray<MaintenancePrediction>(w.open_predictions ?? [], 'predictions'),
    recent_commands: unwrapArray<DeviceCommand>(w.recent_commands ?? [], 'commands'),
    // A name is load-bearing: several components call .trim() on it.
    name: (inner as Device).name ?? (inner as Device).serial ?? 'Unknown device',
  }
}

/**
 * Pull one `MetricSeries` out of the multi-series telemetry envelope.
 *
 * `GET /devices/{id}/telemetry` returns
 * `{ device_id, from, to, source, bucket_seconds, point_cap, truncated,
 *    series: [{ metric_key, label, unit, points }] }` — the endpoint accepts a
 * comma-separated metric list, so the payload is always a list even for one metric.
 * The client typed it as a flat MetricSeries, so `metric.points` was undefined and
 * MetricChart threw `Cannot read properties of undefined (reading 'map')`.
 *
 * Hoists the envelope-level `source` / `truncated` / `point_cap` onto the series,
 * because those describe the data and the chart footnote reports them.
 */
function normalizeMetricSeries(wire: unknown, requestedKey: string): MetricSeries {
  const empty: MetricSeries = { metric_key: requestedKey, points: [], source: 'raw' }
  if (!wire || typeof wire !== 'object') return empty

  const w = wire as Record<string, unknown>
  // Tolerate an already-flat response.
  if (Array.isArray(w.points)) return { ...(w as unknown as MetricSeries) }

  const series = Array.isArray(w.series) ? (w.series as Record<string, unknown>[]) : []
  const first = requestedKey.split(',')[0]?.trim()
  const match = series.find((s) => s.metric_key === first) ?? series[0]
  if (!match) return { ...empty, source: (w.source as MetricSeries['source']) ?? 'raw' }

  return {
    metric_key: (match.metric_key as string) ?? requestedKey,
    label: match.label as string | undefined,
    // The endpoint has been seen returning a NUMBER for unit on some metrics, so coerce
    // rather than letting a stray number reach a template string.
    unit: match.unit === null || match.unit === undefined ? undefined : String(match.unit),
    nominal_min: (match.nominal_min ?? null) as number | null,
    nominal_max: (match.nominal_max ?? null) as number | null,
    points: Array.isArray(match.points) ? (match.points as MetricSeries['points']) : [],
    source: ((w.source as string) === 'rollup' ? 'rollup' : 'raw') as MetricSeries['source'],
    truncated: Boolean(w.truncated),
    point_cap: typeof w.point_cap === 'number' ? w.point_cap : undefined,
  }
}

export const fleet = {
  overview: (signal?: AbortSignal) =>
    request<FleetOverviewWire>('/fleet/overview', { signal }).then(normalizeOverview),
  healthDistribution: () =>
    request<HealthDistributionWire>('/fleet/health-distribution').then(normalizeHealthDistribution),
}

/**
 * A type alias rather than an `interface` on purpose: TypeScript grants object *type
 * aliases* an implicit index signature, so this stays assignable to `RequestOptions.query`
 * without either widening the field list or casting at the call site.
 */
export type DeviceListParams = {
  site_id?: number
  device_type_id?: number
  status?: string
  q?: string
  sort?: 'health' | 'name' | 'last_seen'
  page?: number
  per_page?: number
}

export const devices = {
  list: (params: DeviceListParams = {}, signal?: AbortSignal) =>
    request<unknown>('/devices', { query: params, signal }).then((r) => unwrapList<Device>(r, 'devices')),

  get: (id: number, signal?: AbortSignal) =>
    request<unknown>(`/devices/${id}`, { signal }).then(normalizeDeviceDetail),

  create: (payload: Partial<Device> & { serial: string; name: string; device_type_id: number; site_id: number }) =>
    request<Device>('/devices', { method: 'POST', body: payload }),

  update: (id: number, payload: Partial<Device>) =>
    request<Device>(`/devices/${id}`, { method: 'PATCH', body: payload }),

  remove: (id: number) => request<{ ok: boolean }>(`/devices/${id}`, { method: 'DELETE' }),

  telemetry: (
    id: number,
    params: { metric_key: string; from?: string; to?: string; resolution?: string },
    signal?: AbortSignal
  ) =>
    request<unknown>(`/devices/${id}/telemetry`, { query: params, signal }).then((r) =>
      normalizeMetricSeries(r, params.metric_key)
    ),

  timeline: (id: number) =>
    request<unknown>(`/devices/${id}/timeline`).then((r) => unwrapArray<TimelineEntry>(r, 'events')),

  commands: (id: number) =>
    request<unknown>(`/devices/${id}/commands`).then((r) => unwrapArray<DeviceCommand>(r)),

  issueCommand: (id: number, command: string, payload?: Record<string, unknown>, note?: string) =>
    request<DeviceCommand>(`/devices/${id}/commands`, { method: 'POST', body: { command, payload, note } }),
}

export const sites = {
  list: () => request<unknown>('/sites').then((r) => unwrapArray<SiteWire>(r, 'sites').map(normalizeSite)),
  create: (payload: Partial<Site> & { code: string; name: string }) =>
    request<Site>('/sites', { method: 'POST', body: payload }),
}

export const deviceTypes = {
  list: () => request<unknown>('/device-types').then((r) => unwrapArray<DeviceType>(r, 'device_types')),
  create: (payload: Partial<DeviceType> & { code: string; name: string }) =>
    request<DeviceType>('/device-types', { method: 'POST', body: payload }),
}

/* -------------------------------------------------------------------------- */
/* Alerts & rules                                                             */
/* -------------------------------------------------------------------------- */

/** Type alias, not an interface — see the note on `DeviceListParams`. */
export type AlertListParams = {
  state?: string
  severity?: string
  device_id?: number
  site_id?: number
  incident_id?: number
  since?: string
  page?: number
  per_page?: number
}

export const alerts = {
  list: (params: AlertListParams = {}, signal?: AbortSignal) =>
    request<unknown>('/alerts', { query: params, signal }).then((r) => unwrapList<Alert>(r, 'alerts')),
  ack: (id: number) => request<Alert>(`/alerts/${id}/ack`, { method: 'POST' }),
  resolve: (id: number) => request<Alert>(`/alerts/${id}/resolve`, { method: 'POST' }),
  bulkAck: (ids: number[]) =>
    request<{ updated: number }>('/alerts/bulk-ack', { method: 'POST', body: { alert_ids: ids } }),
}

export const rules = {
  list: () => request<unknown>('/alert-rules').then((r) => unwrapArray<AlertRule>(r, 'rules')),
  create: (payload: Partial<AlertRule>) =>
    request<AlertRule>('/alert-rules', { method: 'POST', body: payload }),
  update: (id: number, payload: Partial<AlertRule>) =>
    request<AlertRule>(`/alert-rules/${id}`, { method: 'PATCH', body: payload }),
  remove: (id: number) => request<{ ok: boolean }>(`/alert-rules/${id}`, { method: 'DELETE' }),
  /** Dry-run against real history. Fires nothing. */
  test: (id: number, hours = 24) =>
    request<{
      would_fire_count: number
      device_count: number
      verdict: string
      matches: { device_id: number; device_name?: string; extreme_value: number; fire_count: number }[]
    }>(`/alert-rules/${id}/test`, { method: 'POST', body: { hours }, timeoutMs: 90_000 }),
}

/* -------------------------------------------------------------------------- */
/* Incidents                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Flatten the `GET /incidents/{id}` envelope into the flat `Incident` the screens expect.
 *
 * The endpoint returns `{ incident, site, assignee, alerts, devices, commands, ai: {
 * summary, root_cause, confidence, remediation, evidence, model, fallback_used },
 * timeline }` - verified live. The app's Incident type carries those as flat `ai_*`
 * fields, so without this the entire AI panel renders empty even though the hypothesis,
 * its confidence and its evidence are all sitting in the response.
 */
function normalizeIncidentDetail(wire: unknown): Incident {
  if (!wire || typeof wire !== 'object') return {} as Incident
  const w = wire as Record<string, unknown>

  // Tolerate an already-flat response.
  const inner = (w.incident && typeof w.incident === 'object' ? w.incident : w) as Partial<Incident>
  const ai = (w.ai ?? {}) as Record<string, unknown>
  const site = (w.site ?? undefined) as Site | undefined
  const assignee = (w.assignee ?? undefined) as User | undefined

  return {
    ...(inner as Incident),
    site_name: site?.name ?? (inner as Incident).site_name,
    assignee_name: assignee?.name ?? (inner as Incident).assignee_name,
    alerts: unwrapArray<Alert>(w.alerts ?? [], 'alerts'),
    // The endpoint names the joined type `type_name` and carries the site once on the
    // incident rather than on every device — an incident's devices are correlated BY
    // site, so repeating it per row would be redundant on the wire. The device table
    // renders per row, so fold both onto each device here.
    devices: unwrapArray<Device>(w.devices ?? [], 'devices').map((d) => {
      const row = d as Device & { type_name?: string; type_category?: string }
      return {
        ...row,
        device_type_name: row.device_type_name ?? row.type_name,
        site_name: row.site_name ?? site?.name,
      }
    }),
    commands: unwrapArray<DeviceCommand>(w.commands ?? [], 'commands'),
    ai_summary: (ai.summary ?? (inner as Incident).ai_summary ?? null) as string | null,
    ai_root_cause: (ai.root_cause ?? (inner as Incident).ai_root_cause ?? null) as string | null,
    ai_confidence: (ai.confidence ?? (inner as Incident).ai_confidence ?? null) as number | null,
    ai_remediation: unwrapArray<string>(ai.remediation ?? []),
    ai_evidence: unwrapArray<string>(ai.evidence ?? []),
    ai_model: (ai.model ?? null) as string | null,
    ai_generated_at: (ai.generated_at ?? null) as string | null,
    ai_postmortem: (ai.postmortem ?? (inner as Incident).ai_postmortem ?? null) as string | null,
    ai_fallback_used: Boolean(ai.fallback_used ?? (inner as Incident).ai_fallback_used),
    has_ai_analysis: Boolean(ai.root_cause || ai.summary),
  }
}

export const incidents = {
  list: (params: { state?: string; severity?: string; site_id?: number; page?: number } = {}, signal?: AbortSignal) =>
    request<unknown>('/incidents', { query: params, signal }).then((r) => unwrapList<Incident>(r, 'incidents')),

  get: (id: number, signal?: AbortSignal) =>
    request<unknown>(`/incidents/${id}`, { signal }).then(normalizeIncidentDetail),

  update: (id: number, payload: Partial<Pick<Incident, 'state' | 'assigned_to' | 'title' | 'severity'>>) =>
    request<Incident>(`/incidents/${id}`, { method: 'PATCH', body: payload }),

  /** Regenerate the AI root-cause analysis. Long timeout: two model calls. */
  analyze: (id: number) =>
    request<unknown>(`/incidents/${id}/analyze`, { method: 'POST', timeoutMs: 120_000 }).then(
      (r) => normalizeIncidentDetail(r) as Incident & { fallback_used?: boolean; latency_ms?: number }
    ),

  postmortem: (id: number) =>
    request<{ ai_postmortem: string; fallback_used?: boolean; model?: string }>(`/incidents/${id}/postmortem`, {
      method: 'POST',
      timeoutMs: 120_000,
    }),

  issueCommands: (id: number, command: string, deviceIds?: number[], payload?: Record<string, unknown>) =>
    request<{ created: number; commands: DeviceCommand[] }>(`/incidents/${id}/commands`, {
      method: 'POST',
      body: { command, device_ids: deviceIds, payload },
    }),
}

/* -------------------------------------------------------------------------- */
/* AI                                                                         */
/* -------------------------------------------------------------------------- */

export const ai = {
  /** Ask the fleet a question in English. */
  query: (question: string, signal?: AbortSignal) =>
    request<NlQueryResult>('/ai/query', { method: 'POST', body: { question }, timeoutMs: 120_000, signal }),

  ruleFromText: (text: string, save = false) =>
    request<RuleProposal>('/ai/rule-from-text', { method: 'POST', body: { text, save }, timeoutMs: 90_000 }),

  triage: () =>
    request<{ incidents_created: number; incidents_touched: number; alerts_grouped: number }>('/ai/triage', {
      method: 'POST',
      timeoutMs: 150_000,
    }),

  digest: (refresh = false) =>
    request<AiInsight | null>('/ai/digest', { query: { refresh }, timeoutMs: refresh ? 120_000 : 30_000 }),

  explainAnomaly: (device_id: number, metric_key: string, window_hours = 6) =>
    request<AnomalyExplanation>('/ai/explain-anomaly', {
      method: 'POST',
      body: { device_id, metric_key, window_hours },
      timeoutMs: 120_000,
    }),

  insights: (params: { kind?: string; device_id?: number; incident_id?: number; page?: number } = {}) =>
    request<unknown>('/ai/insights', { query: params }).then((r) => unwrapList<AiInsight>(r)),

  queryHistory: () => request<unknown>('/ai/query-history').then((r) => unwrapArray<NlQueryLogEntry>(r)),
}

/* -------------------------------------------------------------------------- */
/* Predictions                                                                */
/* -------------------------------------------------------------------------- */

export const predictions = {
  list: (params: { state?: string; device_id?: number; site_id?: number } = {}) =>
    request<unknown>('/predictions', { query: params }).then((r) => unwrapArray<MaintenancePrediction>(r, 'predictions')),
  schedule: (id: number, scheduled_for: string) =>
    request<MaintenancePrediction>(`/predictions/${id}/schedule`, { method: 'POST', body: { scheduled_for } }),
  dismiss: (id: number, reason: string) =>
    request<MaintenancePrediction>(`/predictions/${id}/dismiss`, { method: 'POST', body: { reason } }),
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

export const admin = {
  apiKeys: () => request<unknown>('/api-keys').then((r) => unwrapArray<ApiKey>(r)),

  /** The plaintext key is returned exactly once, here. It is never retrievable again. */
  createApiKey: (name: string, site_id?: number) =>
    request<{ api_key: ApiKey; plaintext_key: string; warning: string }>('/api-keys', {
      method: 'POST',
      body: { name, site_id },
    }),

  revokeApiKey: (id: number) => request<{ ok: boolean }>(`/api-keys/${id}`, { method: 'DELETE' }),

  auditLog: (params: { action?: string; user_id?: number; page?: number } = {}) =>
    request<unknown>('/audit-log', { query: params }).then((r) => unwrapList<AuditEntry>(r)),

  seed: () =>
    request<{ sites: number; device_types: number; alert_rules: number; message?: string }>('/admin/seed', {
      method: 'POST',
      timeoutMs: 120_000,
    }),
}

export const api = {
  auth,
  fleet,
  devices,
  sites,
  deviceTypes,
  alerts,
  rules,
  incidents,
  ai,
  predictions,
  admin,
}

export default api
