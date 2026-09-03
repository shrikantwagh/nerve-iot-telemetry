// Draft the writeup nobody wants to write. The incident already holds its own timeline - who fired when, which commands were tried, what the hypothesis was - so the postmortem is a rendering job, not a research job.
query "incidents/{incident_id}/postmortem" verb=POST {
  api_group = "Nerve"
  auth = "user"
  description = "Operator+ generation of a markdown postmortem for one incident, drafted from its alert timeline, affected devices, issued commands and existing root-cause analysis. Stored on incident.ai_postmortem, with a deterministic markdown draft when the model is unavailable."

  input {
    // Path parameter.
    int incident_id {
      table = "incident"
    }

    // Set false to regenerate the deterministic draft without spending an inference.
    bool call_ai?=true
  }

  stack {
    // Role from the database, not from the token.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Writing to ai_postmortem overwrites the previous draft and spends tokens, so it is not a viewer action.
    precondition (($user.role == "operator") || ($user.role == "admin")) {
      error_type = "accessdenied"
      error = "Operator role required to draft a postmortem."
    }

    db.get incident {
      field_name = "id"
      field_value = $input.incident_id
    } as $incident

    precondition ($incident != null) {
      error_type = "notfound"
      error = "Incident not found."
    }

    db.get site {
      field_name = "id"
      field_value = $incident.site_id
      output = ["id", "code", "name", "region", "timezone"]
    } as $site

    // Shared by the prompt and by the deterministic draft, so the two never disagree on the location.
    var $site_label {
      value = $site|get:"name":"unknown site"
    }

    // Assignee is named in the writeup because a postmortem with no owner is a document nobody follows up.
    db.get user {
      field_name = "id"
      field_value = $incident.assigned_to
      output = ["id", "name"]
    } as $assignee

    // Chronological, because a postmortem timeline is the one section where order is the content.
    db.query alert {
      where = $db.alert.incident_id == $input.incident_id
      sort = {alert.fired_at: "asc"}
      return = {type: "list"}
    } as $alerts

    // Drives the impact section and the "nothing to write about" branch.
    var $alert_count {
      value = $alerts|count
    }

    // One line per event, already in reading order.
    var $timeline_lines {
      value = []
    }

    // Distinct affected devices, named rather than counted, because "eight freezers" is the impact statement.
    var $device_lines {
      value = []
    }

    // Dedupe ledger for the device list.
    var $seen_device_ids {
      value = []
    }

    // Epoch-ms fire times, for the incident's duration.
    var $fired_ms {
      value = []
    }

    // Metric names involved.
    var $metric_keys {
      value = []
    }

    // Unresolved members are the difference between "incident over" and "incident quiet".
    var $still_firing {
      value = 0
    }

    foreach ($alerts) {
      each as $alert {
        db.get device {
          field_name = "id"
          field_value = $alert.device_id
        } as $device

        db.get device_type {
          field_name = "id"
          field_value = $device.device_type_id
        } as $device_type

        array.push $fired_ms {
          value = $alert.fired_at|to_ms
        }

        array.push $metric_keys {
          value = $alert.metric_key
        }

        // Absolute UTC times, not relative ones: a postmortem is read weeks later.
        array.push $timeline_lines {
          value = ($alert.fired_at|format_timestamp:"Y-m-d H:i:s":"UTC") ~ " UTC - " ~ ($alert.severity|first_notempty:"warning") ~ " alert on " ~ ($device|get:"name":"device") ~ " (" ~ ($device_type|get:"name":"unknown type") ~ "): " ~ ($alert.metric_key|first_notempty:"metric") ~ "=" ~ (($alert.observed_value|first_notnull:0)|to_text) ~ " vs threshold " ~ (($alert.threshold|first_notnull:0)|to_text) ~ ", z=" ~ (($alert.z_score|first_notnull:0)|to_text)
        }

        // Recovery time is what makes a duration measurable per device rather than only per incident.
        conditional {
          if ($alert.resolved_at != null) {
            array.push $timeline_lines {
              value = ($alert.resolved_at|format_timestamp:"Y-m-d H:i:s":"UTC") ~ " UTC - alert on " ~ ($device|get:"name":"device") ~ " for " ~ ($alert.metric_key|first_notempty:"metric") ~ " resolved"
            }
          }
          else {
            math.add $still_firing {
              value = 1
            }
          }
        }

        conditional {
          if (($seen_device_ids|in:$alert.device_id) == false) {
            array.push $seen_device_ids {
              value = $alert.device_id
            }

            array.push $device_lines {
              value = ($device|get:"name":"device") ~ " [" ~ ($device|get:"serial":"unknown serial") ~ "] " ~ ($device_type|get:"name":"unknown type") ~ "/" ~ ($device_type|get:"category":"other") ~ " at " ~ ($device|get:"location_label":"unspecified location") ~ ", current status " ~ ($device|get:"status":"unknown") ~ ", health " ~ (($device|get:"health_score":0)|to_text)
            }
          }
        }
      }
    }

    // "What was done" is not a guess: it is the command log.
    db.query device_command {
      where = $db.device_command.incident_id == $input.incident_id
      sort = {device_command.created_at: "asc"}
      return = {type: "list"}
    } as $commands

    // Remediation actions, rendered into the same timeline as the symptoms.
    var $action_lines {
      value = []
    }

    foreach ($commands) {
      each as $command {
        db.get device {
          field_name = "id"
          field_value = $command.device_id
          output = ["id", "name", "serial"]
        } as $command_device

        db.get user {
          field_name = "id"
          field_value = $command.issued_by
          output = ["id", "name"]
        } as $issuer

        array.push $action_lines {
          value = ($command.created_at|format_timestamp:"Y-m-d H:i:s":"UTC") ~ " UTC - " ~ ($issuer|get:"name":"an operator") ~ " issued " ~ $command.command ~ " to " ~ ($command_device|get:"name":"device") ~ " (state " ~ ($command.state|first_notempty:"queued") ~ ")"
        }
      }
    }

    // Distinct devices, the headline impact number.
    var $device_count {
      value = ($seen_device_ids|unique)|count
    }

    // Deduped metric list.
    var $metric_label {
      value = ((($metric_keys|filter_empty)|unique)|join:", ")|first_notempty:"multiple metrics"
    }

    // Onset, guarded because an incident with no alerts has no onset.
    var $span_start {
      value = "unknown"
    }

    // End of the window: the resolution time if closed, otherwise the most recent alert.
    var $span_end {
      value = "ongoing"
    }

    // Duration in minutes, which is the unit an impact statement is written in.
    var $duration_minutes {
      value = 0
    }

    conditional {
      if ($alert_count > 0) {
        var.update $span_start {
          value = ($fired_ms|array_min)|format_timestamp:"Y-m-d H:i:s":"UTC"
        }

        // Measure to resolution when there is one, otherwise to now - an open incident's duration is still accruing.
        var.update $duration_minutes {
          value = (((("now"|to_ms) - ($fired_ms|array_min)) / 60000))|round:1
        }
      }
    }

    // Closed incidents get a real end time, and the duration is measured to it rather than to now. Guarded on alert_count too, because array_min over an empty window has no answer.
    conditional {
      if (($incident.resolved_at != null) && ($alert_count > 0)) {
        var.update $span_end {
          value = ($incident.resolved_at|format_timestamp:"Y-m-d H:i:s":"UTC") ~ " UTC"
        }

        var.update $duration_minutes {
          value = (((($incident.resolved_at|to_ms) - ($fired_ms|array_min)) / 60000))|round:1
        }
      }
      elseif ($incident.resolved_at != null) {
        var.update $span_end {
          value = ($incident.resolved_at|format_timestamp:"Y-m-d H:i:s":"UTC") ~ " UTC"
        }
      }
    }

    // DETERMINISTIC DRAFT FIRST. A postmortem assembled from the log is worth having even with no model available; it is exactly the sections a human would otherwise transcribe by hand.
    var $postmortem {
      value = "# Postmortem: " ~ $incident.title ~ "\n\n**Site:** " ~ $site_label ~ "  \n**Severity:** " ~ ($incident.severity|first_notempty:"warning") ~ "  \n**State:** " ~ ($incident.state|first_notempty:"open") ~ "  \n**Owner:** " ~ ($assignee|get:"name":"unassigned") ~ "  \n**Window:** " ~ $span_start ~ " UTC to " ~ $span_end ~ " (" ~ ($duration_minutes|to_text) ~ " minutes)\n\n## What happened\n" ~ ($incident.ai_summary|first_notempty:"Correlated alerts were grouped into this incident by the alert-correlation sweep.") ~ "\n\n## Impact\n" ~ ($device_count|to_text) ~ " device(s) affected across " ~ ($alert_count|to_text) ~ " alert(s) on " ~ $metric_label ~ " over " ~ ($duration_minutes|to_text) ~ " minutes. " ~ ($still_firing|to_text) ~ " alert(s) had not recovered at the time of writing.\n\n### Devices\n- " ~ ($device_lines|join:"\n- ") ~ "\n\n## Timeline\n- " ~ ($timeline_lines|join:"\n- ") ~ "\n\n## Root cause\n" ~ ($incident.ai_root_cause|first_notempty:"Not yet determined. Run the analysis endpoint or investigate the shared attribute named in the correlation reason.") ~ "\n\n## What was done\n- " ~ (($action_lines|join:"\n- ")|first_notempty:"No remediation commands were issued from this incident.") ~ "\n\n## Prevention\n- Review whether an alert rule with a learned baseline would have caught this earlier than a static threshold.\n- Check whether the shared attribute in the correlation key (" ~ ($incident.correlation_key|first_notempty:"none") ~ ") is monitored in its own right.\n- Confirm the affected device class has a current firmware baseline.\n\n_Draft assembled from the incident log without model assistance._"
    }

    // Assume fallback until a model reply proves otherwise.
    var $fallback_used {
      value = true
    }

    // Provenance, stamped either way.
    var $model {
      value = null
    }

    // Surfaced so the UI can show what the button cost.
    var $latency_ms {
      value = 0
    }

    // Null unless an inference actually happened.
    var $insight_id {
      value = null
    }

    // Nothing to write a postmortem about, and no reason to spend a request finding that out.
    conditional {
      if (($input.call_ai == true) && ($alert_count > 0)) {
        // Markdown, not JSON: this output is read by a human and pasted into a wiki, so a fenced JSON envelope would only be in the way.
        var $system_prompt {
          value = "You are a senior site-reliability engineer writing an incident postmortem for an industrial IoT fleet. Write plain GitHub-flavoured markdown, not JSON and not a code fence around the whole document. Use exactly these level-2 headings in this order: What happened, Impact, Timeline, Root cause, What was done, Prevention. Keep the whole document under 700 words. Write in past tense and in the blameless voice: describe systems and signals, never fault a person. Reason ONLY from the incident record supplied in the user message - do not invent readings, device names, times, actions or contributing factors that are not present. Where the record is silent, say so explicitly (for example 'the record does not show whether the door was closed manually') rather than filling the gap. Under Impact give the device count and the duration in minutes. Under Timeline use a bulleted list of UTC timestamps taken from the supplied events. Under Prevention give three to five concrete, checkable items, and prefer detection improvements that the supplied telemetry would actually support."
        }

        // Everything the draft needs and nothing derived: the model gets the log, not our interpretation of it.
        var $user_prompt {
          value = "INCIDENT RECORD\nTitle: " ~ $incident.title ~ "\nSite: " ~ $site_label ~ " (region " ~ ($site|get:"region":"unknown") ~ ", timezone " ~ ($site|get:"timezone":"UTC") ~ ")\nSeverity: " ~ ($incident.severity|first_notempty:"warning") ~ "\nState: " ~ ($incident.state|first_notempty:"open") ~ "\nOwner: " ~ ($assignee|get:"name":"unassigned") ~ "\nOpened (UTC): " ~ ($incident.opened_at|format_timestamp:"Y-m-d H:i:s":"UTC") ~ "\nFirst alert (UTC): " ~ $span_start ~ "\nClosed (UTC): " ~ $span_end ~ "\nDuration (minutes): " ~ ($duration_minutes|to_text) ~ "\nAlerts: " ~ ($alert_count|to_text) ~ " total, " ~ ($still_firing|to_text) ~ " never recovered\nDistinct devices affected: " ~ ($device_count|to_text) ~ "\nMetrics involved: " ~ $metric_label ~ "\nWhy these alerts were grouped: " ~ ($incident.correlation_reason|first_notempty:"not recorded") ~ "\nExisting AI summary: " ~ ($incident.ai_summary|first_notempty:"none recorded") ~ "\nExisting AI root-cause hypothesis: " ~ ($incident.ai_root_cause|first_notempty:"none recorded") ~ "\nHypothesis confidence: " ~ (($incident.ai_confidence|first_notnull:0)|to_text) ~ "\n\nAFFECTED DEVICES\n- " ~ ($device_lines|join:"\n- ") ~ "\n\nEVENT TIMELINE\n- " ~ ($timeline_lines|join:"\n- ") ~ "\n\nREMEDIATION ACTIONS TAKEN\n- " ~ (($action_lines|join:"\n- ")|first_notempty:"none recorded") ~ "\n\nRECORDED REMEDIATION ADVICE (may or may not have been followed)\n" ~ ((($incident.ai_remediation|safe_array)|join:"; ")|first_notempty:"none recorded")
        }

        function.run "Nerve/fn_claude" {
          input = {
            system     : $system_prompt
            user_prompt: $user_prompt
            max_tokens : 2500
            kind       : "postmortem"
            incident_id: $input.incident_id
            title      : "Postmortem: " ~ $incident.title
            expect_json: false
          }
        } as $ai

        var.update $model {
          value = $ai.model
        }

        var.update $latency_ms {
          value = $ai.latency_ms
        }

        var.update $insight_id {
          value = $ai.insight_id
        }

        // fn_claude returns an empty string as a legitimate response, so emptiness is checked as well as the fallback flag.
        conditional {
          if (($ai.fallback_used == false) && !($ai.text|is_empty)) {
            var.update $postmortem {
              value = $ai.text
            }

            var.update $fallback_used {
              value = false
            }
          }
        }
      }
    }

    // Stored on the incident so the draft survives a reload and can be edited later rather than regenerated.
    db.edit incident {
      field_name = "id"
      field_value = $input.incident_id
      data = {ai_postmortem: $postmortem}
    } as $updated

    // Overwrites the previous draft, so the author of the overwrite is recorded.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "incident.postmortem"
        entity_type: "incident"
        entity_id  : $input.incident_id
        detail     : {
          alerts_considered : $alert_count
          devices_considered: $device_count
          actions_considered: ($action_lines|count)
          duration_minutes  : $duration_minutes
          fallback_used     : $fallback_used
          model             : $model
          latency_ms        : $latency_ms
          insight_id        : $insight_id
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    incident_id  : $input.incident_id
    postmortem   : $postmortem
    fallback_used: $fallback_used
    model        : $model
    latency_ms   : $latency_ms
    insight_id   : $insight_id
    source_record: {
      alerts          : $alert_count
      devices         : $device_count
      actions         : ($action_lines|count)
      duration_minutes: $duration_minutes
      span_start      : $span_start
      span_end        : $span_end
      still_firing    : $still_firing
    }
  }
  tags = ["nerve"]
}
