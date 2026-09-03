# Nerve — demo runbook

A rehearsable 3-minute walkthrough for the hackathon submission, plus the setup that has
to happen **before** you hit record.

The demo has one job: make a judge believe the AI is doing real work on real data, not
narrating a fixture. Everything below is arranged around that.

---

## Before you record

### T-30 minutes — seed history

Rollups and baselines need history to exist. A cold instance shows empty charts, and
`anomaly` rules cannot fire until a baseline has ~20 samples, so **backfill first**.

```bash
node simulator/index.js --backfill 24
```

Then confirm the rollup task has run at least once (Xano UI → Tasks →
`task_rollup_metrics`), or charts will fall back to raw readings.

### T-10 minutes — start the live stream and stage a fault

Two terminals. The first keeps the fleet alive; the second injects the fault you are
going to diagnose on camera.

```bash
# Terminal 1 — the healthy fleet
node simulator/index.js

# Terminal 2 — the fault, ~5 min before recording so alerts have fired and correlated
node simulator/index.js --scenario freezer-door-ajar --site OSA-01 --skip-register
```

`freezer-door-ajar` is the right scenario to lead with: it produces **six correlated
alerts from one physical cause**, which is exactly the argument the product makes. The
thermal ramp takes ~25 simulated minutes to plateau, so give it a head start or add
`--speed 10`.

Then either wait for `task_correlate_incidents` (every 2 min) or force it: **Incidents →
Run triage now**.

### T-2 minutes — pre-flight checklist

- [ ] Instance is on **Essential or above** (Free = 10 req/20s; the demo will visibly stall)
- [ ] `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` set in Workspace Settings → Environment Variables
- [ ] All six tasks show `active` in Xano → Tasks
- [ ] `node scripts/smoke-test.mjs --base <instance> --ai` passes
- [ ] At least one **open incident with AI analysis** exists — check Overview
- [ ] Browser zoom ~110%, dark or light chosen deliberately, dev tools closed
- [ ] Second terminal visible if you want to show ingest volume live

---

## The 3-minute script

### 0:00–0:20 — The problem, stated as a cost

> "This is a fleet of 36 industrial devices — mobile robots, freezers, HVAC, CNC
> machines. In Datadog, instrumenting twelve metrics across this fleet is a per-metric
> billing decision, so people instrument less than they should. And when something breaks,
> the tool shows you a red graph and stops."

Land on **Overview**. Don't narrate the tiles — let them be seen.

### 0:20–1:10 — Incident correlation (the core argument)

Click the open incident.

> "Six freezers at Osaka went out of range in the same ten minutes. Threshold monitoring
> gives you six alerts and six pages. Nerve grouped them into **one incident** — because
> they share a site, a device type, and a metric — and then asked Claude to explain it."

Read the **root cause** aloud. Point at three things in this order:

1. **Confidence** — "it says 0.82, not 'certain'"
2. **Evidence** — "and here's what it reasoned over: the actual readings, the thresholds, the time span"
3. **Remediation** — the numbered checklist

> "The evidence panel matters more than the answer. It means I can check its work."

Then click **Issue command → enter maintenance** across the affected devices.

> "And I fix it here. I don't leave the incident to go find another tool."

### 1:10–2:00 — Ask the fleet a question (the headline)

Go to **Ask**. Type it live — do not paste:

> `Which freezers drifted above -15°C in the last 6 hours?`

While it runs:

> "There's no query language here. No PromQL, no query builder. But this isn't a chatbot
> guessing either."

When the answer lands, expand **"How this was answered"**.

> "Claude didn't write SQL. It filled in a **query plan** — entity, filters, time range —
> and Xano validated every field of that plan against an allowlist before executing it as
> a real database query. If the model asks for a field that isn't queryable, the plan is
> **rejected, not executed**. The model plans; Xano executes."

That distinction is the whole trust argument. Say it clearly.

Optionally ask a second, aggregate question to show range:

> `What's the average spindle temperature per site?`

### 2:00–2:35 — Natural-language rules + prediction

**Rules** tab. Type:

> `page me if any freezer sits above -15°C for 10 minutes`

> "It proposes a rule and — this is the part I care about — it **restates in English what
> it understood** before I save. So I can catch a misread instead of discovering it at 3am."

Save it, then point at the rules table:

> "And the rule keeps the sentence I typed. Six months from now it explains itself,
> instead of being an anonymous `temp_c > -15`."

Then hit **Test** on a rule:

> "Before it can page anyone, I can dry-run it against real history: 'would have fired 47
> times across 6 devices in 24 hours — probably too sensitive.' It creates no alerts."

Jump to **Predictions**:

> "And this is the failure that no threshold catches — a robot battery losing usable
> capacity. It still charges to 100%, so nothing trips. The failure is in the *trend*, and
> the evidence panel shows the fit it extrapolated from."

### 2:35–3:00 — What Xano is doing, and close

> "All of this is Xano. Seventeen tables, three API groups, forty-six endpoints, six cron
> tasks, hashed API-key auth for the devices, and the Anthropic call happening **inside**
> the Xano function stack — so the key never reaches the browser, and every inference is
> logged with its model, tokens, and latency."

Show **Admin → AI activity** for two seconds.

> "Datadog charges you for asking questions and still makes you answer them yourself.
> Nerve is flat-rate, speaks English, and hands you the answer."

---

## Alternative scenarios, if you want a different story

| Scenario | The point it makes | Best beat to use it in |
|---|---|---|
| `gateway-drop` | 40 alerts, one fault — the most *dramatic* correlation | Swap for the freezer story if you want scale |
| `spindle-bearing-wear` | Two metrics moving in lockstep; no single one leaves its band early | Great for "thresholds can't express this" |
| `hvac-short-cycling` | Every reading in range; only the *frequency* is wrong | Strongest anti-threshold argument, but hardest to see in 10 seconds |
| `power-brownout` | One cause across four device *types* | Use if the judges are infrastructure people |
| `amr-battery-degradation` | Predictive, not reactive | Already in the script at 2:35 |

`gateway-drop` is the best *visual* (a whole site goes dark at once) but needs `--speed 10`
and about five minutes of lead time before the cascade lands.

---

## Things that will bite you on camera

- **The Free plan.** 10 requests per 20 seconds, instance-wide. The UI polls. You will
  watch it throttle. Upgrade first.
- **AI latency.** `/incidents/{id}/analyze` makes a real model call and can take 30–90s.
  Either pre-generate it before recording, or narrate while it runs — the pending state
  says what it is doing, so use that.
- **Empty charts.** Almost always missing backfill, or `task_rollup_metrics` hasn't run.
- **`anomaly` rules not firing.** Baselines need ~20 samples per device per metric before
  a z-score is emitted at all. Backfill fixes this; a fresh instance cannot show it.
- **`fallback_used: true` everywhere.** The Anthropic key isn't set, or `ANTHROPIC_MODEL`
  names a model that doesn't exist. The app deliberately still works, which means this
  fails *quietly* — check Admin → AI activity before recording, not during.
- **Don't paste the questions.** Typing them is most of what makes the feature believable.

---

## Submission checklist

- [ ] **Project name:** Nerve
- [ ] **One-line pitch:** The nervous system for your device fleet — AI-native IoT
      telemetry monitoring that turns a firehose of signals into a short list of incidents
      worth your attention.
- [x] **Public repo** with this README - https://github.com/shrikantwagh/nerve-iot-telemetry
- [ ] **2–4 minute demo** covering: incident correlation → NL query → NL rule → prediction
- [ ] **Build story** — see README § Build story
- [ ] Live URL from `xano static_host get nerve`
