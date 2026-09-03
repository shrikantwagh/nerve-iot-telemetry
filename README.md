# Nerve

**The nervous system for your device fleet.** AI-native IoT telemetry monitoring that turns
a firehose of signals into a short list of incidents worth your attention.

Built for the Xano **"Rebuild a SaaS Tool You Hate"** hackathon.
Backend: Xano (XanoScript, pushed from local files via the Xano CLI). Frontend: Vite + React,
hosted on Xano static hosting.

---

## The software we replaced, and why

**AWS IoT Device Management** (plus the IoT Core console) for the device side, and
**Datadog** for the telemetry side.

| What we hate | Where it hurts | What Nerve does instead |
|---|---|---|
| **Datadog's cardinality billing** — every new metric tag is a line item; 5,000 devices × 12 metrics is a surprise invoice | You self-censor what you instrument | Telemetry is rows in Postgres, not a billing event. Instrument everything. |
| **Threshold-only alerting** — you hand-tune `temp > 80` forever and still get paged at 3am | Alert fatigue; real problems buried in noise | A learned per-device EWMA/variance baseline, plus **AI correlation** that collapses 40 alerts into one incident with a root-cause hypothesis |
| **AWS IoT onboarding** — thing types, thing groups, policies, certs; six console screens before one device reports | Days to onboard a device class | `POST /ingest/register` — a device announces itself with a serial and an API key and is provisioned, typed and charted in one call |
| **No root-cause help** — the tool shows you a red graph and stops | Every incident starts from zero | Every incident ships an AI root-cause hypothesis with a confidence score, the evidence used, and a remediation runbook |
| **Query languages as a gate** — PromQL, Datadog's editor, SiteWise formulas | Only two people can answer a question | Ask in English. The model *plans* a query, Xano *executes* it against a field allowlist |
| **Read-only dashboards** — you see the problem in one tool and fix it in another | Context-switching mid-incident | Commands are first-class: restart, calibrate, return-to-dock, enter-maintenance — issued from the incident view, audit-logged |

**The pitch in one line:** Datadog charges you for asking questions and still makes you
answer them yourself. Nerve is flat-rate, speaks English, and hands you the answer.

---

## What Xano is actually doing

Not a CRUD wrapper — the backend carries the product.

| Xano capability | How Nerve depends on it |
|---|---|
| **Data model** — 16 tables, table refs, composite indexes, json columns, enums | Devices, device types with a declarative `metric_schema`, wide-format time-series, rollups, learned baselines, rules, alerts, incidents |
| **Auth (JWT)** | Signup / login / me, role-gated endpoints (`admin` / `operator` / `viewer`), and a one-click demo login so a judge never types a password |
| **Middleware** | `mw_api_key_auth` on the ingest group — devices authenticate with hashed API keys, never a user JWT |
| **Custom functions** | `fn_claude` (the Anthropic wrapper every AI feature reuses), `fn_evaluate_rules`, `fn_update_baseline`, `fn_correlate`, `fn_compute_health`, `fn_resolve_device`, `fn_audit` |
| **Background tasks** | Six: offline sweep, metric rollups, **AI incident correlation**, predictive-maintenance sweep, daily AI digest, retention pruning |
| **External API calls** | The Anthropic Messages API called from the function stack, keyed by `$env.ANTHROPIC_API_KEY` — the AI lives in the backend, not the browser |
| **Realtime channels** | Live fleet and per-device feeds without polling |
| **Static hosting** | The React SPA ships to Xano static hosting. One platform, one deploy |

**The AI is server-side by design.** The API key never reaches the browser, and every
inference is logged to `ai_insight` with model, token counts, latency, and a
`fallback_used` flag. That row is the honesty mechanism: nobody has to take an AI claim on
faith.

---

## The two features the demo is built around

### 1. Ask the fleet a question in English

> *"Which freezers drifted above -15°C in the last 6 hours?"*

`POST /ai/query`. The governing rule is **the model plans, Xano executes**:

1. Claude receives a compact description of what is queryable (entities, their filterable
   fields, the live site codes / device type codes / metric keys) and returns a **JSON
   query plan** — never SQL, never a free-form filter.
2. Xano **validates every field of that plan** against a hardcoded per-entity allowlist,
   restricts the operators, and clamps the row limit. A plan that references anything
   unlisted is **rejected, not executed**.
3. Xano runs the validated plan as a real `db.query`, then a second model call turns the
   rows into prose.

The UI shows the validated plan next to the answer, because that is what separates this
from a chatbot guessing.

### 2. AI incident correlation

A propped-open freezer door at one site warms six freezers at once. Threshold monitoring
gives you six alerts. `task_correlate_incidents` clusters them into **one incident** with
a root-cause hypothesis, a confidence score, the evidence it reasoned over, and a
remediation checklist — then lets you issue the fix to every affected device in one action.

---

## Repository layout

```
backend/          XanoScript — the Xano workspace as local files
  table/          16 tables
  function/nerve/ shared custom functions (fn_claude, fn_correlate, ...)
  api/            three API groups: NerveAuth (auth), NerveIngest (ingest), Nerve (nerve)
  task/           six background tasks
  middleware/     API-key auth for device ingest
static/           Vite + React + TypeScript SPA (Xano static hosting)
simulator/        virtual industrial IoT fleet with injectable fault scenarios
scripts/          xs-validate.mjs — XanoScript validation via the Xano Developer MCP
docs/             DESIGN.md, SYNTAX_CONTRACT.md, TABLE_CONTRACT.md, research notes
```

---

## Running it

### Prerequisites

- Node 20+
- A Xano instance on **Essential or above**. The Free plan enforces **10 requests per 20
  seconds instance-wide**, which makes telemetry ingest impossible, and static hosting is
  a paid feature.
- `npm i -g @xano/cli && xano auth`

### 1. Push the backend

```bash
xano workspace push -d ./backend --dry-run   # always look first
xano workspace push -d ./backend
```

### 2. Add two workspace environment variables

Environment variables can only be created in the Xano UI (the CLI cannot create them).
**Workspace Settings → Environment Variables:**

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` |

Every AI endpoint works without these — it falls back to a deterministic analyzer and
sets `fallback_used`, so a fresh clone is demoable with zero credentials.

### 3. Enable the background tasks

Tasks are pushed with `active = true`, but confirm they are running under **Tasks** in the
Xano UI. Also enable **Realtime** (Settings → Realtime) if you want live push; first
enablement provisions resources and takes a few minutes.

### 4. Seed and run the fleet

Sign up in the UI (the first account on a fresh workspace becomes `admin`), then:

1. **Admin → Setup → Seed reference data** — creates the 4 sites, 6 device types and a
   starter set of alert rules.
2. **Admin → API keys → Create** — copy the plaintext key (shown exactly once).
3. Configure and run the simulator:

```bash
cp simulator/.env.example simulator/.env    # then fill in NERVE_API_BASE and NERVE_API_KEY
node simulator/index.js --backfill 24       # seed 24h of history, then exit
node simulator/index.js                     # stream live telemetry
```

### 5. Build and deploy the frontend

```bash
cd static
npm install
VITE_XANO_API_BASE=https://<your-instance>.xano.io npm run build
cd ..
xano static_host create nerve
xano static_host build push nerve -d ./static/dist -n "v1.0.0"
xano static_host deploy nerve --build_id <id> --env prod
```

---

## The simulator

A reproducible virtual fleet — same seed, same numbers, so a demo can be rehearsed.

Signals are not `base + noise`. Each metric is a mean-reverting random walk with a diurnal
component and Gaussian noise, and metrics are **physically coupled**: a freezer's power
tracks its compressor, an idle CNC's spindle drops to zero, real 3-phase power is computed
as `√3 · V · I · pf`. That matters because the correlations the AI is asked to explain have
to actually exist in the data rather than being asserted by a fixture.

```bash
node simulator/index.js --list-scenarios
```

| Scenario | What it demonstrates |
|---|---|
| `freezer-door-ajar` | Site-wide correlation — six freezers warm together, one cause |
| `gateway-drop` | Cascade — a gateway dies and takes 12 devices with it; 40 alerts, one fault |
| `amr-battery-degradation` | Predictive maintenance — the failure is in the *trend*, not the value |
| `spindle-bearing-wear` | Multi-metric anomaly — vibration and temperature rise in lockstep |
| `hvac-short-cycling` | Pattern anomaly — every reading in range, only the *frequency* wrong |
| `power-brownout` | Cross-device-type correlation — one voltage sag, four device classes affected |
| `amr-wheel-slip` | Slow-burn degradation — why health scoring beats up/down status |
| `gateway-disk-fill` | Forecastable exhaustion — nothing wrong *yet* |

```bash
node simulator/index.js --scenario freezer-door-ajar --site OSA-01
node simulator/index.js --scenario gateway-drop --speed 10
```

---

## Build story

**What we replaced:** AWS IoT Device Management + Datadog for device fleet telemetry.

**Why:** I work on fleet management for autonomous mobile robots, so this is the tool I
actually fight with. The complaints in the table above are not researched sympathies —
cardinality billing, threshold-only rules and read-only dashboards are the daily texture
of the job.

**AI tools used:** Claude Code (Opus 5) for the whole build, driving the **Xano CLI** and
the **Xano Developer MCP**.

**What would have taken significantly longer without AI + Xano:**

- **XanoScript from a standing start.** Rather than trial-and-error against a push,
  `scripts/xs-validate.mjs` drives the Xano Developer MCP over stdio and validates every
  `.xs` file against the real language server before it ever reaches the workspace. That
  turned an unfamiliar declarative language into a fast edit-validate loop. (Getting that
  loop from 120s to 9s for the whole tree was itself worth the detour: `npx` was
  re-checking the registry every call, and a surviving grandchild process was holding the
  event loop open.)
- **Xano collapsed the backend surface.** 16 tables with composite indexes, JWT auth,
  API-key middleware, six cron tasks and an outbound LLM integration are all declarative
  files — no server, no migrations, no deploy pipeline.
- **The generator, not the schema, was the hard part.** Writing a telemetry simulator whose
  cross-metric correlations are physically real — so anomaly detection and root-cause
  reasoning have something genuine to find — was the piece that most needed careful
  iteration, and where exercising the code (rather than reading it) caught two real bugs:
  a `Math.random()` seed that silently destroyed reproducibility, and noise wide enough to
  make a power meter report 0 A while reporting 410 V.

**Honest notes:**

- Xano's docs contradict themselves in places. `db.query` takes `where`, not `search`
  (confirmed from this workspace's own pull output). Table references use `table`, not
  `dbtable`. `num_max` is documented as a filter alias but the language server rejects it.
  Real `xano workspace pull` output is the only reliable ground truth.
- `api.realtime_event` publishes action `event`, not `message` — a client listening for
  `message` silently drops every update.
- The JS SDK's realtime config key is `realtimeConnectionCanonical`; the docs'
  `realtimeCanonical` does not exist in v3.0.1 and throws.
- `db.direct_query` (raw SQL) is gated to Launch/Scale plans, so every aggregation here is
  `db.query` + `foreach` accumulation. The `{type: "aggregate"}` return type exists but its
  XanoScript parameter names are undocumented, so it is deliberately unused.
- Frontend routing is `HashRouter`, because Xano static hosting documents no
  history-fallback rewrite and deep links have to survive being pasted into a chat.

---

## Design notes worth calling out

- **`telemetry` is wide, not long.** One row per reading with all metrics in one json
  column, so a 12-metric device costs one insert instead of twelve.
- **`device.metrics_latest` is denormalized** so the fleet grid is one query, not one per
  device.
- **`metric_baseline` holds EWMA and EWMV per device per metric**, updated incrementally,
  so anomaly detection is O(1) per sample with no historical scan — and every device
  learns its own normal instead of needing a hand-tuned exception.
- **`alert_rule.natural_language_source`** keeps the English sentence a human typed, so a
  rule explains itself six months later instead of being an anonymous `temp_c > -15`.
- **Charts draw the device type's declared nominal band**, which is what turns "the line is
  at 47" into "the line has left its band" without the reader knowing the metric.
- **The chart palette is validated, not eyeballed** — the categorical slots pass CVD and
  normal-vision separation in both light and dark modes; where light-mode contrast falls
  below 3:1, every chart ships direct labels and a table view.
