/**
 * Types mirroring the Xano backend's response shapes.
 *
 * Hand-written rather than generated from Swagger: the endpoints compose joined and
 * derived fields that the table schema alone does not describe, and a hand-written
 * type is where a backend/frontend mismatch actually gets caught.
 */

export type Role = 'admin' | 'operator' | 'viewer'
export type Severity = 'critical' | 'warning' | 'info'
export type DeviceStatus = 'online' | 'degraded' | 'offline' | 'maintenance' | 'provisioning'
export type AlertState = 'firing' | 'acknowledged' | 'resolved'
export type IncidentState = 'open' | 'investigating' | 'mitigated' | 'resolved'
export type PredictionState = 'open' | 'scheduled' | 'dismissed' | 'completed'
export type MetricKind = 'gauge' | 'counter' | 'state'
export type DeviceCategory =
  | 'robot'
  | 'refrigeration'
  | 'hvac'
  | 'machine_tool'
  | 'power'
  | 'gateway'
  | 'other'

export type CommandName =
  | 'restart'
  | 'firmware_update'
  | 'calibrate'
  | 'set_config'
  | 'return_to_dock'
  | 'enter_maintenance'
  | 'clear_fault'

export type RuleCondition =
  | 'gt'
  | 'lt'
  | 'outside_range'
  | 'rate_of_change'
  | 'flatline'
  | 'offline'
  | 'anomaly'

export interface User {
  id: number
  name: string
  email: string
  role: Role
  avatar_color?: string | null
  last_login_at?: string | null
  demo_account?: boolean
  created_at?: string
}

export interface Site {
  id: number
  code: string
  name: string
  timezone?: string
  region?: string | null
  address?: string | null
  lat?: number | null
  lng?: number | null
  device_count?: number
  avg_health?: number
  open_incidents?: number
}

/** One entry of a device type's declarative metric contract. */
export interface MetricSchemaEntry {
  key: string
  label: string
  unit: string
  kind: MetricKind
  nominal_min?: number | null
  nominal_max?: number | null
  hard_min?: number | null
  hard_max?: number | null
  precision?: number
}

export interface DeviceType {
  id: number
  code: string
  name: string
  category: DeviceCategory
  manufacturer?: string | null
  model?: string | null
  icon?: string | null
  offline_after_seconds?: number
  metric_schema?: MetricSchemaEntry[] | null
  device_count?: number
}

export type MetricValues = Record<string, number | string | boolean | null>

export interface Device {
  id: number
  serial: string
  name: string
  device_type_id: number
  site_id: number
  status: DeviceStatus
  firmware_version?: string | null
  location_label?: string | null
  last_seen_at?: string | null
  health_score: number
  install_date?: string | null
  tags?: string[] | null
  notes?: string | null
  auto_provisioned?: boolean
  metrics_latest?: MetricValues | null
  uplink_device_id?: number | null
  created_at?: string

  // Joined by the list/detail endpoints.
  site_name?: string
  site_code?: string
  device_type_name?: string
  device_type_category?: DeviceCategory
  device_type?: DeviceType
  site?: Site
  firing_alerts?: Alert[]
  open_predictions?: MaintenancePrediction[]
  recent_commands?: DeviceCommand[]
}

export interface Alert {
  id: number
  alert_rule_id?: number | null
  device_id: number
  incident_id?: number | null
  metric_key?: string | null
  observed_value?: number | null
  threshold?: number | null
  z_score?: number | null
  severity: Severity
  state: AlertState
  fired_at: string
  resolved_at?: string | null
  acknowledged_at?: string | null
  acked_by?: number | null
  message?: string | null
  context?: Record<string, unknown> | null
  created_at?: string

  device_name?: string
  device_serial?: string
  site_name?: string
  rule_name?: string
  acked_by_name?: string
}

export interface RemediationStep {
  step?: string
  action?: string
  detail?: string
}

export interface Incident {
  id: number
  title: string
  severity: Severity
  state: IncidentState
  site_id?: number | null
  device_count: number
  alert_count: number
  opened_at: string
  resolved_at?: string | null
  assigned_to?: number | null
  correlation_key?: string | null
  correlation_reason?: string | null

  ai_summary?: string | null
  ai_root_cause?: string | null
  ai_confidence?: number | null
  ai_remediation?: (string | RemediationStep)[] | null
  ai_evidence?: string[] | null
  ai_model?: string | null
  ai_generated_at?: string | null
  ai_postmortem?: string | null
  ai_fallback_used?: boolean

  site_name?: string
  assignee_name?: string
  alerts?: Alert[]
  devices?: Device[]
  commands?: DeviceCommand[]
  has_ai_analysis?: boolean
}

export interface AlertRule {
  id: number
  name: string
  description?: string | null
  device_type_id?: number | null
  device_id?: number | null
  site_id?: number | null
  metric_key?: string | null
  condition: RuleCondition
  threshold?: number | null
  threshold_high?: number | null
  window_seconds?: number
  z_threshold?: number
  severity: Severity
  enabled: boolean
  cooldown_seconds?: number
  natural_language_source?: string | null
  ai_generated?: boolean
  last_fired_at?: string | null
  fire_count?: number
  created_at?: string

  device_type_name?: string
  site_name?: string
  device_name?: string
  scope_label?: string
}

export interface MaintenancePrediction {
  id: number
  device_id: number
  component: string
  metric_key?: string | null
  trend_slope?: number | null
  predicted_failure_at?: string | null
  confidence?: number | null
  evidence?: Record<string, unknown> | null
  recommended_action?: string | null
  state: PredictionState
  scheduled_for?: string | null
  created_at?: string

  device_name?: string
  device_serial?: string
  site_name?: string
}

export interface DeviceCommand {
  id: number
  device_id: number
  command: CommandName
  payload?: Record<string, unknown> | null
  state: 'queued' | 'sent' | 'acked' | 'failed' | 'expired'
  issued_by?: number | null
  incident_id?: number | null
  sent_at?: string | null
  acked_at?: string | null
  result?: Record<string, unknown> | null
  note?: string | null
  created_at?: string

  device_name?: string
  issued_by_name?: string
}

export type InsightKind =
  | 'fleet_digest'
  | 'predictive_maintenance'
  | 'anomaly_explanation'
  | 'incident_triage'
  | 'postmortem'
  | 'rule_synthesis'
  | 'nl_query'

export interface AiInsight {
  id: number
  kind: InsightKind
  device_id?: number | null
  incident_id?: number | null
  title?: string | null
  body?: string | null
  confidence?: number | null
  payload?: Record<string, unknown> | null
  model?: string | null
  input_tokens?: number
  output_tokens?: number
  latency_ms?: number
  fallback_used?: boolean
  error?: string | null
  created_at: string
}

export interface ApiKey {
  id: number
  name: string
  key_prefix: string
  site_id?: number | null
  enabled: boolean
  last_used_at?: string | null
  use_count?: number
  created_at: string
  site_name?: string
}

export interface AuditEntry {
  id: number
  user_id?: number | null
  action: string
  entity_type?: string | null
  entity_id?: number | null
  detail?: Record<string, unknown> | null
  ip?: string | null
  source: 'ui' | 'api' | 'task' | 'device' | 'system'
  created_at: string
  user_name?: string
}

export interface FleetOverview {
  device_total: number
  status_counts: Record<DeviceStatus, number>
  incident_counts: Record<Severity, number>
  alert_counts: Record<Severity, number>
  avg_health: number
  unhealthy_count: number
  readings_last_hour: number
  sites: Site[]
  worst_devices: Device[]
  digest?: AiInsight | null
  open_incident_total?: number
  firing_alert_total?: number
}

export interface HealthBucket {
  bucket: string
  from: number
  to: number
  count: number
}

export interface HealthDistribution {
  buckets: HealthBucket[]
  by_category: { category: DeviceCategory; avg_health: number; count: number }[]
}

/** One point of a metric series. `min`/`max` are present only for rollup-sourced data. */
export interface SeriesPoint {
  ts: string
  value: number | null
  min?: number | null
  max?: number | null
}

export interface MetricSeries {
  metric_key: string
  label?: string
  unit?: string
  nominal_min?: number | null
  nominal_max?: number | null
  points: SeriesPoint[]
  source: 'rollup' | 'raw'
  truncated?: boolean
  point_cap?: number
}

export interface TimelineEntry {
  ts: string
  kind: 'alert' | 'command' | 'prediction' | 'status'
  severity?: Severity
  /**
   * Free-form. The backend sends a string for most kinds but an OBJECT for status
   * changes (e.g. `{user_id, source, changes}`), so this is deliberately not typed as
   * `string` - rendering it directly threw "Objects are not valid as a React child".
   * Use `describeDetail()` from lib/format to render it.
   */
  title: string
  detail?: string
  ref_id?: number
}

export interface NlQueryPlan {
  entity: string
  filters?: { field: string; op: string; value: unknown }[]
  time_range?: { from?: string; to?: string }
  aggregate?: { fn: string; field?: string; group_by?: string }
  sort?: string
  limit?: number
  chart_hint?: { type: string; x?: string; y?: string }
}

export interface NlQueryResult {
  success: boolean
  answer?: string
  rows?: Record<string, unknown>[]
  row_count?: number
  plan?: NlQueryPlan
  chart_hint?: NlQueryPlan['chart_hint']
  fallback_used?: boolean
  latency_ms?: number
  error?: string
  reason?: string
}

export interface NlQueryLogEntry {
  id: number
  question: string
  answer?: string | null
  row_count?: number
  success: boolean
  fallback_used?: boolean
  latency_ms?: number
  created_at: string
}

export interface RuleProposal {
  proposal: Partial<AlertRule> & { device_type_code?: string; site_code?: string }
  restatement?: string
  saved?: boolean
  rule?: AlertRule
  fallback_used?: boolean
  errors?: string[]
}

export interface AnomalyExplanation {
  explanation?: string
  shape?: string
  likely_fault?: boolean
  what_to_check?: string[]
  series_summary?: Record<string, unknown>
  fallback_used?: boolean
  model?: string
  latency_ms?: number
}

/** Xano's list-return envelope when paging is requested. */
export interface Paged<T> {
  items: T[]
  itemsTotal?: number
  itemsReceived?: number
  curPage?: number
  pageTotal?: number
  nextPage?: number | null
  prevPage?: number | null
}
