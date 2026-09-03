# Nerve — Design

> **The nervous system for your device fleet.** AI-native IoT telemetry monitoring that
> turns a firehose of signals into a short list of incidents worth your attention.

**Hackathon:** Xano — *Rebuild a SaaS Tool You Hate*
**Replaces:** AWS IoT Device Management (+ IoT Core console) and Datadog for device telemetry.

---

## 1. The software we hate, and why

| What we hate | Where it hurts | What Nerve does instead |
|---|---|---|
| **Datadog's cardinality billing** — every new metric tag is a line item; a fleet of 5k devices x 12 metrics is a surprise invoice | You self-censor what you instrument | Flat per-device model. Telemetry is rows in Postgres, not a billing event. Instrument everything. |
| **Threshold-only alerting** — you hand-tune `temp > 80` forever and still get paged at 3am | Alert fatigue; real problems buried in noise | Statistical baselines (EWMA + z-score) per device per metric, plus **AI correlation** that collapses 40 alerts into 1 incident with a root-cause hypothesis |
| **AWS IoT device onboarding** — thing types, thing groups, policies, certs, six console screens before one device reports | Days to onboard a device class | `POST /ingest/register` — a device announces itself with a serial and an API key, and is provisioned, typed and charted in one call |
| **No root-cause help** — the tool shows you a red graph and stops | Every incident starts from zero | Every incident ships with an AI root-cause hypothesis, a confidence score, the evidence it used, and a remediation runbook |
| **Query languages as a gate** — PromQL, Datadog's query editor, IoT SiteWise formulas | Only two people on the team can answer a question | Ask in English: *"which freezers in Osaka drifted above -15C for more than 10 minutes last night?"* -> compiled to a real query, executed, answered, charted |
| **Read-only dashboards** — you see the problem in one tool and fix it in another | Context switching mid-incident | Commands are first-class: restart, calibrate, return-to-dock, enter-maintenance, push firmware — issued from the incident view, audit-logged |

**The one-liner for judges:** Datadog charges you for asking questions and still makes you
answer them yourself. Nerve is flat-rate, speaks English, and hands you the answer.

---

## 2. Why Xano is doing real work here

Not "Xano as a CRUD wrapper" — the backend carries the product.

| Xano capability | How Nerve depends on it |
|---|---|
| **Data model** (16 tables, table refs, composite indexes, json fields, enums) | Devices, device types with a declarative `metric_schema`, wide-format time-series, rollups, rules, alerts, incidents |
| **Auth (JWT)** | Signup / login / me, role-gated endpoints (`admin` / `operator` / `viewer`), one-click demo login for judges |
| **Middleware** | `mw_api_key_auth` on the ingest group — devices authenticate with hashed API keys, *not* user JWTs. Post-middleware writes the audit log. |
| **Custom functions** | `fn_claude` (the Anthropic wrapper every AI endpoint reuses), `fn_evaluate_rules`, `fn_compute_health`, `fn_resolve_device`, `fn_update_baseline`, `fn_correlate`, `fn_audit` |
| **Background tasks (cron)** | Six tasks: offline sweep, metric rollups, **AI incident correlation**, predictive-maintenance sweep, daily AI fleet digest, retention pruning |
| **Background tasks** | Correlation runs on a 2-minute task rather than an `alert`-insert trigger: Xano does not document whether triggers fire per row on `db.bulk.add`, and the ingest path inserts in bulk, so a trigger could either miss batches or fire 500 times. A task is the honest choice. |
| **External API calls** | Anthropic Messages API called from the function stack, keyed by a workspace env var (`ANTHROPIC_API_KEY`) — the AI lives in the backend, not the browser |
| **Realtime channels** | `fleet:{site}` and `device:{id}` — live tiles and live charts without polling |
| **Static hosting** | The React SPA ships to Xano static hosting; one platform, one deploy |

The AI is **server-side by design**: the API key never reaches the browser, every
inference is logged to `ai_insight` with model, tokens and latency, and any AI endpoint can
be replayed for the demo.

---

## 3. Data model

16 tables. An arrow marks a table reference.

### Identity and tenancy

**`user`** — `email` (unique), `password`, `name`, `role` (`admin|operator|viewer`),
`avatar_color`, `last_login_at`

**`site`** — `name`, `code` (unique), `timezone`, `lat`, `lng`, `address`, `region`

**`api_key`** — `name`, `key_prefix`, `key_hash`, `-> site`, `enabled`, `last_used_at`,
`-> created_by`, `scopes` (json). Plaintext returned exactly once, on creation.

### Devices

**`device_type`** — the template that makes onboarding one call instead of six screens.
`name`, `category` (`robot|refrigeration|hvac|machine_tool|power|gateway`), `manufacturer`,
`model`, `icon`, `offline_after_seconds`, and
`metric_schema` (json): `[{key, label, unit, kind: gauge|counter|state, nominal_min, nominal_max, hard_min, hard_max, precision}]`

**`device`** — `name`, `serial` (unique), `-> device_type`, `-> site`, `status`
(`online|degraded|offline|maintenance|provisioning`), `firmware_version`, `last_seen_at`,
`health_score` (0-100), `install_date`, `tags` (json), `location_label`, `notes`,
`auto_provisioned` (bool), `metrics_latest` (json — denormalized last reading, so the
fleet grid is one query, not N)

**`device_command`** — `-> device`, `command`
(`restart|firmware_update|calibrate|set_config|return_to_dock|enter_maintenance|clear_fault`),
`payload` (json), `state` (`queued|sent|acked|failed`), `-> issued_by`, `issued_at`,
`acked_at`, `result` (json)

### Telemetry

**`telemetry`** — wide format, one row per reading. `-> device` (indexed), `ts` (indexed),
`metrics` (json `{key: value}`), `flags` (json), `ingest_latency_ms`.
Composite index `(device_id, ts DESC)`.
*Why wide:* ingest is one insert per reading instead of twelve, and the fleet grid reads
`device.metrics_latest` without touching this table at all.

**`metric_rollup`** — cron-built 5-minute buckets, so charts stay fast as the table grows.
`-> device`, `metric_key`, `bucket_ts`, `avg_value`, `min_value`, `max_value`,
`sample_count`, `stddev`. Composite index `(device_id, metric_key, bucket_ts)`.

**`metric_baseline`** — the thing that replaces hand-tuned thresholds. Per device, per
metric: `ewma`, `ewmv`, `sample_count`, `updated_at`. A reading is anomalous when
`|x - ewma| / sqrt(ewmv) > z` — learned, not configured.

### Alerting

**`alert_rule`** — `name`, `-> device_type?`, `-> device?`, `-> site?`, `metric_key`,
`condition` (`gt|lt|outside_range|rate_of_change|flatline|offline|anomaly`), `threshold`,
`threshold_high`, `window_seconds`, `z_threshold`, `severity` (`critical|warning|info`),
`enabled`, `cooldown_seconds`, `-> created_by`,
**`natural_language_source`** (the English sentence a human typed, kept so the rule is
self-documenting), `ai_generated` (bool)

**`alert`** — `-> alert_rule`, `-> device`, `metric_key`, `observed_value`, `threshold`,
`severity`, `state` (`firing|acknowledged|resolved`), `fired_at`, `resolved_at`,
`-> acked_by`, `-> incident?`, `message`, `context` (json — the window of readings that fired it)

**`incident`** — an AI-correlated cluster of alerts. `title`, `severity`, `state`
(`open|investigating|mitigated|resolved`), `-> site`, `device_count`, `alert_count`,
`opened_at`, `resolved_at`, `-> assigned_to`, `correlation_key`, `correlation_reason`,
plus the AI payload: `ai_summary`, `ai_root_cause`, `ai_confidence`, `ai_remediation`
(json steps), `ai_evidence` (json), `ai_model`, `ai_generated_at`, `ai_postmortem`

### AI

**`ai_insight`** — every inference, logged. `kind`
(`fleet_digest|predictive_maintenance|anomaly_explanation|incident_triage|postmortem|rule_synthesis`),
`-> device?`, `-> incident?`, `title`, `body`, `confidence`, `payload` (json), `model`,
`input_tokens`, `output_tokens`, `latency_ms`, `fallback_used` (bool)

**`nl_query_log`** — `-> user`, `question`, `generated_plan` (json), `row_count`, `answer`,
`chart_hint` (json), `latency_ms`, `success`, `error`. Doubles as the "recent questions"
UI and as proof the NL-to-query compiler works.

**`maintenance_prediction`** — `-> device`, `component`, `predicted_failure_at`,
`confidence`, `evidence` (json), `recommended_action`, `state`
(`open|scheduled|dismissed|completed`), `-> scheduled_by`, `metric_key`, `trend_slope`

### Ops

**`audit_log`** — `-> user?`, `action`, `entity_type`, `entity_id`, `detail` (json), `ip`,
`source` (`ui|api|task|device`)

---

## 4. API surface

Base: `https://<instance>.xano.io/api:<group>`

### Group `auth` — public

| Verb | Path | Notes |
|---|---|---|
| POST | `/signup` | -> `{ authToken, user }` |
| POST | `/login` | -> `{ authToken, user }` |
| POST | `/demo` | **one-click demo login** — judges never type a password |
| GET | `/me` | auth required |

### Group `ingest` — API-key auth (`mw_api_key_auth`), no user JWT

| Verb | Path | Notes |
|---|---|---|
| POST | `/register` | device self-provisioning: serial + type code + site code -> device |
| POST | `/telemetry` | single reading; updates `metrics_latest` and `last_seen_at`, advances baselines, evaluates rules, publishes realtime |
| POST | `/telemetry/batch` | up to 500 readings per call — the simulator's path |
| POST | `/command/ack` | device reports back on a queued command |

### Group `api` — user JWT

- **Fleet** — `GET /fleet/overview`, `GET /fleet/map`, `GET /fleet/health-distribution`
- **Devices** — `GET /devices` (filter: site, status, type, q, sort, page), `POST /devices`,
  `GET /devices/{id}`, `PATCH /devices/{id}`, `DELETE /devices/{id}`,
  `GET /devices/{id}/telemetry?metric&from&to&resolution`, `GET /devices/{id}/timeline`
- **Commands** — `POST /devices/{id}/commands`, `GET /devices/{id}/commands`
- **Reference** — `GET|POST /sites`, `GET|POST /device-types`
- **Alerts** — `GET /alerts`, `POST /alerts/{id}/ack`, `POST /alerts/{id}/resolve`,
  `POST /alerts/bulk-ack`
- **Rules** — `GET|POST /alert-rules`, `PATCH|DELETE /alert-rules/{id}`,
  `POST /alert-rules/{id}/test`
- **Incidents** — `GET /incidents`, `GET /incidents/{id}`, `PATCH /incidents/{id}`,
  `POST /incidents/{id}/analyze`, `POST /incidents/{id}/postmortem`
- **AI** — `POST /ai/query` *, `POST /ai/rule-from-text` *, `POST /ai/triage`,
  `GET /ai/digest`, `POST /ai/explain-anomaly`, `GET /ai/insights`
- **Predictive** — `GET /predictions`, `POST /predictions/{id}/schedule`,
  `POST /predictions/{id}/dismiss`
- **Admin** — `GET|POST /api-keys`, `DELETE /api-keys/{id}`, `GET /audit-log`,
  `POST /admin/seed`

`*` marks the two endpoints the demo is built around.

---

## 5. Background tasks (Xano cron)

| Task | Cadence | Job |
|---|---|---|
| `task_offline_sweep` | 1 min | `last_seen_at` older than the type's `offline_after_seconds` -> status `offline`, fire offline alerts |
| `task_rollup_metrics` | 5 min | fold raw `telemetry` into `metric_rollup` buckets |
| `task_correlate_incidents` | 2 min | cluster firing alerts by (site, device_type, metric, time window) -> `incident`; call `fn_claude` for root cause on newly formed ones |
| `task_predictive_sweep` | hourly | linear trend over rollups per device and metric -> `maintenance_prediction` with an AI-worded recommendation |
| `task_fleet_digest` | daily 06:00 | AI digest of the last 24h into `ai_insight` |
| `task_prune_telemetry` | daily 03:00 | retention: raw telemetry older than 14 days dropped, rollups kept |

---

## 6. The AI layer

One custom function, `fn_claude(system, user, max_tokens, tool_schema?)`, wraps the
Anthropic Messages API (`claude-opus-5`) using `$env.ANTHROPIC_API_KEY`. Every caller
logs to `ai_insight`. Six consumers:

1. **`/ai/query`** — natural language to a constrained JSON query plan (entity, filters,
   time range, aggregate, chart hint), validated against a field whitelist, then executed
   as a real `db.query` — results plus a written answer. The model *plans*; Xano
   *executes*. No SQL ever comes from the model.
2. **`/ai/rule-from-text`** — "page me if any freezer sits above -15C for 10 minutes"
   becomes a populated `alert_rule` for one-click save, with `natural_language_source` kept.
3. **`task_correlate_incidents`** — collapses correlated alerts into one incident with a
   root-cause hypothesis, confidence, evidence and remediation steps.
4. **`/ai/explain-anomaly`** — given a device, metric and window, explain the shape.
5. **`task_predictive_sweep`** — turn a trend slope into a maintenance recommendation.
6. **`/incidents/{id}/postmortem`** — draft the writeup from the incident timeline.

**Guardrails.** The model never emits SQL or free-form filters; it fills a schema that
Xano validates against a field whitelist before execution. Failures fall back to a
deterministic analyzer and set `fallback_used`, so a demo never dead-ends on a 429.

---

## 7. Frontend

Vite + React 19 + TypeScript + Tailwind 4 + Recharts, served from Xano static hosting.

Screens: **Overview** (KPI tiles, live ingest sparkline, health distribution, open
incidents, AI digest) - **Fleet** (filterable device grid, live status) - **Device detail**
(multi-metric charts with nominal bands, alert history, command console, timeline) -
**Incidents** (list plus detail with AI root cause, evidence, remediation checklist,
postmortem) - **Alerts** (triage queue, bulk ack) - **Rules** (list plus the
natural-language rule composer) - **Ask** (the natural-language query console, with
history) - **Admin** (API keys, sites, device types, audit log).

---

## 8. Device simulator

`simulator/` — a Node script that runs N virtual devices across the seeded types, emits
realistic telemetry to `/ingest/telemetry/batch`, and can **inject named fault scenarios**
on demand, so the demo is reproducible.

| Scenario | Shape |
|---|---|
| `freezer-door-ajar` | one site's freezers drift up together — the incident-correlation showcase |
| `amr-battery-degradation` | slow capacity fade over simulated weeks — the predictive-maintenance showcase |
| `gateway-drop` | a gateway dies and takes its downstream devices offline — cascade correlation |
| `spindle-bearing-wear` | rising vibration and temperature on a CNC — multi-metric anomaly |
| `hvac-short-cycling` | oscillating compressor state — a pattern no static threshold catches |
| `power-brownout` | site-wide voltage sag — cross-device-type correlation |
