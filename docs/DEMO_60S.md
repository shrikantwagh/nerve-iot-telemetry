# Nerve — 60-second cut

A one-minute teaser. The submission itself wants **2–4 minutes** (see `DEMO_SCRIPT.md`);
this is the short version for a landing page, a tweet, or an opener.

**Sixty seconds buys you roughly 150 spoken words and four screens.** That is the whole
budget, so this cut makes one argument and drops everything else: *thresholds give you
alerts, Nerve gives you the answer.* No feature tour, no architecture, no signup flow.

Word counts are marked so you can hit the timing without a stopwatch.

---

## Pre-flight (must be true before you hit record)

- [ ] Instance on **Essential+** — Free is 10 req/20s instance-wide and the UI will visibly stall
- [ ] `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` set in Xano → Workspace Settings
- [ ] `node simulator/index.js --backfill 24` has run
- [ ] A fault injected ~5 min earlier and **correlated into an incident with AI analysis**:
      `node simulator/index.js --scenario freezer-door-ajar --site OSA-01 --skip-register`
- [ ] Overview shows a non-zero incident count. **If it shows zero, stop — the video has no subject.**
- [ ] Browser at 1920×1080, dark mode, dev tools closed, bookmarks bar hidden

---

## The cut

### 0:00–0:08 — Cold open on the problem (22 words)

*Screen: Overview, already loaded. Do not narrate the tiles.*

> "Eleven hundred devices. Six alerts just fired at one site. In Datadog that's six pages
> and a red graph. Here it's one incident."

Cut on the word "incident" — straight into the incident view. No mouse wandering.

### 0:08–0:30 — The answer, not the alert (58 words)

*Screen: Incident detail. Scroll is pre-positioned so the root cause is already visible.*

> "Nerve grouped them, because they share a site, a device type and a metric — then asked
> Claude to explain it. A propped-open loading door. Confidence: eighty-two percent. And
> here's what it reasoned over — the actual readings, the thresholds it breached, the time
> span. I can check its work."

*Hover the evidence panel as you say "check its work". That gesture is the trust argument.*

### 0:30–0:45 — Ask it anything (38 words)

*Screen: Ask console, empty, cursor blinking.*

Type live — **do not paste**:

> `Which freezers drifted above -15°C in the last 6 hours?`

> "No query language. But not a chatbot guessing either — Claude fills in a query plan,
> Xano validates every field against an allowlist, then runs it as a real database query.
> The model plans. Xano executes."

*Expand "How this was answered" on the last three words. One second on the JSON is enough.*

### 0:45–0:57 — Close the loop (30 words)

*Screen: back on the incident, remediation checklist visible.*

> "And I fix it from here — one command to every affected device. Diagnosis to remediation
> without leaving the page."

*Click the command button. Let the state change land on camera.*

### 0:57–1:00 — The line (16 words)

*Screen: hold on Overview, incident now acknowledged.*

> "Datadog charges you for asking questions and still makes you answer them. Nerve hands
> you the answer."

---

## Total: ~164 words

Slightly over the 150 budget, which is correct — you will speak faster than you think on
camera. If you run long, cut the second sentence of 0:30–0:45 ("But not a chatbot…"),
**not** the evidence beat at 0:08–0:30. The evidence panel is the only thing in this video
a competitor cannot also claim.

---

## What to cut if you have less to show

| If this isn't ready | Drop | Replace with |
|---|---|---|
| No AI key (fallback only) | 0:08–0:30 in full | The rule composer: type a rule in English, show it restated back |
| No incident correlated | The whole incident arc | Alerts page + `Run triage now`, showing alerts collapse into one incident live |
| Tasks not running (Free plan) | "correlation task sweeps every 2 min" | Hit **Incidents → Run triage now** manually; it does the same work on demand |

---

## Recording notes

- **One take per beat, not one take total.** Record five clips and cut them together; a
  single continuous take will have dead air while pages load.
- **Pre-warm every screen.** Visit each one before recording so nothing is loading on
  camera. `/incidents/{id}/analyze` takes 30–90s against a real model — never trigger it
  live in a 60-second video; generate it beforehand and show the stored result.
- **Kill the polling stall.** The UI polls every 20–60s. On Free that alone can trip the
  rate limit mid-take.
- **Say the numbers.** "Eighty-two percent", "six alerts", "one incident" — specifics are
  what make a judge believe there's real data underneath.
- **Do not show the login screen.** It costs eight seconds and proves nothing. Start
  signed in.
