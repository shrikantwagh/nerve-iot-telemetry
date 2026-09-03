// One reading from one device. The batch endpoint is what the simulator uses; this is the path a real device with a single sensor takes, and it is deliberately the same pipeline end to end.
query "telemetry" verb=POST {
  api_group = "NerveIngest"

  input {
    // Preferred identifier: a device knows its own serial, not its row id.
    text device_serial? filters=trim

    // Accepted for callers that already hold the id (the simulator after registration, the admin UI's test button).
    int device_id? { table = "device" }

    // The device's own clock. Omitted means "now"; supplying it is what makes a replayed history line up.
    timestamp? ts?

    // Wide-format reading: {metric_key: value}. Non-numeric values (state strings) are stored but skipped by the baseline pass.
    json metrics

    // Declared so a device that cannot set headers can still authenticate; mw_api_key_auth reads it as the last of three transports.
    text api_key?
  }

  stack {
    // Without one of the two identifiers there is nothing to attach the reading to.
    precondition (($input.device_id != null) || (($input.device_serial|strlen) > 0)) {
      error_type = "inputerror"
      error = "Either device_serial or device_id is required."
    }

    // A reading with no metrics would insert a row that no chart, rule or baseline can use.
    precondition (($input.metrics|count) > 0) {
      error_type = "inputerror"
      error = "metrics must contain at least one key."
    }

    // Resolved below by whichever identifier arrived.
    var $device {
      value = null
    }

    // create_if_missing is deliberately false on the telemetry path: auto-provisioning here would let a typo'd serial mint a device on every reading. /register is the only door that creates.
    conditional {
      if ($input.device_id != null) {
        db.get device {
          field_name = "id"
          field_value = $input.device_id
        } as $by_id

        var.update $device {
          value = $by_id
        }
      }
      else {
        function.run "Nerve/fn_resolve_device" {
          input = {
            serial           : $input.device_serial
            create_if_missing: false
          }
        } as $resolved

        var.update $device {
          value = $resolved.device
        }
      }
    }

    // An unknown serial is a caller error, not a server fault, and must not be swallowed - a silently dropped reading is the worst failure mode a telemetry pipeline has.
    precondition ($device != null) {
      error_type = "notfound"
      error = "No device registered for the supplied identifier. POST /register first."
    }

    // Honour the device's clock when it has one, so a backfilled or buffered reading lands at the time it was taken rather than the time it arrived.
    var $ts {
      value = $input.ts|first_notnull:"now"
    }

    // How far behind real time the reading was when we stored it - the number that tells you a device's buffer is backing up. Kept non-negative because a device clock running fast would otherwise record nonsense; there is no scalar max filter, so this is an explicit branch.
    var $latency_raw {
      value = ("now"|to_ms) - ($ts|to_ms)
    }

    // Default 0 covers both a perfectly fresh reading and a future-stamped one.
    var $latency {
      value = 0
    }

    conditional {
      if ($latency_raw > 0) {
        var.update $latency {
          value = $latency_raw|to_int
        }
      }
    }

    // The immutable fact. Everything after this point is derived state that can be recomputed from this table.
    db.add telemetry {
      data = {
        device_id        : $device.id
        ts               : $ts
        metrics          : $input.metrics
        ingest_latency_ms: $latency
      }
    } as $reading

    // metrics_latest is merged, not replaced: a device that reports temperature every 10s and door state every minute must not have its door state wiped by the temperature reading. This denormalization is what makes the fleet grid one query instead of N.
    var $latest {
      value = {}
    }

    conditional {
      if ($device.metrics_latest != null) {
        var.update $latest {
          value = $device.metrics_latest
        }
      }
    }

    var.update $latest {
      value = $latest|merge:$input.metrics
    }

    // Built as a variable object so the status write below is conditional without needing two db.edit branches.
    var $device_data {
      value = {}
    }

    var.update $device_data {
      value = $device_data|set:"metrics_latest":$latest
    }

    // The heartbeat the offline sweep task measures against.
    var.update $device_data {
      value = $device_data|set:"last_seen_at":$ts
    }

    // A reading is proof of life, so it clears offline and completes provisioning. degraded and maintenance are left alone: degraded is owned by fn_compute_health, and maintenance is an operator's deliberate choice that ingest must not override.
    conditional {
      if (($device.status == "offline") || ($device.status == "provisioning")) {
        var.update $device_data {
          value = $device_data|set:"status":"online"
        }
      }
    }

    db.patch device {
      field_name = "id"
      field_value = $device.id
      data = $device_data
    } as $device_row

    // {metric_key: z_score}, consumed by the rule engine's anomaly condition.
    var $z_scores {
      value = {}
    }

    // {metric_key: previous_value}. Mandatory, not optional: fn_update_baseline overwrites metric_baseline.last_value with the current reading, so once baselines are advanced the rule engine can no longer read the prior value off the row - flatline would compare the reading to itself and fire on every healthy reading.
    var $previous_values {
      value = {}
    }

    // Baselines first (they are the only source of z-scores), then rules once. That ordering is why previous_values has to be collected here.
    foreach ($input.metrics|entries) {
      each as $metric {
        // A device_type's metric_schema allows state strings; EWMA arithmetic on those is meaningless, so they are stored and skipped rather than coerced.
        conditional {
          if (($metric.value|is_int) || ($metric.value|is_decimal)) {
            function.run "Nerve/fn_update_baseline" {
              input = {
                device_id : $device.id
                metric_key: $metric.key
                value     : $metric.value
              }
            } as $baseline

            var.update $z_scores {
              value = $z_scores|set:$metric.key:$baseline.z_score
            }

            var.update $previous_values {
              value = $previous_values|set:$metric.key:$baseline.previous_value
            }
          }
        }
      }
    }

    // One call for the whole reading. The engine owns cooldowns and firing-alert dedupe, which is the entire point of routing every condition through it rather than inlining thresholds here.
    function.run "Nerve/fn_evaluate_rules" {
      input = {
        device_id      : $device.id
        device_type_id : $device.device_type_id
        site_id        : $device.site_id
        metrics        : $input.metrics
        z_scores       : $z_scores
        previous_values: $previous_values
        ts             : $ts
      }
    } as $rules

    // Per-device feed: the device detail chart appends without polling. Published after the writes so a subscriber that immediately re-reads sees the same state.
    api.realtime_event {
      channel = "device:" ~ ($device.id|to_text)
      data = {
        type        : "telemetry"
        device_id   : $device.id
        serial      : $device.serial
        ts          : $ts
        metrics     : $input.metrics
        z_scores    : $z_scores
        alerts_fired: $rules.alerts_fired
      }
      auth_table = "user"
      auth_id = null
    }

    // Fleet-wide feed: the overview tiles and ingest sparkline. Carries the summary only, never the full metrics blob, so a 5k-device fleet does not push a firehose into every open browser tab.
    api.realtime_event {
      channel = "fleet"
      data = {
        type        : "telemetry"
        device_id   : $device.id
        serial      : $device.serial
        site_id     : $device.site_id
        status      : $device_row.status
        ts          : $ts
        alerts_fired: $rules.alerts_fired
      }
      auth_table = "user"
      auth_id = null
    }
  }

  response = {ok: true, device_id: $device.id, alerts_fired: $rules.alerts_fired, z_flags: $z_scores}
  tags = ["nerve"]
}
