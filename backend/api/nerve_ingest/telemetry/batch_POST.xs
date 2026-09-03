// The simulator's path, and the one that decides whether the demo ingests a fleet or times out. Every design choice here is about keeping the cost of a batch bounded by the number of DEVICES it touches, not the number of readings it carries.
query "telemetry/batch" verb=POST {
  api_group = "NerveIngest"

  input {
    // Up to 500 readings per call. Wide format, so twelve metrics on one device is one entry, not twelve.
    object[] readings {
      schema {
        // Matched against device.serial; an unmatched serial is reported back, never dropped.
        text device_serial

        // The device's own clock for this reading. Omitted means "now".
        timestamp? ts?

        // {metric_key: value}
        json metrics
      }
    }

    // Seeding mode. Skips baselines, rules and realtime entirely: replaying 24h of history must not fire 10,000 historical alerts, and it must not stream 10,000 events into every open browser tab.
    bool backfill?=false

    // Declared so a device that cannot set headers can still authenticate; mw_api_key_auth reads it as the last of three transports.
    text api_key?
  }

  stack {
    // AUTHENTICATE FIRST. Deliberately ahead of the input preconditions below: an
    // unauthenticated caller must not be able to probe input validation, and a
    // 401 must not be distinguishable by which field it complained about.
    // (This was a pre-middleware until Xano refused it on the Free plan - see
    // function/nerve/fn_api_key_auth.xs for why enforcement lives here now.)
    function.run "Nerve/fn_api_key_auth" {
      input = {api_key: $input.api_key}
    } as $device_auth

    // An empty batch is a caller bug worth naming rather than a 200 that did nothing.
    precondition (($input.readings|count) > 0) {
      error_type = "inputerror"
      error = "readings must contain at least one entry."
    }

    // The documented ceiling. Enforced here so a runaway simulator gets a clear 400 instead of a request-timeout that looks like a platform fault.
    precondition (($input.readings|count) <= 500) {
      error_type = "inputerror"
      error = "A batch carries at most 500 readings. Split the payload."
    }

    // Distinct serials only. This list, not the reading list, is what sizes every query below.
    var $serials {
      value = ($input.readings|map:$$.device_serial)|unique
    }

    // ONE query resolves every device in the batch. Calling fn_resolve_device per reading would be 500 round trips for what is usually 50 devices; per distinct serial would still be 50. This is 1.
    db.query device {
      where = $db.device.serial in $serials
      return = {type: "list"}
    } as $devices

    // serial -> device row, so the per-reading loop below is a map lookup rather than a query.
    var $device_by_serial {
      value = {}
    }

    foreach ($devices) {
      each as $known {
        var.update $device_by_serial {
          value = $device_by_serial|set:$known.serial:$known
        }
      }
    }

    // Accumulates the telemetry rows for the single bulk insert.
    var $rows {
      value = []
    }

    // Serials with no device row. Reported in the response so a mis-seeded simulator is diagnosable instead of silently half-working.
    var $unknown {
      value = []
    }

    // serial -> the newest reading in this batch, plus its device row. Baselines, rules and realtime run against this map only, so a 500-reading batch costs at most one rule pass per device.
    var $newest {
      value = {}
    }

    // Hoisted out of the loop: one clock read for the whole batch, and every ingest_latency_ms in it is then measured against the same instant.
    var $now_ms {
      value = "now"|to_ms
    }

    foreach ($input.readings) {
      each as $reading {
        // Null means the serial is not registered. Devices are only created by /register, so an unknown serial here is a real signal.
        var $dev {
          value = $device_by_serial|get:$reading.device_serial:null
        }

        conditional {
          if ($dev == null) {
            array.push $unknown {
              value = $reading.device_serial
            }
          }
          else {
            // Per-reading timestamp, so a batch spanning an hour of history stays spread across that hour.
            var $rts {
              value = $reading.ts|first_notnull:"now"
            }

            // Negative on a device whose clock runs fast; clamped to 0 because there is no scalar max filter.
            var $lat_raw {
              value = $now_ms - ($rts|to_ms)
            }

            var $lat {
              value = 0
            }

            conditional {
              if ($lat_raw > 0) {
                var.update $lat {
                  value = $lat_raw|to_int
                }
              }
            }

            array.push $rows {
              value = {
                device_id        : $dev.id
                ts               : $rts
                metrics          : $reading.metrics
                ingest_latency_ms: $lat
              }
            }

            // High-water mark per serial. Readings inside a batch are not guaranteed to arrive in timestamp order, so "newest" is compared, not assumed to be last.
            var $seen {
              value = $newest|get:$reading.device_serial:null
            }

            // First reading for this serial always wins; after that it has to be at least as new.
            var $is_newer {
              value = ($seen == null)
            }

            conditional {
              if ($seen != null) {
                var.update $is_newer {
                  value = ($rts|to_ms) >= ($seen.ts|to_ms)
                }
              }
            }

            // The device row is carried in the entry so the second pass needs no further lookups.
            conditional {
              if ($is_newer) {
                var $entry {
                  value = {
                    ts     : $rts
                    metrics: $reading.metrics
                    device : $dev
                  }
                }

                var.update $newest {
                  value = $newest|set:$reading.device_serial:$entry
                }
              }
            }
          }
        }
      }
    }

    // Deduplicated: an unregistered device usually appears many times in one batch, and repeating it 40 times in the response is noise.
    var $unknown_serials {
      value = $unknown|unique
    }

    // Counted from the rows we built rather than from the bulk result, whose shape is not something this lane verified.
    var $inserted {
      value = 0
    }

    // ONE insert for the whole batch. A loop of db.add here is the single biggest difference between a backend that ingests a fleet and one that times out.
    conditional {
      if (($rows|count) > 0) {
        db.bulk.add telemetry {
          allow_id_field = false
          items = $rows
        } as $bulk

        var.update $inserted {
          value = $rows|count
        }
      }
    }

    // Summed across devices; stays 0 in backfill mode because no rule is evaluated there.
    var $alerts_fired {
      value = 0
    }

    // Distinct devices that actually had a reading stored, which is not the same as the serial count when some were unknown.
    var $devices_seen {
      value = ($newest|keys)|count
    }

    // Second pass, once per device rather than once per reading.
    foreach ($newest|entries) {
      each as $per_device {
        // The device row captured during the first pass.
        var $target {
          value = $per_device.value.device
        }

        // Merged, not replaced: a batch that carried only temperature must not wipe a door-state metric reported on an earlier batch. This denormalized blob is what makes the fleet grid one query instead of N.
        var $latest {
          value = {}
        }

        conditional {
          if ($target.metrics_latest != null) {
            var.update $latest {
              value = $target.metrics_latest
            }
          }
        }

        var.update $latest {
          value = $latest|merge:$per_device.value.metrics
        }

        // Built as a variable object so the status write stays conditional without a second db.edit branch.
        var $device_data {
          value = {}
        }

        var.update $device_data {
          value = $device_data|set:"metrics_latest":$latest
        }

        // The heartbeat the offline sweep measures against. Taken from the newest reading in the batch, not from now, so a backfill does not make an idle device look alive.
        var.update $device_data {
          value = $device_data|set:"last_seen_at":$per_device.value.ts
        }

        // A reading is proof of life, so it clears offline and completes provisioning. degraded belongs to fn_compute_health and maintenance is an operator's deliberate choice; ingest overrides neither.
        conditional {
          if (($target.status == "offline") || ($target.status == "provisioning")) {
            var.update $device_data {
              value = $device_data|set:"status":"online"
            }
          }
        }

        // Runs in backfill mode too: seeding history should still leave the fleet grid showing the seeded state.
        db.patch device {
          field_name = "id"
          field_value = $target.id
          data = $device_data
        } as $device_row

        // Everything below is skipped entirely when backfilling. Advancing baselines over replayed history would be defensible; firing the alerts and streaming the events that come with it would not.
        conditional {
          if ($input.backfill == false) {
            // {metric_key: z_score} for the rule engine's anomaly condition.
            var $z_scores {
              value = {}
            }

            // {metric_key: previous_value}. Mandatory here: fn_update_baseline overwrites metric_baseline.last_value with the current reading, so after the baseline pass the rule engine cannot recover the prior value from the row - flatline would compare the reading to itself and fire on every healthy reading.
            var $previous_values {
              value = {}
            }

            foreach ($per_device.value.metrics|entries) {
              each as $metric {
                // State strings are legal in a device_type's metric_schema; EWMA arithmetic on them is meaningless, so they are stored and skipped.
                conditional {
                  if (($metric.value|is_int) || ($metric.value|is_decimal)) {
                    function.run "Nerve/fn_update_baseline" {
                      input = {
                        device_id : $target.id
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

            // One rule pass per device per batch. The engine owns cooldowns and firing-alert dedupe, which is why every condition goes through it instead of being inlined here.
            function.run "Nerve/fn_evaluate_rules" {
              input = {
                device_id      : $target.id
                device_type_id : $target.device_type_id
                site_id        : $target.site_id
                metrics        : $per_device.value.metrics
                z_scores       : $z_scores
                previous_values: $previous_values
                ts             : $per_device.value.ts
              }
            } as $rules

            // var.update rather than math.add so the accumulator takes the function's returned count directly.
            var.update $alerts_fired {
              value = $alerts_fired + $rules.alerts_fired
            }

            // Per-device feed for an open device-detail chart.
            api.realtime_event {
              channel = "device:" ~ ($target.id|to_text)
              data = {
                type        : "telemetry"
                device_id   : $target.id
                serial      : $target.serial
                ts          : $per_device.value.ts
                metrics     : $per_device.value.metrics
                z_scores    : $z_scores
                alerts_fired: $rules.alerts_fired
              }
              auth_table = "user"
              auth_id = null
            }
          }
        }
      }
    }

    // ONE fleet-wide event per batch rather than one per device, so a 500-device sweep does not push 500 messages into every open tab. The overview tiles only need to know that a batch landed and how big it was.
    conditional {
      if ($input.backfill == false) {
        api.realtime_event {
          channel = "fleet"
          data = {
            type        : "telemetry_batch"
            inserted    : $inserted
            devices_seen: $devices_seen
            alerts_fired: $alerts_fired
          }
          auth_table = "user"
          auth_id = null
        }
      }
    }

    // Deliberately NOT audited on every batch: the simulator posts continuously and one audit row per batch would dwarf the audit log it is supposed to make readable. Audited only when there is something a human needs to see - a seeding run, or serials that did not resolve.
    conditional {
      if (($input.backfill == true) || (($unknown_serials|count) > 0)) {
        function.run "Nerve/fn_audit" {
          input = {
            action     : "telemetry.batch"
            entity_type: "telemetry"
            detail     : {
              inserted       : $inserted
              devices_seen   : $devices_seen
              readings       : $input.readings|count
              backfill       : $input.backfill
              unknown_serials: $unknown_serials
            }
            source     : "device"
          }
        } as $audit
      }
    }
  }

  response = {
    ok             : true
    inserted       : $inserted
    devices_seen   : $devices_seen
    alerts_fired   : $alerts_fired
    unknown_serials: $unknown_serials
  }
  tags = ["nerve"]
  guid = "cQOT3X3QYWwTccuWcB8TFJGKWyM"
}
