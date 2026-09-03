// Regenerate the root-cause analysis on demand. This is the endpoint the whole product argues for: the tool does not show you a red graph and stop, it hands you a hypothesis, the evidence it used, and a confidence it is willing to be judged on.
query "incidents/{incident_id}/analyze" verb=POST {
  api_group = "Nerve"
  auth = "user"
  description = "Operator+ re-triage of one incident. Gathers every member alert, the affected devices with their types and sites, and a recent metric_rollup trend per (device, metric) pair, then asks Claude for strict-JSON root cause, remediation, evidence and suggested commands. Writes the result to the incident's ai_* fields and degrades to a deterministic analysis rather than failing."

  input {
    // Path parameter.
    int incident_id {
      table = "incident"
    }

    // How many 5-minute rollup buckets to feed the model per (device, metric) pair. Shape beats a single number, but the prompt still has to fit.
    int trend_buckets?=12 filters=min:1|max:48

    // Set false to rebuild the deterministic analysis without spending an inference - used by the seeder and by anyone testing the fallback path.
    bool call_ai?=true
  }

  stack {
    // Role from the database rather than from the token, so a demotion takes effect immediately.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Re-analysis overwrites the incident's ai_* fields and spends a token budget, so it is not a viewer action.
    precondition (($user.role == "operator") || ($user.role == "admin")) {
      error_type = "accessdenied"
      error = "Operator role required to run an analysis."
    }

    db.get incident {
      field_name = "id"
      field_value = $input.incident_id
    } as $incident

    precondition ($incident != null) {
      error_type = "notfound"
      error = "Incident not found."
    }

    // Site name, because "site 4" is not a fact a language model can reason about.
    db.get site {
      field_name = "id"
      field_value = $incident.site_id
      output = ["id", "code", "name", "region", "timezone"]
    } as $site

    // Resolved as a variable so the prompt and the fallback text share one label.
    var $site_label {
      value = $site|get:"name"|first_notempty:"unknown site"
    }

    // Every member alert, oldest first: onset order is the single most diagnostic thing about a cascade.
    db.query alert {
      where = $db.alert.incident_id == $input.incident_id
      sort = {alert.fired_at: "asc"}
      return = {type: "list"}
    } as $alerts

    // Drives both the empty-evidence branch and the prompt's own framing.
    var $alert_count {
      value = $alerts|count
    }

    // Observed-vs-threshold lines. The model reasons over numbers here, not over adjectives we chose for it.
    var $evidence_lines {
      value = []
    }

    // One line per distinct device, so the model can tell "eight freezers" from "one freezer eight times".
    var $device_lines {
      value = []
    }

    // Dedupe ledger for the device list.
    var $seen_device_ids {
      value = []
    }

    // "<device_id>::<metric_key>" strings; uniqued after the loop into the set of trends worth pulling.
    var $pair_keys {
      value = []
    }

    // Epoch-ms fired times, for the incident's own time span.
    var $fired_ms {
      value = []
    }

    // Metric names involved, deduped for the prompt and the fallback summary.
    var $metric_keys {
      value = []
    }

    // Severity tallies, so the prompt states the mix rather than making the model count.
    var $critical_count {
      value = 0
    }

    foreach ($alerts) {
      each as $alert {
        db.get device {
          field_name = "id"
          field_value = $alert.device_id
        } as $device

        // Category is what distinguishes a gateway from the devices behind it, which is the difference between one cause and many.
        db.get device_type {
          field_name = "id"
          field_value = $device.device_type_id
        } as $device_type

        array.push $evidence_lines {
          value = ($device|get:"name"|first_notempty:"device") ~ " (" ~ ($device_type|get:"name"|first_notempty:"unknown type") ~ ") " ~ ($alert.metric_key|first_notempty:"metric") ~ "=" ~ (($alert.observed_value|first_notnull:0)|to_text) ~ " vs threshold " ~ (($alert.threshold|first_notnull:0)|to_text) ~ ", z=" ~ (($alert.z_score|first_notnull:0)|to_text) ~ ", severity=" ~ ($alert.severity|first_notempty:"warning") ~ ", fired " ~ ($alert.fired_at|format_timestamp:"Y-m-d H:i:s":"UTC") ~ " UTC"
        }

        array.push $fired_ms {
          value = $alert.fired_at|to_ms
        }

        array.push $metric_keys {
          value = $alert.metric_key
        }

        conditional {
          if ($alert.severity == "critical") {
            math.add $critical_count {
              value = 1
            }
          }
        }

        // First sighting of a device contributes its topology: the uplink is the shared-cause candidate the correlation key was built from.
        conditional {
          if (($seen_device_ids|in:$alert.device_id) == false) {
            array.push $seen_device_ids {
              value = $alert.device_id
            }

            array.push $device_lines {
              value = ($device|get:"name"|first_notempty:"device") ~ " [serial " ~ ($device|get:"serial"|first_notempty:"unknown") ~ "] type=" ~ ($device_type|get:"name"|first_notempty:"unknown") ~ "/" ~ ($device_type|get:"category"|first_notempty:"other") ~ ", site=" ~ $site_label ~ ", location=" ~ ($device|get:"location_label"|first_notempty:"unspecified") ~ ", status=" ~ ($device|get:"status"|first_notempty:"unknown") ~ ", health=" ~ (($device|get:"health_score"|first_notnull:0)|to_text) ~ ", firmware=" ~ ($device|get:"firmware_version"|first_notempty:"unknown") ~ ", uplink_device_id=" ~ (($device|get:"uplink_device_id"|first_notnull:0)|to_text)
            }
          }
        }

        // The pair is what a trend is keyed on. Recorded even when duplicated; uniqued below so one metric on one device is pulled once.
        conditional {
          if (!($alert.metric_key|is_empty)) {
            array.push $pair_keys {
              value = ($alert.device_id|to_text) ~ "::" ~ $alert.metric_key
            }
          }
        }
      }
    }

    // Distinct devices - the number an operator reads as "how big is this".
    var $device_count {
      value = ($seen_device_ids|unique)|count
    }

    // Deduped metric list for the title-ish parts of the prompt.
    var $unique_metrics {
      value = ($metric_keys|filter_empty)|unique
    }

    // Prose form of the same.
    var $metric_label {
      value = ($unique_metrics|join:", ")|first_notempty:"multiple metrics"
    }

    // One trend pull per distinct (device, metric).
    var $trend_pairs {
      value = $pair_keys|unique
    }

    // Trend lines: the shape of each metric over the recent buckets, so the model reasons over a curve rather than a single reading.
    var $trend_lines {
      value = []
    }

    foreach ($trend_pairs) {
      each as $pair_key {
        // Split back out rather than carrying a parallel array: one string keeps the unique-ing honest.
        var $pair_parts {
          value = $pair_key|split:"::"
        }

        // Left half is the device id; it went in as text so it has to come back as an int for the query.
        var $trend_device_id {
          value = ($pair_parts|first)|to_int
        }

        // Right half is the metric key.
        var $trend_metric {
          value = $pair_parts|last
        }

        db.get device {
          field_name = "id"
          field_value = $trend_device_id
          output = ["id", "name", "serial"]
        } as $trend_device

        // Newest buckets first so the page limit keeps the recent ones; reversed below for reading order.
        db.query metric_rollup {
          where = $db.metric_rollup.device_id == $trend_device_id && $db.metric_rollup.metric_key == $trend_metric
          sort = {metric_rollup.bucket_ts: "desc"}
          return = {
            type  : "list"
            paging: {page: 1, per_page: $input.trend_buckets}
          }
        } as $recent_buckets

        // Oldest to newest, which is the only order a trend reads correctly in. safe_array|filter_empty rather than a bare read, because safe_array turns a missing items key into [null] and one null bucket would poison the whole series.
        var $ordered_buckets {
          value = (($recent_buckets.items|safe_array)|filter_empty)|reverse
        }

        // Formatted averages; two decimals because raw sensor floats add length without adding signal.
        var $avg_series {
          value = []
        }

        // Kept separately so the min/max/delta line does not depend on re-parsing the formatted text.
        var $numeric_series {
          value = []
        }

        foreach ($ordered_buckets) {
          each as $bucket {
            array.push $avg_series {
              value = (($bucket.avg_value|first_notnull:0)|round:2)|to_text
            }

            array.push $numeric_series {
              value = ($bucket.avg_value|first_notnull:0)|to_decimal
            }
          }
        }

        // A pair with no rollups yet is stated as such rather than silently omitted - absent history is itself evidence.
        conditional {
          if (($numeric_series|count) > 0) {
            // Direction of travel, computed here so the model is not asked to subtract.
            var $series_delta {
              value = ($numeric_series|last) - ($numeric_series|first)
            }

            array.push $trend_lines {
              value = ($trend_device|get:"name"|first_notempty:"device") ~ " " ~ $trend_metric ~ ": " ~ (($numeric_series|count)|to_text) ~ " x " ~ ((($ordered_buckets|first)|get:"bucket_seconds"|first_notnull:300)|to_text) ~ "s buckets oldest-to-newest [" ~ ($avg_series|join:", ") ~ "], min=" ~ (((($numeric_series|sort)|first)|round:2)|to_text) ~ ", max=" ~ (((($numeric_series|sort)|last)|round:2)|to_text) ~ ", net change=" ~ (($series_delta|round:2)|to_text)
            }
          }
          else {
            array.push $trend_lines {
              value = ($trend_device|get:"name"|first_notempty:"device") ~ " " ~ $trend_metric ~ ": no rollup history available yet"
            }
          }
        }
      }
    }

    // Time span of the incident, guarded because an incident with no member alerts has no span at all.
    var $span_start {
      value = "unknown"
    }

    // Upper bound of the same window.
    var $span_end {
      value = "unknown"
    }

    conditional {
      if ($alert_count > 0) {
        var.update $span_start {
          value = (($fired_ms|sort)|first)|format_timestamp:"Y-m-d H:i:s":"UTC"
        }

        var.update $span_end {
          value = (($fired_ms|sort)|last)|format_timestamp:"Y-m-d H:i:s":"UTC"
        }
      }
    }

    // Duration in minutes, which is how an operator states impact.
    var $duration_minutes {
      value = 0
    }

    conditional {
      if ($alert_count > 0) {
        var.update $duration_minutes {
          value = (((("now"|to_ms) - (($fired_ms|sort)|first)) / 60000))|round:1
        }
      }
    }

    // DETERMINISTIC ANALYSIS FIRST. This is what ships when there is no API key, when Anthropic 429s, or when the reply will not parse - the demo must never dead-end on a red graph with no words next to it.
    var $summary {
      value = ($alert_count|to_text) ~ " alert(s) across " ~ ($device_count|to_text) ~ " device(s) at " ~ $site_label ~ " on " ~ $metric_label ~ ", first firing " ~ $span_start ~ " UTC and most recently " ~ $span_end ~ " UTC."
    }

    // The shared attribute the correlation key was built from is a real, if shallow, cause candidate - and it is the one we can defend from data alone.
    var $root_cause {
      value = "Rule-derived: these alerts share the correlation key " ~ ($incident.correlation_key|first_notempty:"none") ~ ", so a single shared site, uplink or device class is more likely than " ~ ($device_count|to_text) ~ " independent faults. No model analysis was applied."
    }

    // Deliberately low. A grouping heuristic is not a diagnosis, and saying so is worth more than a confident guess.
    var $confidence {
      value = 0.3
    }

    // Generic but genuinely actionable, so the remediation panel is never empty.
    var $remediation {
      value = ["Confirm whether the affected devices share a power feed, network uplink or refrigeration circuit.", "Compare each device's current reading against its own EWMA baseline rather than against a fleet threshold.", "Check the most recently changed firmware version across the affected devices.", "Resolve the member alerts together once one shared cause is confirmed."]
    }

    // The evidence the deterministic path reasoned from is exactly the observation lines.
    var $evidence {
      value = $evidence_lines
    }

    // Commands the UI can prefill into POST /incidents/{id}/commands. Empty on the fallback path because guessing a remediation command is worse than offering none.
    var $suggested_commands {
      value = []
    }

    // Assume fallback until a parsed model reply proves otherwise, matching fn_claude's own convention.
    var $fallback_used {
      value = true
    }

    // Reported so the UI can be honest about provenance instead of implying every word came from a model.
    var $parse_failed {
      value = false
    }

    // Why the model call failed, when it failed. Null on the success path. Without this a
    // missing API key and a rate limit are indistinguishable from the outside: both return
    // 200 with a deterministic answer.
    var $ai_error {
      value = null
    }

    // Stamped either way, so the incident row and its ai_insight row always agree on which model was attempted.
    var $model {
      value = null
    }

    // Surfaced in the response so the UI can show the real cost of the button the operator just pressed.
    var $latency_ms {
      value = 0
    }

    // Null unless an inference actually happened.
    var $insight_id {
      value = null
    }

    // With no member alerts there is nothing to reason over, and spending a request to be told so is waste.
    conditional {
      if ($alert_count == 0) {
        var.update $summary {
          value = "This incident has no member alerts, so there is no telemetry to analyse."
        }

        var.update $root_cause {
          value = "Insufficient evidence: the incident carries no alerts, so no cause can be inferred."
        }

        var.update $confidence {
          value = 0.05
        }

        var.update $remediation {
          value = ["Verify the correlation sweep is attaching alerts to this incident.", "Close the incident if its alerts were resolved and detached."]
        }
      }
    }

    // The inference itself. Gated on both the caller's wish and on there being something to reason about.
    conditional {
      if (($input.call_ai == true) && ($alert_count > 0)) {
        // STRICT JSON is demanded because the reply is written into typed columns, not rendered as prose. The anti-invention clauses are the point: a confident wrong cause is worse than an honest low score.
        var $system_prompt {
          value = "You are a senior site-reliability engineer triaging an incident on an industrial IoT fleet. Reply with STRICT JSON only: no prose, no explanation, no markdown code fence. Use exactly these keys: summary (one or two sentences an on-call operator can read at a glance), root_cause (one or two sentences naming the single most likely cause), confidence (a number between 0 and 1), remediation (an array of short imperative steps, most valuable first), evidence (an array of strings, each quoting an observation from the supplied telemetry that you actually relied on), suggested_commands (an array of objects shaped {command, device_hint, reason} where command is one of restart, firmware_update, calibrate, set_config, return_to_dock, enter_maintenance, clear_fault). Reason ONLY from the telemetry supplied in the user message. Do not invent readings, device names, thresholds or history that are not present. Prefer one shared cause over many independent faults when the shape of the data supports it, and prefer a specific mechanism over a category. If the evidence is too thin to identify a cause, say so plainly in root_cause and return a confidence below 0.3 rather than inventing a cause. Return an empty suggested_commands array if no command is clearly justified."
        }

        // The prompt carries facts already in the database and nothing else: no derived claims for the model to inherit as if they were observations.
        var $user_prompt {
          value = "INCIDENT\nTitle: " ~ $incident.title ~ "\nCurrent severity: " ~ ($incident.severity|first_notempty:"warning") ~ "\nCurrent state: " ~ ($incident.state|first_notempty:"open") ~ "\nSite: " ~ $site_label ~ " (region " ~ ($site|get:"region"|first_notempty:"unknown") ~ ")\nCorrelation key: " ~ ($incident.correlation_key|first_notempty:"none") ~ "\nWhy these alerts were grouped: " ~ ($incident.correlation_reason|first_notempty:"not recorded") ~ "\nAlerts in incident: " ~ ($alert_count|to_text) ~ " (" ~ ($critical_count|to_text) ~ " critical)\nDistinct devices affected: " ~ ($device_count|to_text) ~ "\nMetrics involved: " ~ $metric_label ~ "\nFirst alert fired (UTC): " ~ $span_start ~ "\nMost recent alert fired (UTC): " ~ $span_end ~ "\nMinutes since onset: " ~ ($duration_minutes|to_text) ~ "\n\nAFFECTED DEVICES\n- " ~ ($device_lines|join:"\n- ") ~ "\n\nALERT OBSERVATIONS (device, type, metric, observed vs threshold, z-score, severity, fire time)\n- " ~ ($evidence_lines|join:"\n- ") ~ "\n\nRECENT METRIC TRENDS (5-minute rollup averages, oldest to newest)\n- " ~ ($trend_lines|join:"\n- ")
        }

        function.run "Nerve/fn_claude" {
          input = {
            system     : $system_prompt
            user_prompt: $user_prompt
            max_tokens : 2000
            kind       : "incident_triage"
            incident_id: $input.incident_id
            title      : "Re-analysis: " ~ $incident.title
            expect_json: true
          }
        } as $ai

        // Provenance is recorded whatever happened, including on the fallback path.
        var.update $model {
          value = $ai.model
        }

        var.update $latency_ms {
          value = $ai.latency_ms
        }

        var.update $insight_id {
          value = $ai.insight_id
        }

        var.update $parse_failed {
          value = $ai.parse_failed
        }

        var.update $ai_error {
          value = $ai.error
        }

        // The model's answer replaces the deterministic one only when it actually parsed. Anything else keeps the defensible text above.
        conditional {
          if (($ai.fallback_used == false) && ($ai.json != null)) {
            var.update $summary {
              value = $ai.json|get:"summary"|first_notnull:$summary
            }

            var.update $root_cause {
              value = $ai.json|get:"root_cause"|first_notnull:$root_cause
            }

            var.update $confidence {
              value = ($ai.json|get:"confidence"|first_notnull:0.3)|to_decimal
            }

            var.update $remediation {
              value = ($ai.json|get:"remediation"|first_notnull:$remediation)|safe_array
            }

            var.update $evidence {
              value = ($ai.json|get:"evidence"|first_notnull:$evidence_lines)|safe_array
            }

            var.update $suggested_commands {
              value = ($ai.json|get:"suggested_commands"|first_notnull:$suggested_commands)|safe_array
            }

            var.update $fallback_used {
              value = false
            }
          }
        }
      }
    }

    // Persisted so the list view, the detail view and a page reload all show the analysis the operator just paid for.
    db.edit incident {
      field_name = "id"
      field_value = $input.incident_id
      data = {
        ai_summary      : $summary
        ai_root_cause   : $root_cause
        ai_confidence   : $confidence
        ai_remediation  : $remediation
        ai_evidence     : $evidence
        ai_model        : $model
        ai_generated_at : "now"
        ai_fallback_used: $fallback_used
      }
    } as $updated

    // Re-analysis overwrites a previous hypothesis, so who triggered it is worth keeping.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "incident.analyze"
        entity_type: "incident"
        entity_id  : $input.incident_id
        detail     : {
          alerts_considered: $alert_count
          devices_considered: $device_count
          trends_considered: ($trend_lines|count)
          fallback_used    : $fallback_used
          parse_failed     : $parse_failed
          model            : $model
          latency_ms       : $latency_ms
          insight_id       : $insight_id
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    incident_id: $input.incident_id
    analysis: {
      summary           : $summary
      root_cause        : $root_cause
      confidence        : $confidence
      remediation       : $remediation
      evidence          : $evidence
      suggested_commands: $suggested_commands
      generated_at      : $updated.ai_generated_at
    }
    fallback_used: $fallback_used
    parse_failed : $parse_failed
    ai_error     : $ai_error
    model        : $model
    latency_ms   : $latency_ms
    insight_id   : $insight_id
    evidence_considered: {
      alerts  : $alert_count
      devices : $device_count
      trends  : ($trend_lines|count)
      span_start: $span_start
      span_end  : $span_end
    }
  }
  tags = ["nerve"]
  guid = "vXR7YiCpCu_wqA_pfbWRrJZpDK4"
}
