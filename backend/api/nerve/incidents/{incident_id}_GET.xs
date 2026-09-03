// The incident detail view. One call has to answer "what is broken, which devices, what does the AI think, what have we already tried, and in what order did it happen" - because an operator mid-incident should not be assembling that from six requests.
query "incidents/{incident_id}" verb=GET {
  api_group = "Nerve"
  auth = "user"
  description = "The full picture for one incident: site, assignee, every member alert with device and observed-vs-threshold, the distinct affected devices, the complete ai_* payload, the commands issued against it, and a chronologically sorted timeline."

  input {
    // Path parameter. Declared against the table so the language server knows it is a foreign key.
    int incident_id {
      table = "incident"
    }
  }

  stack {
    // Fetch first, guard second - everything below assumes the incident exists.
    db.get incident {
      field_name = "id"
      field_value = $input.incident_id
    } as $incident

    // An unknown id is a 404, not an empty 200: a client polling a deleted incident should stop.
    precondition ($incident != null) {
      error_type = "notfound"
      error = "Incident not found."
    }

    // Site is optional on the incident row (a cross-site correlation has none), so this can legitimately come back null.
    db.get site {
      field_name = "id"
      field_value = $incident.site_id
      output = ["id", "code", "name", "timezone", "region"]
    } as $site

    // Never return the assignee's password hash - the output list is the whitelist.
    db.get user {
      field_name = "id"
      field_value = $incident.assigned_to
      output = ["id", "name", "email", "role", "avatar_color"]
    } as $assignee

    // Members in the order they fired, which is also the order the timeline wants them.
    db.query alert {
      where = $db.alert.incident_id == $input.incident_id
      sort = {alert.fired_at: "asc"}
      return = {type: "list"}
    } as $alerts

    // Member alerts, each flattened with the device identity an operator recognises.
    var $members {
      value = []
    }

    // Distinct affected devices. Built alongside the member loop so the device rows are read once, not once per alert.
    var $devices {
      value = []
    }

    // Dedupe ledger for the loop above - the same device commonly contributes several alerts to one incident.
    var $seen_device_ids {
      value = []
    }

    // Every dated fact about this incident, accumulated unsorted and ordered once at the end.
    var $timeline {
      value = []
    }

    // The incident's own opening is the first timeline entry; without it the timeline starts mid-story.
    array.push $timeline {
      value = {
        ts       : $incident.opened_at
        ts_ms    : $incident.opened_at|to_ms
        kind     : "incident_opened"
        label    : "Incident opened: " ~ $incident.title
        device_id: null
        alert_id : null
      }
    }

    foreach ($alerts) {
      each as $alert {
        // Device identity: the name and serial are what an operator matches against the thing in front of them.
        db.get device {
          field_name = "id"
          field_value = $alert.device_id
        } as $device

        // Type carries the category and the metric schema, both of which the UI uses to render units and nominal bands.
        db.get device_type {
          field_name = "id"
          field_value = $device.device_type_id
        } as $device_type

        // Observed versus threshold side by side, because "12.4" alone is not an observation.
        array.push $members {
          value = {
            id              : $alert.id
            alert_rule_id   : $alert.alert_rule_id
            device_id       : $alert.device_id
            device_name     : $device|get:"name":null
            device_serial   : $device|get:"serial":null
            device_type_id  : $device|get:"device_type_id":null
            device_type_name: $device_type|get:"name":null
            device_type_code: $device_type|get:"code":null
            metric_key      : $alert.metric_key
            observed_value  : $alert.observed_value
            threshold       : $alert.threshold
            z_score         : $alert.z_score
            severity        : $alert.severity
            state           : $alert.state
            fired_at        : $alert.fired_at
            resolved_at     : $alert.resolved_at
            acknowledged_at : $alert.acknowledged_at
            acked_by        : $alert.acked_by
            message         : $alert.message
            context         : $alert.context
          }
        }

        // One entry per device, first sighting wins. A linear ledger is cheaper to verify than building a keyed map with |set.
        conditional {
          if (($seen_device_ids|in:$alert.device_id) == false) {
            array.push $seen_device_ids {
              value = $alert.device_id
            }

            array.push $devices {
              value = {
                id             : $alert.device_id
                name           : $device|get:"name":null
                serial         : $device|get:"serial":null
                status         : $device|get:"status":null
                health_score   : $device|get:"health_score":null
                site_id        : $device|get:"site_id":null
                location_label : $device|get:"location_label":null
                firmware_version: $device|get:"firmware_version":null
                last_seen_at   : $device|get:"last_seen_at":null
                uplink_device_id: $device|get:"uplink_device_id":null
                device_type_id : $device|get:"device_type_id":null
                type_name      : $device_type|get:"name":null
                type_category  : $device_type|get:"category":null
                metrics_latest : $device|get:"metrics_latest":null
              }
            }
          }
        }

        // When the alert fired is the load-bearing fact of a cascade: the ordering is what reveals the gateway went first.
        array.push $timeline {
          value = {
            ts       : $alert.fired_at
            ts_ms    : $alert.fired_at|to_ms
            kind     : "alert_fired"
            label    : ($device|get:"name":"device") ~ " " ~ ($alert.metric_key|first_notempty:"metric") ~ " fired (" ~ $alert.severity ~ ")"
            device_id: $alert.device_id
            alert_id : $alert.id
          }
        }

        // Recovery is as informative as onset - a metric that recovered on its own points away from a hardware fault.
        conditional {
          if ($alert.resolved_at != null) {
            array.push $timeline {
              value = {
                ts       : $alert.resolved_at
                ts_ms    : $alert.resolved_at|to_ms
                kind     : "alert_resolved"
                label    : ($device|get:"name":"device") ~ " " ~ ($alert.metric_key|first_notempty:"metric") ~ " resolved"
                device_id: $alert.device_id
                alert_id : $alert.id
              }
            }
          }
        }
      }
    }

    // What has already been tried. Shown next to the AI's remediation list so an operator does not repeat a step.
    db.query device_command {
      where = $db.device_command.incident_id == $input.incident_id
      sort = {device_command.created_at: "asc"}
      return = {type: "list"}
    } as $raw_commands

    // Commands enriched with the device name, same reasoning as the alerts.
    var $commands {
      value = []
    }

    foreach ($raw_commands) {
      each as $command {
        db.get device {
          field_name = "id"
          field_value = $command.device_id
          output = ["id", "name", "serial"]
        } as $command_device

        array.push $commands {
          value = {
            id         : $command.id
            device_id  : $command.device_id
            device_name: $command_device|get:"name":null
            command    : $command.command
            payload    : $command.payload
            state      : $command.state
            issued_by  : $command.issued_by
            created_at : $command.created_at
            sent_at    : $command.sent_at
            acked_at   : $command.acked_at
            result     : $command.result
            note       : $command.note
          }
        }

        // A remediation attempt belongs on the same timeline as the symptoms it was meant to fix.
        array.push $timeline {
          value = {
            ts       : $command.created_at
            ts_ms    : $command.created_at|to_ms
            kind     : "command_issued"
            label    : "Command " ~ $command.command ~ " issued to " ~ ($command_device|get:"name":"device")
            device_id: $command.device_id
            alert_id : null
          }
        }
      }
    }

    // The moment the hypothesis appeared, so the timeline shows whether the operator acted before or after reading it.
    conditional {
      if ($incident.ai_generated_at != null) {
        array.push $timeline {
          value = {
            ts       : $incident.ai_generated_at
            ts_ms    : $incident.ai_generated_at|to_ms
            kind     : "ai_analysis"
            label    : "AI analysis generated by " ~ ($incident.ai_model|first_notempty:"deterministic fallback")
            device_id: null
            alert_id : null
          }
        }
      }
    }

    // Closing entry, only once there is one.
    conditional {
      if ($incident.resolved_at != null) {
        array.push $timeline {
          value = {
            ts       : $incident.resolved_at
            ts_ms    : $incident.resolved_at|to_ms
            kind     : "incident_resolved"
            label    : "Incident resolved"
            device_id: null
            alert_id : null
          }
        }
      }
    }

    // Sorted numerically on epoch-ms rather than on the timestamp text, so ordering does not depend on a date format.
    var $timeline_sorted {
      value = $timeline|sort:"ts_ms":"number":true
    }

    // Age in seconds, so the UI can render "3h 12m" without a second clock source.
    var $age_seconds {
      value = ((("now"|to_ms) - ($incident.opened_at|to_ms)) / 1000)|floor
    }

    // Firing count drives the "still burning" badge; it is not the same as alert_count, which is a running tally across sweeps.
    var $firing_count {
      value = 0
    }

    foreach ($members) {
      each as $member {
        conditional {
          if ($member.state == "firing") {
            math.add $firing_count {
              value = 1
            }
          }
        }
      }
    }
  }

  response = {
    incident: {
      id                : $incident.id
      title             : $incident.title
      severity          : $incident.severity
      state             : $incident.state
      site_id           : $incident.site_id
      device_count      : $incident.device_count
      alert_count       : $incident.alert_count
      opened_at         : $incident.opened_at
      resolved_at       : $incident.resolved_at
      age_seconds       : $age_seconds
      assigned_to       : $incident.assigned_to
      correlation_key   : $incident.correlation_key
      correlation_reason: $incident.correlation_reason
      created_at        : $incident.created_at
    }
    site               : $site
    assignee           : $assignee
    alerts             : $members
    alerts_firing      : $firing_count
    devices            : $devices
    devices_affected   : $devices|count
    commands           : $commands
    ai: {
      summary      : $incident.ai_summary
      root_cause   : $incident.ai_root_cause
      confidence   : $incident.ai_confidence
      remediation  : $incident.ai_remediation
      evidence     : $incident.ai_evidence
      model        : $incident.ai_model
      generated_at : $incident.ai_generated_at
      fallback_used: $incident.ai_fallback_used
      postmortem   : $incident.ai_postmortem
      exists       : !($incident.ai_summary|is_empty)
    }
    timeline: $timeline_sorted
  }
  tags = ["nerve"]
}
