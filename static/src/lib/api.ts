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
function asPaged<T>(value: Paged<T> | T[] | null | undefined): Paged<T> {
  if (Array.isArray(value)) return { items: value, itemsTotal: value.length, curPage: 1, pageTotal: 1 }
  if (!value) return { items: [], itemsTotal: 0, curPage: 1, pageTotal: 1 }
  return { ...value, items: value.items ?? [] }
}

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
  sites?: Site[]
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
      sites: flat.sites ?? [],
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
    sites: w.sites ?? [],
    worst_devices: w.worst_devices ?? [],
    digest: w.ai_digest ?? null,
    // Authoritative totals from the backend rather than a sum of the severity buckets,
    // which is what the sidebar badges fall back to.
    open_incident_total: t.open_incidents ?? 0,
    firing_alert_total: t.firing_alerts ?? 0,
  }
}

export const fleet = {
  overview: (signal?: AbortSignal) =>
    request<FleetOverviewWire>('/fleet/overview', { signal }).then(normalizeOverview),
  healthDistribution: () => request<HealthDistribution>('/fleet/health-distribution'),
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
    request<Paged<Device> | Device[]>('/devices', { query: params, signal }).then(asPaged),

  get: (id: number, signal?: AbortSignal) => request<Device>(`/devices/${id}`, { signal }),

  create: (payload: Partial<Device> & { serial: string; name: string; device_type_id: number; site_id: number }) =>
    request<Device>('/devices', { method: 'POST', body: payload }),

  update: (id: number, payload: Partial<Device>) =>
    request<Device>(`/devices/${id}`, { method: 'PATCH', body: payload }),

  remove: (id: number) => request<{ ok: boolean }>(`/devices/${id}`, { method: 'DELETE' }),

  telemetry: (
    id: number,
    params: { metric_key: string; from?: string; to?: string; resolution?: string },
    signal?: AbortSignal
  ) => request<MetricSeries>(`/devices/${id}/telemetry`, { query: params, signal }),

  timeline: (id: number) => request<TimelineEntry[]>(`/devices/${id}/timeline`),

  commands: (id: number) => request<DeviceCommand[]>(`/devices/${id}/commands`),

  issueCommand: (id: number, command: string, payload?: Record<string, unknown>, note?: string) =>
    request<DeviceCommand>(`/devices/${id}/commands`, { method: 'POST', body: { command, payload, note } }),
}

export const sites = {
  list: () => request<Site[]>('/sites'),
  create: (payload: Partial<Site> & { code: string; name: string }) =>
    request<Site>('/sites', { method: 'POST', body: payload }),
}

export const deviceTypes = {
  list: () => request<DeviceType[]>('/device-types'),
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
    request<Paged<Alert> | Alert[]>('/alerts', { query: params, signal }).then(asPaged),
  ack: (id: number) => request<Alert>(`/alerts/${id}/ack`, { method: 'POST' }),
  resolve: (id: number) => request<Alert>(`/alerts/${id}/resolve`, { method: 'POST' }),
  bulkAck: (ids: number[]) =>
    request<{ updated: number }>('/alerts/bulk-ack', { method: 'POST', body: { alert_ids: ids } }),
}

export const rules = {
  list: () => request<AlertRule[]>('/alert-rules'),
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

export const incidents = {
  list: (params: { state?: string; severity?: string; site_id?: number; page?: number } = {}, signal?: AbortSignal) =>
    request<Paged<Incident> | Incident[]>('/incidents', { query: params, signal }).then(asPaged),

  get: (id: number, signal?: AbortSignal) => request<Incident>(`/incidents/${id}`, { signal }),

  update: (id: number, payload: Partial<Pick<Incident, 'state' | 'assigned_to' | 'title' | 'severity'>>) =>
    request<Incident>(`/incidents/${id}`, { method: 'PATCH', body: payload }),

  /** Regenerate the AI root-cause analysis. Long timeout: two model calls. */
  analyze: (id: number) =>
    request<Incident & { fallback_used?: boolean; latency_ms?: number }>(`/incidents/${id}/analyze`, {
      method: 'POST',
      timeoutMs: 120_000,
    }),

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
    request<Paged<AiInsight> | AiInsight[]>('/ai/insights', { query: params }).then(asPaged),

  queryHistory: () => request<NlQueryLogEntry[]>('/ai/query-history'),
}

/* -------------------------------------------------------------------------- */
/* Predictions                                                                */
/* -------------------------------------------------------------------------- */

export const predictions = {
  list: (params: { state?: string; device_id?: number; site_id?: number } = {}) =>
    request<MaintenancePrediction[]>('/predictions', { query: params }),
  schedule: (id: number, scheduled_for: string) =>
    request<MaintenancePrediction>(`/predictions/${id}/schedule`, { method: 'POST', body: { scheduled_for } }),
  dismiss: (id: number, reason: string) =>
    request<MaintenancePrediction>(`/predictions/${id}/dismiss`, { method: 'POST', body: { reason } }),
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

export const admin = {
  apiKeys: () => request<ApiKey[]>('/api-keys'),

  /** The plaintext key is returned exactly once, here. It is never retrievable again. */
  createApiKey: (name: string, site_id?: number) =>
    request<{ api_key: ApiKey; plaintext_key: string; warning: string }>('/api-keys', {
      method: 'POST',
      body: { name, site_id },
    }),

  revokeApiKey: (id: number) => request<{ ok: boolean }>(`/api-keys/${id}`, { method: 'DELETE' }),

  auditLog: (params: { action?: string; user_id?: number; page?: number } = {}) =>
    request<Paged<AuditEntry> | AuditEntry[]>('/audit-log', { query: params }).then(asPaged),

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
