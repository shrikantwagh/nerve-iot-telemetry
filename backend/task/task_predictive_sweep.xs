// Predictive maintenance without a model server: an ordinary least-squares fit over the rollups this fleet already produces. The point is not sophistication, it is falsifiability - every prediction stores the fit inputs in `evidence`, so an operator can check the forecast instead of believing it.
task task_predictive_sweep {
  description = "Hourly: least-squares fits each gauge metric's recent rollup series per device, and where the trend is strong and extrapolates across a hard or nominal limit inside the horizon, opens a maintenance_prediction with an AI-worded recommendation and the fit inputs as evidence."
  active = true

  stack {
    // Fit window. Three days of 5-minute buckets is long enough for a slow drift (battery fade, bearing wear) to outweigh a diurnal cycle, short enough that a repair last week does not drag the line.
    var $window_hours {
      value = 72
    }

    // How far ahead a crossing still counts as actionable. Beyond two weeks the linear assumption is fiction and the prediction is noise an operator will learn to ignore.
    var $horizon_hours {
      value = 336
    }

    // Below this the fit is fitting noise. 12 buckets is one hour of continuous reporting.
    var $min_points {
      value = 12
    }

    // Explained-variance floor. 0.5 admits a noisy but real trend while rejecting a flat series with one excursion in it.
    var $min_r2 {
      value = 0.5
    }

    // Sample count at which the sample-size half of `confidence` saturates - four hours of buckets.
    var $confidence_full_n {
      value = 48
    }

    // Per-run device cap. Sorted sickest-first below, so an oversized fleet gets its worst devices predicted every hour and its healthiest ones eventually; a cap that silently truncated in id order would strand half the fleet forever.
    var $device_cap {
      value = 200
    }

    // Sampled once so every prediction in this run extrapolates from the same instant.
    var $now_ms {
      value = "now"|to_ms
    }

    // Fit window floor, as epoch ms to match the rollup comparisons.
    var $cutoff_ms {
      value = $now_ms - ($window_hours * 3600000)
    }

    // Sickest first: health_score already folds in firing alerts and staleness, so it is the best available proxy for "most likely to be worth a forecast". Maintenance holds are excluded - a device already on the bench does not need to be told it will fail.
    db.query device {
      where = $db.device.status != "maintenance"
      sort = {device.health_score: "asc"}
      return = {type: "list", paging: {page: 1, per_page: $device_cap, totals: true}}
      output = ["items.id", "items.name", "items.serial", "items.device_type_id", "items.site_id", "items.status", "itemsTotal"]
    } as $device_page

    var $devices {
      value = $device_page.items|safe_array
    }

    // Reported so a fleet that has outgrown the cap is visible in the audit row.
    var $devices_skipped {
      value = ($device_page.itemsTotal|first_notnull:0) - ($devices|count)
    }

    // Counters for the audit detail.
    var $series_fitted {
      value = 0
    }

    // Fits that cleared every gate and produced a row.
    var $predictions_created {
      value = 0
    }

    // Fits rejected because an open prediction for that (device, metric) already exists - the dedupe working.
    var $duplicates_skipped {
      value = 0
    }

    // Created prediction ids, so the audit row links straight to what this run opened.
    var $prediction_ids {
      value = []
    }

    foreach ($devices) {
      each as $device {
        // metric_schema is the declarative contract that makes onboarding one call: it tells this task which metrics are gauges and what their limits are, with no per-device configuration.
        db.get device_type {
          field_name = "id"
          field_value = $device.device_type_id
        } as $device_type

        var $schema {
          value = ($device_type|get:"metric_schema":[])|safe_array
        }

        foreach ($schema) {
          each as $metric {
            // Only gauges. Fitting a line through a monotonic counter predicts nothing but the clock, and a state metric has no ordering to extrapolate.
            var $kind {
              value = $metric|get:"kind":"gauge"
            }

            var $metric_key {
              value = $metric|get:"key":""
            }

            conditional {
              if ($kind == "gauge" && !($metric_key|is_empty)) {
                // Rollups, not raw telemetry: the fit reads at most 864 pre-aggregated rows instead of tens of thousands of readings, and the averaging has already removed the per-reading jitter.
                db.query metric_rollup {
                  where = $db.metric_rollup.device_id == $device.id && $db.metric_rollup.metric_key == $metric_key && $db.metric_rollup.bucket_ts >= $cutoff_ms
                  sort = {metric_rollup.bucket_ts: "asc"}
                  return = {type: "list", paging: {page: 1, per_page: 900}}
                  output = ["items.bucket_ts", "items.avg_value", "items.sample_count"]
                } as $rollup_page

                var $points {
                  value = $rollup_page.items|safe_array
                }

                var $n {
                  value = $points|count
                }

                conditional {
                  if ($n >= $min_points) {
                    // x is hours since the first bucket, not epoch ms: it keeps the sums inside a sane float range and makes `trend_slope` directly readable as "units per hour".
                    var $origin_ms {
                      value = (($points|first)|get:"bucket_ts")|to_ms
                    }

                    var $sx {
                      value = 0
                    }

                    var $sy {
                      value = 0
                    }

                    var $sxx {
                      value = 0
                    }

                    var $sxy {
                      value = 0
                    }

                    // Needed only for r-squared; the slope itself does not use it.
                    var $syy {
                      value = 0
                    }

                    // The fit inputs, stored on the prediction so the forecast is checkable rather than oracular.
                    var $series {
                      value = []
                    }

                    // Readings behind the whole series, reported as the prediction's underlying evidence weight.
                    var $raw_samples {
                      value = 0
                    }

                    foreach ($points) {
                      each as $point {
                        var $t {
                          value = ((($point.bucket_ts|to_ms) - $origin_ms) / 3600000)
                        }

                        var $y {
                          value = ($point.avg_value|first_notnull:0)|to_decimal
                        }

                        math.add $sx {
                          value = $t
                        }

                        math.add $sy {
                          value = $y
                        }

                        math.add $sxx {
                          value = $t * $t
                        }

                        math.add $sxy {
                          value = $t * $y
                        }

                        math.add $syy {
                          value = $y * $y
                        }

                        math.add $raw_samples {
                          value = ($point.sample_count|first_notnull:0)|to_int
                        }

                        array.push $series {
                          value = {t_hours: $t|round:3, value: $y}
                        }
                      }
                    }

                    // Shared numerator of both slope and r-squared.
                    var $cov {
                      value = ($n * $sxy) - ($sx * $sy)
                    }

                    // Variance of x, scaled by n. Zero only if every bucket shares a timestamp, which the ascending sort plus distinct buckets rules out - but division is not the place to be optimistic.
                    var $var_x {
                      value = ($n * $sxx) - ($sx * $sx)
                    }

                    // Variance of y, scaled by n. Zero on a perfectly flat series, which has no trend to report.
                    var $var_y {
                      value = ($n * $syy) - ($sy * $sy)
                    }

                    conditional {
                      if ($var_x > 0 && $var_y > 0) {
                        math.add $series_fitted {
                          value = 1
                        }

                        // Units per hour.
                        var $slope {
                          value = $cov / $var_x
                        }

                        // Coefficient of determination for a simple linear fit: the squared correlation.
                        var $r2 {
                          value = ($cov * $cov) / ($var_x * $var_y)
                        }

                        // Extrapolation starts from the most recent observed bucket rather than from the fitted line, so a prediction is anchored to reality even when the fit is imperfect.
                        var $last_value {
                          value = ((($points|last)|get:"avg_value")|first_notnull:0)|to_decimal
                        }

                        // Hard limits are the manufacturer's; nominal is the operating band. Hard wins when declared, because crossing it is the actual failure.
                        var $limit_high {
                          value = $metric|get:"hard_max"
                        }

                        var $limit_high_kind {
                          value = "hard_max"
                        }

                        conditional {
                          if ($limit_high == null) {
                            var.update $limit_high {
                              value = $metric|get:"nominal_max"
                            }

                            var.update $limit_high_kind {
                              value = "nominal_max"
                            }
                          }
                        }

                        var $limit_low {
                          value = $metric|get:"hard_min"
                        }

                        var $limit_low_kind {
                          value = "hard_min"
                        }

                        conditional {
                          if ($limit_low == null) {
                            var.update $limit_low {
                              value = $metric|get:"nominal_min"
                            }

                            var.update $limit_low_kind {
                              value = "nominal_min"
                            }
                          }
                        }

                        // Hours until the extrapolated line reaches the limit the trend is heading towards. Negative means the limit is behind us, which is an alerting problem, not a prediction.
                        var $hours_to_limit {
                          value = null
                        }

                        // Which bound the forecast is about; ends up in the prediction text and in evidence.
                        var $limit_value {
                          value = null
                        }

                        var $limit_kind {
                          value = null
                        }

                        // Direction decides which bound matters. A metric drifting up cannot fail low.
                        conditional {
                          if ($slope > 0 && $limit_high != null) {
                            var.update $hours_to_limit {
                              value = ($limit_high - $last_value) / $slope
                            }

                            var.update $limit_value {
                              value = $limit_high
                            }

                            var.update $limit_kind {
                              value = $limit_high_kind
                            }
                          }
                          elseif ($slope < 0 && $limit_low != null) {
                            // Both numerator and denominator are negative here, so the quotient is positive hours.
                            var.update $hours_to_limit {
                              value = ($limit_low - $last_value) / $slope
                            }

                            var.update $limit_value {
                              value = $limit_low
                            }

                            var.update $limit_kind {
                              value = $limit_low_kind
                            }
                          }
                        }

                        // All four gates collapsed into one flag: a crossing exists, it is ahead of us, it is inside the horizon, and the fit explains enough of the variance to be worth an operator's attention.
                        var $actionable {
                          value = ($hours_to_limit != null) && ($r2 >= $min_r2)
                        }

                        conditional {
                          if ($actionable) {
                            var.update $actionable {
                              value = ($hours_to_limit > 0) && ($hours_to_limit <= $horizon_hours)
                            }
                          }
                        }

                        conditional {
                          if ($actionable) {
                            // One open prediction per (device, metric). Re-opening the same forecast every hour would recreate exactly the alert fatigue this product exists to remove; a stale forecast is corrected by dismissing it, not by piling on.
                            db.query maintenance_prediction {
                              where = $db.maintenance_prediction.device_id == $device.id && $db.maintenance_prediction.metric_key == $metric_key && $db.maintenance_prediction.state == "open"
                              return = {type: "exists"}
                            } as $already_open

                            conditional {
                              if ($already_open) {
                                math.add $duplicates_skipped {
                                  value = 1
                                }
                              }
                              else {
                                // Confidence is the fit quality tempered by how much data backed it, so a perfect line through 12 points does not outrank a good line through 200.
                                var $sample_factor {
                                  value = $n / $confidence_full_n
                                }

                                // Explicit clamp: the scalar min/max filter aliases are rejected by the language server.
                                conditional {
                                  if ($sample_factor > 1) {
                                    var.update $sample_factor {
                                      value = 1
                                    }
                                  }
                                }

                                var $confidence {
                                  value = ($r2 * $sample_factor)|round:2
                                }

                                // Absolute forecast time, which is what the UI sorts and counts down to.
                                var $predicted_failure_at {
                                  value = $now_ms + ($hours_to_limit * 3600000)
                                }

                                // Human label from the schema when the type author supplied one; the raw key otherwise.
                                var $metric_label {
                                  value = ($metric|get:"label":$metric_key)|first_notempty:$metric_key
                                }

                                var $unit {
                                  value = ($metric|get:"unit":"")|to_text
                                }

                                // Days reads better than hours in a sentence and in a list view.
                                var $days_to_limit {
                                  value = ($hours_to_limit / 24)|round:1
                                }

                                var $direction {
                                  value = "rising"
                                }

                                conditional {
                                  if ($slope < 0) {
                                    var.update $direction {
                                      value = "falling"
                                    }
                                  }
                                }

                                // Everything the fit consumed, so the forecast can be re-derived by hand. This is the difference between a prediction and a horoscope.
                                var $evidence {
                                  value = {
                                    metric_key       : $metric_key
                                    metric_label     : $metric_label
                                    unit             : $unit
                                    method           : "ordinary least squares over metric_rollup.avg_value, x in hours since first bucket"
                                    window_hours     : $window_hours
                                    bucket_seconds   : 300
                                    sample_count     : $n
                                    raw_samples      : $raw_samples
                                    r_squared        : $r2|round:4
                                    slope_per_hour   : $slope|round:6
                                    last_value       : $last_value
                                    limit_kind       : $limit_kind
                                    limit_value      : $limit_value
                                    hours_to_limit   : $hours_to_limit|round:2
                                    horizon_hours    : $horizon_hours
                                    fit_origin_ms    : $origin_ms
                                    generated_at_ms  : $now_ms
                                    series           : $series
                                  }
                                }

                                // The deterministic answer, computed before the model is asked. It is what ships when there is no API key, when Anthropic rate-limits, or when the reply will not parse.
                                var $component {
                                  value = $metric_label ~ " subsystem"
                                }

                                var $recommended_action {
                                  value = "Inspect the " ~ $metric_label ~ " path on " ~ $device.name ~ " (" ~ $device.serial ~ "): it is " ~ $direction ~ " at " ~ (($slope|round:4)|to_text) ~ " " ~ ($unit|first_notempty:"units") ~ "/hour and, held to that trend, reaches its " ~ ($limit_kind|to_text) ~ " of " ~ (($limit_value|to_decimal)|to_text) ~ " in about " ~ ($days_to_limit|to_text) ~ " day(s). Schedule the work before then."
                                }

                                // STRICT JSON because the reply lands in typed columns, not in a rendered blob.
                                var $system_prompt {
                                  value = "You are a reliability engineer for industrial IoT hardware. You are given a measured linear trend on one metric of one device. Reply with STRICT JSON only, no prose and no markdown fence, using exactly these keys: component (a short noun phrase naming the physical part most likely responsible for this trend), recommended_action (one or two imperative sentences a technician can act on, mentioning the timeframe), likely_cause (one short sentence). Do not invent readings that were not given to you, and do not restate the numbers you were given more than once."
                                }

                                // Facts only, all of them already in the database. Semicolon-separated rather than newline-separated because literal escape handling in XanoScript strings is unverified here.
                                var $user_prompt {
                                  value = "Device: " ~ $device.name ~ " (" ~ $device.serial ~ "); device type: " ~ ($device_type|get:"name":"unknown") ~ "; category: " ~ ($device_type|get:"category":"other") ~ "; metric: " ~ $metric_label ~ " (" ~ $metric_key ~ ")" ~ "; unit: " ~ ($unit|first_notempty:"unspecified") ~ "; current value: " ~ ($last_value|to_text) ~ "; trend: " ~ $direction ~ " " ~ (($slope|round:6)|to_text) ~ " per hour; r-squared: " ~ (($r2|round:3)|to_text) ~ " over " ~ ($n|to_text) ~ " five-minute buckets spanning " ~ ($window_hours|to_text) ~ " hours; limit being approached: " ~ ($limit_kind|to_text) ~ " = " ~ (($limit_value|to_decimal)|to_text) ~ "; projected to reach that limit in " ~ ($days_to_limit|to_text) ~ " day(s)."
                                }

                                function.run "Nerve/fn_claude" {
                                  input = {
                                    system     : $system_prompt
                                    user_prompt: $user_prompt
                                    max_tokens : 500
                                    kind       : "predictive_maintenance"
                                    device_id  : $device.id
                                    title      : $device.name ~ ": " ~ $metric_label ~ " trending to " ~ ($limit_kind|to_text)
                                    expect_json: true
                                  }
                                } as $ai

                                // Recorded so the row states plainly whether the wording is model-derived or rule-derived.
                                var $ai_fallback_used {
                                  value = true
                                }

                                // The model's wording is used only when the call succeeded *and* the reply parsed; anything else keeps the deterministic text above.
                                conditional {
                                  if (($ai.fallback_used == false) && ($ai.json != null)) {
                                    var.update $component {
                                      value = ($ai.json|get:"component":$component)|first_notempty:$component
                                    }

                                    var.update $recommended_action {
                                      value = ($ai.json|get:"recommended_action":$recommended_action)|first_notempty:$recommended_action
                                    }

                                    var.update $ai_fallback_used {
                                      value = false
                                    }
                                  }
                                }

                                // The model's cause hypothesis is evidence, not fact, so it is filed alongside the fit rather than presented as a measurement.
                                var.update $evidence {
                                  value = ($evidence|set:"ai_model":$ai.model)|set:"ai_fallback_used":$ai_fallback_used
                                }

                                conditional {
                                  if (($ai.json|get:"likely_cause") != null) {
                                    var.update $evidence {
                                      value = $evidence|set:"ai_likely_cause":($ai.json|get:"likely_cause")
                                    }
                                  }
                                }

                                db.add maintenance_prediction {
                                  data = {
                                    created_at          : "now"
                                    device_id           : $device.id
                                    component           : $component
                                    metric_key          : $metric_key
                                    trend_slope         : $slope|round:6
                                    predicted_failure_at: $predicted_failure_at
                                    confidence          : $confidence
                                    evidence            : $evidence
                                    recommended_action  : $recommended_action
                                    state               : "open"
                                  }
                                } as $prediction

                                math.add $predictions_created {
                                  value = 1
                                }

                                array.push $prediction_ids {
                                  value = $prediction.id
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // The fitted-vs-created ratio is the useful number here: a run that fits hundreds of series and creates nothing is a healthy fleet, not a broken task.
    debug.log {
      value = "task_predictive_sweep: scanned " ~ (($devices|count)|to_text) ~ " device(s) (skipped " ~ ($devices_skipped|to_text) ~ " over cap), fitted " ~ ($series_fitted|to_text) ~ " series, created " ~ ($predictions_created|to_text) ~ " prediction(s), skipped " ~ ($duplicates_skipped|to_text) ~ " already-open duplicate(s)."
    }

    // Predictions are the one thing this task creates, so audit only when it created some.
    conditional {
      if ($predictions_created > 0) {
        function.run "Nerve/fn_audit" {
          input = {
            action     : "prediction.sweep"
            entity_type: "maintenance_prediction"
            detail     : {
              predictions_created: $predictions_created
              prediction_ids     : $prediction_ids
              series_fitted      : $series_fitted
              duplicates_skipped : $duplicates_skipped
              devices_scanned    : $devices|count
              devices_skipped    : $devices_skipped
              window_hours       : $window_hours
              horizon_hours      : $horizon_hours
              min_r_squared      : $min_r2
            }
            source     : "task"
          }
        } as $audit
      }
    }
  }

  schedule = [{starts_on: 2026-09-03 00:00:00+0000, freq: 3600}]
  tags = ["nerve"]
}
