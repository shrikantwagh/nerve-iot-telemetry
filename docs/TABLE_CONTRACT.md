# Nerve table contract (generated from backend/table/*.xs — do not hand-edit)

Exact field names and types every endpoint must use.

## `ai_insight`

- `int id`
- `timestamp created_at?=now`
- `enum kind`
- `int device_id?`
- `int incident_id?`
- `text title?`
- `text body?`
- `decimal? confidence?`
- `json payload?`
- `text model?`
- `int input_tokens?=0`
- `int output_tokens?=0`
- `int latency_ms?=0`
- `bool fallback_used?=false`
- `text error?`
  - enum `kind` default `none` values ["fleet_digest", "predictive_maintenance", "anomaly_explanation", "incident_triage", "postmortem", "rule_synthesis", "nl_query"]
  - fk `device_id` -> `device`
  - fk `incident_id` -> `incident`

## `alert`

- `int id`
- `timestamp created_at?=now`
- `int alert_rule_id?`
- `int device_id`
- `int incident_id?`
- `text metric_key?`
- `decimal? observed_value?`
- `decimal? threshold?`
- `decimal? z_score?`
- `enum severity?=warning`
- `enum state?=firing`
- `timestamp fired_at?=now`
- `timestamp? resolved_at?`
- `timestamp? acknowledged_at?`
- `int acked_by?`
- `text message?`
- `json context?`
  - enum `severity?` default `warning` values ["critical", "warning", "info"]
  - enum `state?` default `firing` values ["firing", "acknowledged", "resolved"]
  - fk `alert_rule_id` -> `alert_rule`
  - fk `device_id` -> `device`
  - fk `incident_id` -> `incident`
  - fk `acked_by` -> `user`

## `alert_rule`

- `int id`
- `timestamp created_at?=now`
- `text name`
- `text description?`
- `int device_type_id?`
- `int device_id?`
- `int site_id?`
- `text metric_key?`
- `enum condition`
- `decimal? threshold?`
- `decimal? threshold_high?`
- `int window_seconds?=0`
- `decimal z_threshold?=3`
- `enum severity?=warning`
- `bool enabled?=true`
- `int cooldown_seconds?=900`
- `int created_by?`
- `text natural_language_source?`
- `bool ai_generated?=false`
- `timestamp? last_fired_at?`
- `int fire_count?=0`
  - enum `condition` default `none` values ["gt", "lt", "outside_range", "rate_of_change", "flatline", "offline", "anomaly"]
  - enum `severity?` default `warning` values ["critical", "warning", "info"]
  - fk `device_type_id` -> `device_type`
  - fk `device_id` -> `device`
  - fk `site_id` -> `site`
  - fk `created_by` -> `user`

## `api_key`

- `int id`
- `timestamp created_at?=now`
- `text name`
- `text key_prefix`
- `password key_hash`
- `int site_id?`
- `int created_by?`
- `bool enabled?=true`
- `timestamp? last_used_at?`
- `int use_count?=0`
- `json scopes?`
  - fk `site_id` -> `site`
  - fk `created_by` -> `user`

## `audit_log`

- `int id`
- `timestamp created_at?=now`
- `int user_id?`
- `text action`
- `text entity_type?`
- `int entity_id?`
- `json detail?`
- `text ip?`
- `enum source?=ui`
  - enum `source?` default `ui` values ["ui", "api", "task", "device", "system"]
  - fk `user_id` -> `user`

## `device`

- `int id`
- `timestamp created_at?=now`
- `text serial`
- `text name`
- `int device_type_id`
- `int site_id`
- `enum status?=provisioning`
- `text firmware_version?`
- `text location_label?`
- `timestamp? last_seen_at?`
- `decimal health_score?=100`
- `date? install_date?`
- `json tags?`
- `text notes?`
- `bool auto_provisioned?=false`
- `json metrics_latest?`
- `int uplink_device_id?`
  - enum `status?` default `provisioning` values ["online", "degraded", "offline", "maintenance", "provisioning"]
  - fk `device_type_id` -> `device_type`
  - fk `site_id` -> `site`
  - fk `uplink_device_id` -> `device`

## `device_command`

- `int id`
- `timestamp created_at?=now`
- `int device_id`
- `enum command`
- `json payload?`
- `enum state?=queued`
- `int issued_by?`
- `int incident_id?`
- `timestamp? sent_at?`
- `timestamp? acked_at?`
- `json result?`
- `text note?`
  - enum `command` default `none` values ["restart", "firmware_update", "calibrate", "set_config", "return_to_dock", "enter_maintenance", "clear_fault"]
  - enum `state?` default `queued` values ["queued", "sent", "acked", "failed", "expired"]
  - fk `device_id` -> `device`
  - fk `issued_by` -> `user`
  - fk `incident_id` -> `incident`

## `device_type`

- `int id`
- `timestamp created_at?=now`
- `text code`
- `text name`
- `enum category`
- `text manufacturer?`
- `text model?`
- `text icon?`
- `int offline_after_seconds?=300`
- `json metric_schema?`
  - enum `category` default `none` values ["robot", "refrigeration", "hvac", "machine_tool", "power", "gateway", "other"]

## `event_log`

- `int id`
- `timestamp created_at?=now`
- `int user_id?`
- `text action?`
- `json metadata?`
  - fk `user_id` -> `user`

## `incident`

- `int id`
- `timestamp created_at?=now`
- `text title`
- `enum severity?=warning`
- `enum state?=open`
- `int site_id?`
- `int device_count?=0`
- `int alert_count?=0`
- `timestamp opened_at?=now`
- `timestamp? resolved_at?`
- `int assigned_to?`
- `text correlation_key?`
- `text correlation_reason?`
- `text ai_summary?`
- `text ai_root_cause?`
- `decimal? ai_confidence?`
- `json ai_remediation?`
- `json ai_evidence?`
- `text ai_model?`
- `timestamp? ai_generated_at?`
- `text ai_postmortem?`
- `bool ai_fallback_used?=false`
  - enum `severity?` default `warning` values ["critical", "warning", "info"]
  - enum `state?` default `open` values ["open", "investigating", "mitigated", "resolved"]
  - fk `site_id` -> `site`
  - fk `assigned_to` -> `user`

## `maintenance_prediction`

- `int id`
- `timestamp created_at?=now`
- `int device_id`
- `text component`
- `text metric_key?`
- `decimal? trend_slope?`
- `timestamp? predicted_failure_at?`
- `decimal? confidence?`
- `json evidence?`
- `text recommended_action?`
- `enum state?=open`
- `int scheduled_by?`
- `timestamp? scheduled_for?`
  - enum `state?` default `open` values ["open", "scheduled", "dismissed", "completed"]
  - fk `device_id` -> `device`
  - fk `scheduled_by` -> `user`

## `metric_baseline`

- `int id`
- `int device_id`
- `text metric_key`
- `decimal ewma?=0`
- `decimal ewmv?=0`
- `decimal alpha?=0.05`
- `int sample_count?=0`
- `decimal? last_value?`
- `timestamp? updated_at?`
  - fk `device_id` -> `device`

## `metric_rollup`

- `int id`
- `int device_id`
- `text metric_key`
- `timestamp bucket_ts`
- `int bucket_seconds?=300`
- `decimal? avg_value?`
- `decimal? min_value?`
- `decimal? max_value?`
- `decimal? last_value?`
- `decimal? stddev?`
- `int sample_count?=0`
  - fk `device_id` -> `device`

## `nl_query_log`

- `int id`
- `timestamp created_at?=now`
- `int user_id?`
- `text question`
- `json generated_plan?`
- `int row_count?=0`
- `text answer?`
- `json chart_hint?`
- `json rows_preview?`
- `int latency_ms?=0`
- `bool success?=true`
- `bool fallback_used?=false`
- `text error?`
  - fk `user_id` -> `user`

## `site`

- `int id`
- `timestamp created_at?=now`
- `text code`
- `text name`
- `text timezone?=UTC`
- `text region?`
- `text address?`
- `decimal? lat?`
- `decimal? lng?`

## `telemetry`

- `int id`
- `int device_id`
- `timestamp ts`
- `json metrics`
- `json flags?`
- `int ingest_latency_ms?`
  - fk `device_id` -> `device`

## `user`  (auth = true)

- `int id`
- `timestamp created_at?=now`
- `text name`
- `email? email`
- `password? password`
- `enum role?=viewer`
- `object password_reset?`
- `password token?`
- `timestamp? expiration?`
- `bool used?`
- `text avatar_color?`
- `timestamp? last_login_at?`
- `bool demo_account?=false`
  - enum `role?` default `viewer` values ["admin", "operator", "viewer"]
