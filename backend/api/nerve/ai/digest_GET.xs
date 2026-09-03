// The operator briefing. A fleet dashboard tells you what is red; a digest tells you what CHANGED, which is the only thing worth reading before your first coffee. Normally written by the daily cron; refresh=true regenerates it live for the demo.
query "ai/digest" verb=GET {
  api_group = "Nerve"
  auth = "user"
  description = "Returns the newest fleet_digest insight. With refresh=true it gathers 24h fleet statistics - alerts by severity, incidents opened and resolved, the worst-scoring devices, currently offline devices and ingest volume - and asks Claude for a short operator briefing, degrading to a deterministic briefing built from the same numbers when no API key is configured."

  input {
    // Regenerate rather than read. Left false by default so opening the overview screen does not spend an inference on every page load.
    bool refresh?=false

    // Window the statistics cover. 24 hours matches the daily cadence of the task that normally writes this.
    int hours?=24
  }

  stack {
    // Latency reported to the UI; fn_claude logs its own separately on the insight row.
    var $started_ms {
      value = "now"|to_ms
    }

    // The token has to resolve to a live user even for a read.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user not found."
    }

    // Window clamp: under an hour there is nothing to trend, over a week it stops being a daily briefing.
    var $hours {
      value = $input.hours
    }

    conditional {
      if ($hours < 1) {
        var.update $hours {
          value = 1
        }
      }
      elseif ($hours > 168) {
        var.update $hours {
          value = 168
        }
      }
    }

    // add_secs_to_timestamp takes an int, so the negation is computed first rather than inline in the filter argument.
    var $window_negative {
      value = 0 - ($hours * 3600)
    }

    // Floor of the reporting window; every count below is measured against it.
    var $cutoff {
      value = "now"|add_secs_to_timestamp:$window_negative
    }

    // Newest digest, read whether or not a refresh was asked for, so a failed refresh can still fall back to the last good briefing.
    db.query ai_insight {
      where = $db.ai_insight.kind == "fleet_digest"
      sort = {ai_insight.created_at: "desc"}
      return = {type: "single"}
    } as $existing

    // Statistics are gathered only on the refresh path - reading the digest must stay a single cheap query.
    var $stats {
      value = null
    }

    // The briefing text: either the model's, or the deterministic one built from the same numbers.
    var $digest_text {
      value = null
    }

    // Title stored on the insight row and shown above the briefing.
    var $digest_title {
      value = null
    }

    // Populated on refresh so the response can report provenance.
    var $model {
      value = null
    }

    // True unless a model actually wrote the briefing. Callers of fn_claude must branch on this.
    var $fallback_used {
      value = true
    }

    // Distinguishes "you read the stored digest" from "a new one was generated".
    var $refreshed {
      value = false
    }

    // Set on refresh so the UI can link straight to the row this briefing was written to.
    var $insight_id {
      value = null
    }

    conditional {
      if ($input.refresh == true) {
        // Alerts in the window, fetched as rows rather than counts because the severity split needs the rows anyway and one query beats three.
        db.query alert {
          where = $db.alert.fired_at >= $cutoff
          sort = {alert.fired_at: "desc"}
          return = {type: "list", paging: {page: 1, per_page: 1000}}
        } as $alert_page

        var $alerts {
          value = $alert_page.items|safe_array
        }

        // Severity split. Counted in one pass; the three counters are what the briefing leads with.
        var $critical_count {
          value = 0
        }

        // Middle tier - the bulk of a normal day.
        var $warning_count {
          value = 0
        }

        // Informational alerts do not degrade a device's status but they do shave its score.
        var $info_count {
          value = 0
        }

        // Still firing at the moment the digest was taken, which is the number that actually needs attention today.
        var $still_firing {
          value = 0
        }

        // Distinct devices behind the window's alerts - the difference between one sick machine and a sick site.
        var $alerting_device_ids {
          value = []
        }

        // Metric keys involved, deduped below, so the briefing can say WHAT is going wrong rather than only how much.
        var $alerting_metrics {
          value = []
        }

        foreach ($alerts) {
          each as $alert {
            conditional {
              if ($alert.severity == "critical") {
                math.add $critical_count {
                  value = 1
                }
              }
              elseif ($alert.severity == "warning") {
                math.add $warning_count {
                  value = 1
                }
              }
              else {
                math.add $info_count {
                  value = 1
                }
              }
            }

            conditional {
              if ($alert.state == "firing") {
                math.add $still_firing {
                  value = 1
                }
              }
            }

            array.push $alerting_device_ids {
              value = $alert.device_id
            }

            array.push $alerting_metrics {
              value = ($alert.metric_key|first_notempty:"unknown")
            }
          }
        }

        // Incidents opened in the window - the correlated view of the alert counts above.
        db.query incident {
          where = $db.incident.opened_at >= $cutoff
          return = {type: "count"}
        } as $incidents_opened

        // Closed in the window. Opened-minus-resolved is the trend line an operator cares about.
        db.query incident {
          where = $db.incident.resolved_at >= $cutoff
          return = {type: "count"}
        } as $incidents_resolved

        // Still open right now, regardless of when they opened - a three-day-old open incident is today's problem too.
        db.query incident {
          where = $db.incident.state == "open" || $db.incident.state == "investigating"
          sort = {incident.severity: "asc"}
          return = {type: "list", paging: {page: 1, per_page: 10}}
        } as $open_incident_page

        var $open_incidents {
          value = $open_incident_page.items|safe_array
        }

        // Worst-scoring devices. health_score ascending is the fleet grid's default sort for the same reason.
        db.query device {
          sort = {device.health_score: "asc"}
          return = {type: "list", paging: {page: 1, per_page: 8}}
        } as $worst_page

        var $worst_devices {
          value = $worst_page.items|safe_array
        }

        // Currently offline. This is a snapshot rather than an event count: Nerve records offline as a status transition on the device, so "offline events in the window" is not directly countable and pretending otherwise would be a fabricated number.
        db.query device {
          where = $db.device.status == "offline"
          return = {type: "count"}
        } as $offline_now

        // Fleet size, so every count above can be read as a proportion rather than an absolute.
        db.query device {
          return = {type: "count"}
        } as $device_total

        // Ingest volume: the firehose the product exists to tame. A collapse here is the story, not the alerts.
        db.query telemetry {
          where = $db.telemetry.ts >= $cutoff
          return = {type: "count"}
        } as $readings

        // Rendered worst-device lines, so the model reasons over names and numbers rather than over row objects.
        var $worst_lines {
          value = []
        }

        foreach ($worst_devices) {
          each as $device {
            array.push $worst_lines {
              value = ($device.name|to_text) ~ " [" ~ ($device.serial|to_text) ~ "] health=" ~ (($device.health_score|first_notnull:0)|to_text) ~ " status=" ~ ($device.status|to_text)
            }
          }
        }

        // Rendered open-incident lines, including whether the hypothesis attached to each one came from a model or from the deterministic fallback.
        var $incident_lines {
          value = []
        }

        foreach ($open_incidents) {
          each as $incident {
            array.push $incident_lines {
              value = "#" ~ ($incident.id|to_text) ~ " " ~ ($incident.title|to_text) ~ " (" ~ ($incident.severity|to_text) ~ ", " ~ ($incident.state|to_text) ~ ", " ~ (($incident.device_count|first_notnull:0)|to_text) ~ " device(s), " ~ (($incident.alert_count|first_notnull:0)|to_text) ~ " alert(s))"
            }
          }
        }

        // Deduped so "12 alerts across 3 devices" is distinguishable from "12 alerts on one device".
        var $distinct_alerting_devices {
          value = ($alerting_device_ids|unique)|count
        }

        // The metrics actually involved, deduped.
        var $distinct_metrics {
          value = $alerting_metrics|unique
        }

        // Every number the briefing is allowed to mention, in one object. It is stored on the insight's payload so the claim and its inputs can always be compared.
        var.update $stats {
          value = {
            window_hours            : $hours
            window_from             : $cutoff|format_timestamp:"Y-m-d H:i:s":"UTC"
            window_to               : "now"|format_timestamp:"Y-m-d H:i:s":"UTC"
            alerts_total            : $alerts|count
            alerts_critical         : $critical_count
            alerts_warning          : $warning_count
            alerts_info             : $info_count
            alerts_still_firing     : $still_firing
            alerting_devices        : $distinct_alerting_devices
            alerting_metrics        : $distinct_metrics
            incidents_opened        : $incidents_opened
            incidents_resolved      : $incidents_resolved
            incidents_open_now      : $open_incidents|count
            open_incident_summaries : $incident_lines
            devices_total           : $device_total
            devices_offline_now     : $offline_now
            worst_devices           : $worst_lines
            readings_ingested       : $readings
          }
        }

        // DETERMINISTIC BRIEFING, written first. It is what ships when there is no key or when Anthropic rate-limits, and it is built from exactly the numbers above - no adjectives the data does not support.
        var $net_incidents {
          value = $incidents_opened - $incidents_resolved
        }

        // Assembled in two halves purely to keep the lines readable.
        var $deterministic_head {
          value = "Last " ~ ($hours|to_text) ~ "h: " ~ (($alerts|count)|to_text) ~ " alert(s) fired (" ~ ($critical_count|to_text) ~ " critical, " ~ ($warning_count|to_text) ~ " warning, " ~ ($info_count|to_text) ~ " info) across " ~ ($distinct_alerting_devices|to_text) ~ " of " ~ ($device_total|to_text) ~ " device(s); " ~ ($still_firing|to_text) ~ " still firing."
        }

        // Second half: incidents, offline devices and ingest.
        var $deterministic_tail {
          value = " Incidents: " ~ ($incidents_opened|to_text) ~ " opened, " ~ ($incidents_resolved|to_text) ~ " resolved, " ~ (($open_incidents|count)|to_text) ~ " open now (net " ~ ($net_incidents|to_text) ~ "). " ~ ($offline_now|to_text) ~ " device(s) offline right now. " ~ ($readings|to_text) ~ " reading(s) ingested. Worst health: " ~ (($worst_lines|slice:0:3)|join:"; ") ~ ". Metrics involved: " ~ (($distinct_metrics|join:", ")|first_notempty:"none") ~ "."
        }

        var.update $digest_text {
          value = $deterministic_head ~ $deterministic_tail
        }

        // Title carries the headline number, because a digest list is scanned before it is read.
        var.update $digest_title {
          value = "Fleet digest, last " ~ ($hours|to_text) ~ "h: " ~ ($critical_count|to_text) ~ " critical, " ~ (($open_incidents|count)|to_text) ~ " open incident(s)"
        }

        // Plain text, deliberately: a briefing is read, not parsed, and asking for JSON here would buy structure nobody consumes.
        var $digest_system {
          value = "You are Nerve's duty operations lead writing the shift briefing for a device-fleet operator who has just sat down. You are given a block of statistics covering a fixed recent window, a list of the worst-scoring devices, and a list of the open incidents. Write three short paragraphs of plain text - no markdown, no bullet points, no headings, no code fence, no preamble. Paragraph one: what changed in the window, stated with the actual numbers. Paragraph two: what needs attention today, named specifically - device names, serials, incident numbers, metric keys. Paragraph three: what is trending in the wrong direction, or an explicit statement that nothing is, which is a perfectly good briefing. GROUNDING RULES, which override any instinct to sound useful: every number, name, serial, incident number and metric key you write must appear in the supplied statistics. Never invent a device, a site, a trend or a cause. You have counts and a snapshot, not a time series, so you cannot compare this window to a previous one - do not claim an increase or a decrease unless the statistics contain both sides of the comparison (opened versus resolved incidents is the one comparison you do have). Do not diagnose a root cause; the incident records already carry hypotheses and yours would be a second, weaker one. Where the data is thin, say so and lower your confidence rather than filling the gap - 'nine alerts on one device, cause not yet established' is a better briefing than a guess. If the window is quiet, say it is quiet and keep it to two sentences."
        }

        // The prompt carries only the gathered statistics: no derived claims for the model to inherit.
        var $digest_prompt {
          value = "WINDOW: last " ~ ($hours|to_text) ~ " hours, " ~ (($cutoff|format_timestamp:"Y-m-d H:i:s":"UTC")) ~ " to " ~ (("now"|format_timestamp:"Y-m-d H:i:s":"UTC")) ~ " UTC || STATISTICS (JSON): " ~ ($stats|json_encode)
        }

        function.run "Nerve/fn_claude" {
          input = {
            system     : $digest_system
            user_prompt: $digest_prompt
            max_tokens : 900
            kind       : "fleet_digest"
            title      : $digest_title
            expect_json: false
          }
        } as $ai

        // Stamped either way, so the response and the insight row agree on which model was attempted.
        var.update $model {
          value = $ai.model
        }

        var.update $insight_id {
          value = $ai.insight_id
        }

        var.update $refreshed {
          value = true
        }

        // The model's text is used only when it actually arrived; a silent empty text is a valid fn_claude response and would otherwise overwrite a perfectly good deterministic briefing with nothing.
        conditional {
          if (($ai.fallback_used == false) && (($ai.text|is_empty) == false)) {
            var.update $digest_text {
              value = $ai.text
            }

            var.update $fallback_used {
              value = false
            }
          }
        }

        // fn_claude has already inserted the insight row with whatever text the API returned - which is "" on the fallback path. Rewriting the row here is what guarantees the stored digest is never empty, and it attaches the statistics the briefing was derived from so the claim and its inputs travel together.
        db.edit ai_insight {
          field_name = "id"
          field_value = $ai.insight_id
          data = {
            title        : $digest_title
            body         : $digest_text
            payload      : $stats
            fallback_used: $fallback_used
          }
        } as $written
      }
      else {
        // Read path: serve the stored briefing. A workspace whose digest task has never run has none, which is reported as a null digest rather than as an error.
        var.update $digest_text {
          value = $existing|get:"body"
        }

        var.update $digest_title {
          value = $existing|get:"title"
        }

        var.update $model {
          value = $existing|get:"model"
        }

        var.update $fallback_used {
          value = ($existing|get:"fallback_used"|first_notnull:true)
        }

        var.update $stats {
          value = $existing|get:"payload"
        }

        var.update $insight_id {
          value = $existing|get:"id"
        }
      }
    }

    // True when there is genuinely nothing to show, which the UI renders as a "run the digest" prompt rather than as an empty card.
    var $empty {
      value = $digest_text|is_empty
    }

    // When the digest was actually written, as opposed to when it was read.
    var $generated_at {
      value = null
    }

    conditional {
      if ($refreshed) {
        var.update $generated_at {
          value = "now"
        }
      }
      elseif ($existing != null) {
        var.update $generated_at {
          value = $existing|get:"created_at"
        }
      }
    }

    var $latency_ms {
      value = ("now"|to_ms) - $started_ms
    }
  }

  response = {
    success      : true
    empty        : $empty
    refreshed    : $refreshed
    title        : $digest_title
    digest       : $digest_text
    stats        : $stats
    generated_at : $generated_at
    model        : $model
    fallback_used: $fallback_used
    insight_id   : $insight_id
    window_hours : $hours
    latency_ms   : $latency_ms
  }
  tags = ["nerve"]
  guid = "Ae8HxVy9eXSDlu9ldysGa6AaoJ8"
}
