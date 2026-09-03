// One reverse-chronological feed for a device, merged from four tables. This is the screen an operator reads during an incident, and the reason it is one endpoint is that "the alert fired, then someone restarted it, then it fired again" is a single story told across alert, device_command, maintenance_prediction and audit_log.
query "devices/{device_id}/timeline" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    int device_id { table = "device" }

    // Events returned after the merge. Each source is read at this depth too, which is safe: the newest N overall must be inside each source's newest N.
    int limit?=50
  }

  stack {
    // Cheap existence check - a timeline for a device that does not exist should 404, not return an empty feed that looks like a quiet device.
    db.get device {
      field_name = "id"
      field_value = $input.device_id
      output = ["id", "name", "serial", "status"]
    } as $device

    precondition ($device != null) {
      error_type = "notfound"
      error = "Device not found."
    }

    // A runaway limit here would merge four unbounded lists in-process.
    precondition ($input.limit > 0 && $input.limit <= 200) {
      error_type = "inputerror"
      error = "limit must be between 1 and 200."
    }

    // The merged, normalised feed. Every source below pushes the same shape so the client renders one component per row rather than four.
    var $events {
      value = []
    }

    // Every state, not just firing: a resolved alert is the most interesting thing on a timeline, because it marks when the problem stopped.
    db.query alert {
      where = $db.alert.device_id == $input.device_id
      sort = {alert.fired_at: "desc"}
      return = {type: "list", paging: {page: 1, per_page: $input.limit, metadata: false}}
    } as $alerts

    foreach ($alerts) {
      each as $alert {
        // fired_at is the event's real time; created_at is the fallback for a row written without one.
        var $alert_ts {
          value = $alert.fired_at|first_notnull:$alert.created_at
        }

        array.push $events {
          value = {
            ts       : $alert_ts
            ts_ms    : $alert_ts|to_ms
            kind     : "alert"
            severity : $alert.severity
            state    : $alert.state
            title    : $alert.message
            ref_table: "alert"
            ref_id   : $alert.id
            detail   : {
              metric_key    : $alert.metric_key
              observed_value: $alert.observed_value
              threshold     : $alert.threshold
              z_score       : $alert.z_score
              incident_id   : $alert.incident_id
              resolved_at   : $alert.resolved_at
              acknowledged_at: $alert.acknowledged_at
            }
          }
        }
      }
    }

    // Commands are the "and then a human did something" half of the story. One event per command, stamped at issue time; sent_at and acked_at ride along in detail so the client can show the round trip without a second row.
    db.query device_command {
      where = $db.device_command.device_id == $input.device_id
      sort = {device_command.created_at: "desc"}
      return = {type: "list", paging: {page: 1, per_page: $input.limit, metadata: false}}
    } as $commands

    foreach ($commands) {
      each as $command {
        // Title is composed here rather than in the client so the feed reads consistently regardless of who renders it.
        var $command_title {
          value = "Command " ~ $command.command ~ " (" ~ $command.state ~ ")"
        }

        array.push $events {
          value = {
            ts       : $command.created_at
            ts_ms    : $command.created_at|to_ms
            kind     : "command"
            severity : null
            state    : $command.state
            title    : $command_title
            ref_table: "device_command"
            ref_id   : $command.id
            detail   : {
              command    : $command.command
              payload    : $command.payload
              issued_by  : $command.issued_by
              incident_id: $command.incident_id
              sent_at    : $command.sent_at
              acked_at   : $command.acked_at
              result     : $command.result
              note       : $command.note
            }
          }
        }
      }
    }

    // Predictions are future-tense events, placed at the time they were made rather than the time they predict - the timeline is a record of what was known when.
    db.query maintenance_prediction {
      where = $db.maintenance_prediction.device_id == $input.device_id
      sort = {maintenance_prediction.created_at: "desc"}
      return = {type: "list", paging: {page: 1, per_page: $input.limit, metadata: false}}
    } as $predictions

    foreach ($predictions) {
      each as $prediction {
        var $prediction_title {
          value = "Predicted failure: " ~ $prediction.component
        }

        array.push $events {
          value = {
            ts       : $prediction.created_at
            ts_ms    : $prediction.created_at|to_ms
            kind     : "prediction"
            severity : null
            state    : $prediction.state
            title    : $prediction_title
            ref_table: "maintenance_prediction"
            ref_id   : $prediction.id
            detail   : {
              component          : $prediction.component
              metric_key         : $prediction.metric_key
              trend_slope        : $prediction.trend_slope
              predicted_failure_at: $prediction.predicted_failure_at
              confidence         : $prediction.confidence
              recommended_action : $prediction.recommended_action
              scheduled_for      : $prediction.scheduled_for
            }
          }
        }
      }
    }

    // Status changes and every other edit come from audit_log, because that is where they are actually recorded - there is no status-history table, and inventing one would mean a second write on the ingest hot path. Anything with entity_type "device" and this id belongs on this device's timeline: creation, edits, maintenance holds, deletes attempted by tasks.
    db.query audit_log {
      where = $db.audit_log.entity_type == "device" && $db.audit_log.entity_id == $input.device_id
      sort = {audit_log.created_at: "desc"}
      return = {type: "list", paging: {page: 1, per_page: $input.limit, metadata: false}}
    } as $audit_entries

    foreach ($audit_entries) {
      each as $entry {
        array.push $events {
          value = {
            ts       : $entry.created_at
            ts_ms    : $entry.created_at|to_ms
            kind     : "change"
            severity : null
            state    : $entry.action
            title    : $entry.action
            ref_table: "audit_log"
            ref_id   : $entry.id
            detail   : {
              user_id: $entry.user_id
              source : $entry.source
              changes: $entry.detail
            }
          }
        }
      }
    }

    // Sorted on the numeric epoch field added above rather than on the timestamp, so ordering never depends on how timestamps compare as text. false = descending.
    var $sorted {
      value = $events|fsort:"ts_ms":"number":false
    }

    // Each source contributed up to `limit` rows, so the merged list can be four times too long; the newest `limit` of it is the answer.
    var $feed {
      value = $sorted|slice:0:$input.limit
    }
  }

  // returned_count vs total_merged tells the client whether older events exist, which is all a "load more" button needs to know.
  response = {
    device        : $device
    limit         : $input.limit
    total_merged  : $events|count
    returned_count: $feed|count
    events        : $feed
  }
  tags = ["nerve"]
}
