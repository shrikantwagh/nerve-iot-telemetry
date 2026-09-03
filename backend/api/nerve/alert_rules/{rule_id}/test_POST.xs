// Threshold tuning without this is guesswork: you save a rule, wait, and find out at 3am whether it was right. This replays the rule over real recent history for every device in its scope and reports how many pages it WOULD have sent - including the cooldown, because a count that ignores cooldown answers a question nobody asked. It creates nothing: no alert, no incident, no rule mutation, and it does not touch fire_count or last_fired_at.
query "alert-rules/{rule_id}/test" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    int rule_id { table = "alert_rule" }

    // 24h by default because a full day/night cycle is what most hand-picked thresholds actually get wrong. Capped at a week so an interactive call cannot walk a month of history.
    int hours?=24 filters=min:1|max:168

    // Caps the fan-out: a fleet-wide rule can match thousands of devices and this endpoint runs synchronously.
    int max_devices?=25 filters=min:1|max:200
  }

  stack {
    // Deliberately NOT operator-gated and not demo-blocked: it writes nothing, and a viewer arguing that a threshold is too noisy should be able to prove it.
    db.get alert_rule {
      field_name = "id"
      field_value = $input.rule_id
    } as $rule

    precondition ($rule != null) {
      error_type = "notfound"
      error = "Alert rule not found."
    }

    // offline is the absence of readings, so there is no history row to replay it against. Saying so beats returning a misleading zero.
    precondition ($rule.condition != "offline") {
      error_type = "inputerror"
      error = "The offline condition cannot be replayed against history - it is evaluated by the offline sweep task from device.last_seen_at, not from stored readings."
    }

    // Hoisted because add_secs_to_timestamp takes the offset as a filter argument, and a negated expression inline there does not read unambiguously.
    var $window_seconds {
      value = $input.hours * 3600
    }

    var $negative_window {
      value = 0 - $window_seconds
    }

    var $cutoff {
      value = "now"|add_secs_to_timestamp:$negative_window
    }

    // Scope resolution mirrors fn_evaluate_rules exactly: a null scope column is a wildcard, and the null-safe ==? drops the comparison entirely when the rule leaves that scope open.
    db.query device {
      where = ($db.device.id ==? $rule.device_id) && ($db.device.device_type_id ==? $rule.device_type_id) && ($db.device.site_id ==? $rule.site_id)
      sort = {device.id: "asc"}
      return = {type: "list", paging: {page: 1, per_page: $input.max_devices, metadata: false}}
    } as $devices

    // Fleet-wide totals, accumulated across the device loop below.
    var $total_fires {
      value = 0
    }

    var $devices_with_fires {
      value = 0
    }

    // Distinguishes "the rule is quiet" from "there is no data to judge it on", which is the difference between a verdict and a shrug.
    var $devices_with_history {
      value = 0
    }

    var $samples_examined {
      value = 0
    }

    // Per-device rows for the UI table: which devices would page, how often, and how far past the threshold they got.
    var $matches {
      value = []
    }

    // Surfaced in the response so the operator knows whether they are looking at 5-minute buckets or individual readings.
    var $source_used {
      value = "none"
    }

    // Precomputed once; the sample loop compares gaps against it rather than re-deriving it per sample.
    var $cooldown_ms {
      value = ($rule.cooldown_seconds|first_notnull:0) * 1000
    }

    foreach ($devices) {
      each as $device {
        // Rollups first: they are what the charts read, they are already bucketed, and they are far cheaper than raw rows over a week.
        db.query metric_rollup {
          where = $db.metric_rollup.device_id == $device.id && $db.metric_rollup.metric_key == $rule.metric_key && $db.metric_rollup.bucket_ts >= $cutoff
          sort = {metric_rollup.bucket_ts: "asc"}
          return = {type: "list"}
        } as $buckets

        // Both sources are normalised into one shape - {ts, avg, low, high, last} - so the condition switch below is written once instead of twice.
        var $samples {
          value = []
        }

        conditional {
          if (($buckets|count) > 0) {
            var.update $source_used {
              value = "metric_rollup"
            }

            foreach ($buckets) {
              each as $bucket {
                array.push $samples {
                  value = {
                    ts  : $bucket.bucket_ts
                    avg : $bucket.avg_value
                    low : $bucket.min_value
                    high: $bucket.max_value
                    last: $bucket.last_value
                  }
                }
              }
            }
          }
          else {
            // Fallback so a rule can be tuned on a fresh workspace, before task_rollup_metrics has ever run. A single reading is its own min, max and last.
            db.query telemetry {
              where = $db.telemetry.device_id == $device.id && $db.telemetry.ts >= $cutoff
              sort = {telemetry.ts: "asc"}
              return = {type: "list"}
            } as $readings

            foreach ($readings) {
              each as $reading {
                var $raw_value {
                  value = $reading.metrics|get:$rule.metric_key
                }

                // A reading that omits this rule's metric says nothing about this rule, so it is not a sample.
                conditional {
                  if ($raw_value != null) {
                    var.update $source_used {
                      value = "telemetry"
                    }

                    array.push $samples {
                      value = {
                        ts  : $reading.ts
                        avg : $raw_value
                        low : $raw_value
                        high: $raw_value
                        last: $raw_value
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Read once per device rather than inside the sample loop. Only the anomaly condition uses it, but branching around a query is not worth the extra nesting.
        db.query metric_baseline {
          where = $db.metric_baseline.device_id == $device.id && $db.metric_baseline.metric_key == $rule.metric_key
          return = {type: "single"}
        } as $baseline

        var $device_fires {
          value = 0
        }

        // The worst value seen on a firing sample - what the operator wants shown next to the threshold they are second-guessing.
        var $extreme {
          value = null
        }

        var $first_fire_ts {
          value = null
        }

        var $last_fire_ts {
          value = null
        }

        // Carries the previous sample's closing value forward, for the two conditions that are about change rather than level.
        var $prev_last {
          value = null
        }

        // Null until this device's first simulated fire, which is what makes the first hit exempt from the cooldown.
        var $last_fire_ms {
          value = null
        }

        conditional {
          if (($samples|count) > 0) {
            math.add $devices_with_history {
              value = 1
            }
          }
        }

        foreach ($samples) {
          each as $sample {
            math.add $samples_examined {
              value = 1
            }

            var $hit {
              value = false
            }

            // The value that justifies the hit, kept separately from the sample so `extreme` reports the number the operator would recognise (the peak, not the average).
            var $witness {
              value = $sample.avg
            }

            // Same condition semantics as fn_evaluate_rules, but evaluated against a bucket instead of a single reading - hence min/max rather than the raw value.
            switch ($rule.condition) {
              case ("gt") {
                // Bucket max, not average: a five-minute mean hides the spike a live rule would have caught.
                var.update $hit {
                  value = ($sample.high != null) && ($rule.threshold != null) && ($sample.high > $rule.threshold)
                }

                var.update $witness {
                  value = $sample.high
                }
              } break

              case ("lt") {
                var.update $hit {
                  value = ($sample.low != null) && ($rule.threshold != null) && ($sample.low < $rule.threshold)
                }

                var.update $witness {
                  value = $sample.low
                }
              } break

              case ("outside_range") {
                var.update $hit {
                  value = ($rule.threshold != null) && ($rule.threshold_high != null) && ((($sample.low != null) && ($sample.low < $rule.threshold)) || (($sample.high != null) && ($sample.high > $rule.threshold_high)))
                }

                var.update $witness {
                  value = $sample.high
                }
              } break

              case ("rate_of_change") {
                var.update $hit {
                  value = ($sample.last != null) && ($prev_last != null) && ($rule.threshold != null) && ((($sample.last - $prev_last)|abs) > $rule.threshold)
                }

                conditional {
                  if (($sample.last != null) && ($prev_last != null)) {
                    var.update $witness {
                      value = ($sample.last - $prev_last)|abs
                    }
                  }
                }
              } break

              case ("flatline") {
                // Flat inside the bucket AND flat against the previous one. Either test alone is a rounding artefact at rollup resolution.
                var.update $hit {
                  value = ($sample.low != null) && ($sample.high != null) && ($sample.low == $sample.high) && ($prev_last != null) && ($sample.last == $prev_last)
                }

                var.update $witness {
                  value = $sample.last
                }
              } break

              case ("anomaly") {
                // The same z fn_update_baseline computes at ingest: |x - ewma| / sqrt(ewmv), and 0 until the baseline has 20 samples, so an un-warmed baseline cannot manufacture a fire.
                var $z {
                  value = 0
                }

                conditional {
                  if (($baseline != null) && (($baseline.ewmv|first_notnull:0) > 0) && (($baseline.sample_count|first_notnull:0) >= 20) && ($sample.avg != null)) {
                    var.update $z {
                      value = (($sample.avg - $baseline.ewma)|abs) / ($baseline.ewmv|sqrt)
                    }
                  }
                }

                var.update $hit {
                  value = $z > ($rule.z_threshold|first_notnull:3)
                }

                var.update $witness {
                  value = $z
                }
              } break

              default {
                var.update $hit {
                  value = false
                }
              }
            }

            // Cooldown is replayed from the SAMPLE timestamps, not wall clock, which is the whole reason this is a replay and not a query.
            var $sample_ms {
              value = $sample.ts|to_ms
            }

            var $cooldown_ok {
              value = true
            }

            conditional {
              if ($last_fire_ms != null) {
                var.update $cooldown_ok {
                  value = ($sample_ms - $last_fire_ms) >= $cooldown_ms
                }
              }
            }

            conditional {
              if ($hit && $cooldown_ok) {
                math.add $device_fires {
                  value = 1
                }

                math.add $total_fires {
                  value = 1
                }

                var.update $last_fire_ms {
                  value = $sample_ms
                }

                var.update $last_fire_ts {
                  value = $sample.ts
                }

                conditional {
                  if ($first_fire_ts == null) {
                    var.update $first_fire_ts {
                      value = $sample.ts
                    }
                  }
                }

                // "Worst" depends on which direction the rule cares about: lowest for lt, highest for everything else.
                conditional {
                  if ($extreme == null) {
                    var.update $extreme {
                      value = $witness
                    }
                  }
                  elseif (($rule.condition == "lt") && ($witness < $extreme)) {
                    var.update $extreme {
                      value = $witness
                    }
                  }
                  elseif (($rule.condition != "lt") && ($witness > $extreme)) {
                    var.update $extreme {
                      value = $witness
                    }
                  }
                }
              }
            }

            // Advanced regardless of whether the sample fired, since the delta conditions compare consecutive samples, not consecutive fires.
            conditional {
              if ($sample.last != null) {
                var.update $prev_last {
                  value = $sample.last
                }
              }
            }
          }
        }

        // Only devices that would actually page make the table; a list of every device in scope is noise.
        conditional {
          if ($device_fires > 0) {
            math.add $devices_with_fires {
              value = 1
            }

            array.push $matches {
              value = {
                device_id       : $device.id
                device_name     : $device.name
                device_serial   : $device.serial
                would_fire      : $device_fires
                extreme_value   : $extreme
                first_fire_at   : $first_fire_ts
                last_fire_at    : $last_fire_ts
                samples_examined: ($samples|count)
              }
            }
          }
        }
      }
    }

    // Pages per device per hour is the only rate comparable across window sizes and scope sizes, which is what makes it usable as a verdict threshold.
    var $fire_rate {
      value = 0
    }

    conditional {
      if (($devices_with_history > 0) && ($input.hours > 0)) {
        var.update $fire_rate {
          value = $total_fires / ($devices_with_history * $input.hours)
        }
      }
    }

    var $judgement {
      value = "looks reasonable"
    }

    // Ordered most-diagnostic first: no data at all is not a verdict, and must not be reported as "safe".
    conditional {
      if ($samples_examined == 0) {
        var.update $judgement {
          value = "no history for this metric in the window, so this is not a verdict - widen the window or let the simulator run"
        }
      }
      elseif ($total_fires == 0) {
        var.update $judgement {
          value = "it never fired, so either the fleet was healthy or the rule is too loose to catch anything"
        }
      }
      elseif ($fire_rate > 1) {
        var.update $judgement {
          value = "probably too sensitive - more than one page per device per hour"
        }
      }
      elseif ($fire_rate > 0.2) {
        var.update $judgement {
          value = "noisy but arguably actionable - consider a tighter threshold or a longer cooldown"
        }
      }
      else {
        var.update $judgement {
          value = "looks reasonable"
        }
      }
    }

    // One sentence an operator can act on without reading the numbers underneath it.
    var $verdict {
      value = "would have fired " ~ ($total_fires|to_text) ~ " times across " ~ ($devices_with_fires|to_text) ~ " of " ~ ($devices|count|to_text) ~ " devices in " ~ ($input.hours|to_text) ~ "h - " ~ $judgement
    }
  }

  response = {
    rule_id                 : $rule.id
    rule_name               : $rule.name
    condition               : $rule.condition
    metric_key              : $rule.metric_key
    threshold               : $rule.threshold
    threshold_high          : $rule.threshold_high
    z_threshold             : $rule.z_threshold
    cooldown_seconds        : $rule.cooldown_seconds
    severity                : $rule.severity
    window_hours            : $input.hours
    data_source             : $source_used
    devices_in_scope        : ($devices|count)
    devices_capped_at       : $input.max_devices
    devices_with_history    : $devices_with_history
    samples_examined        : $samples_examined
    would_fire_total        : $total_fires
    devices_would_fire      : $devices_with_fires
    fires_per_device_per_hour: ($fire_rate|round:3)
    verdict                 : $verdict
    matches                 : $matches
    alerts_created          : 0
    caveat                  : "Dry run: nothing was written. Anomaly replay scores history against the CURRENT baseline rather than the baseline as it stood at each sample, and bucketed sources are evaluated on bucket min/max, so counts are indicative rather than exact."
  }
  tags = ["nerve"]
  guid = "nTQL9b1t1aJedPMNXyRuYGZn0_o"
}
