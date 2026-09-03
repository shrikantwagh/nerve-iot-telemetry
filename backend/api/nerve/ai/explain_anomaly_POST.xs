// "The tool shows you a red graph and stops" is one of the things Nerve exists to fix. This endpoint takes a device, a metric and a window, computes the shape of the series deterministically, and asks Claude to name that shape, judge whether it is a real fault or sensor noise, and say what to check - returning the numeric inputs alongside the claim so the model's evidence is visible next to its conclusion.
query "ai/explain-anomaly" verb=POST {
  api_group = "Nerve"
  auth = "user"
  description = "Explains the shape of one metric on one device over a recent window. Pulls the metric_rollup series, the device's EWMA/EWMV baseline and the nominal band declared by the device type's metric_schema, computes a deterministic shape classification (flatline, step, ramp, oscillation, spike train or noise), then asks Claude to interpret it. The numeric series summary is returned with the explanation so the UI can show the model's inputs beside its claim."

  input {
    // The device whose metric is being explained.
    int device_id {
      table = "device"
    }

    // Which metric. Validated against the metric keys the device's own type declares, so a typo does not silently return an empty series.
    text metric_key filters=trim

    // How far back to look. Six hours is wide enough to show a shape and narrow enough that 5-minute buckets stay readable.
    int window_hours?=6
  }

  stack {
    // Reported to the UI; fn_claude logs its own latency on the insight row.
    var $started_ms {
      value = "now"|to_ms
    }

    // Read-only endpoint, open to every role including the demo account, but the token still has to resolve.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user not found."
    }

    // Window clamp. Under an hour there is no shape to see; beyond a week the 5-minute buckets stop fitting in a prompt.
    var $hours {
      value = $input.window_hours
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

    db.get device {
      field_name = "id"
      field_value = $input.device_id
    } as $device

    // A missing device is a bad request, not an empty explanation.
    precondition ($device != null) {
      error_type = "notfound"
      error = "Device not found."
    }

    // The type carries the metric_schema, which is where the nominal band and the unit come from. Without it the model has no idea whether 40 is hot.
    db.get device_type {
      field_name = "id"
      field_value = $device.device_type_id
    } as $device_type

    // Site name, so the explanation can be read without cross-referencing another screen.
    db.get site {
      field_name = "id"
      field_value = $device.site_id
    } as $site

    // Metric descriptor, resolved out of the type's declared schema.
    var $metric_def {
      value = null
    }

    // Every key this type declares, used both for validation and for the error message when validation fails.
    var $known_keys {
      value = []
    }

    // Hoisted so foreach iterates a plain variable; safe_array so a type with no schema does not break the loop.
    var $schema {
      value = ($device_type|get:"metric_schema"|safe_array)|safe_array
    }

    foreach ($schema) {
      each as $metric {
        var $mkey {
          value = ($metric|get:"key"|first_notempty:"")|to_text
        }

        array.push $known_keys {
          value = $mkey
        }

        conditional {
          if ($mkey == $input.metric_key) {
            var.update $metric_def {
              value = $metric
            }
          }
        }
      }
    }

    // A key the type does not declare is rejected rather than answered with an empty series - "no data" and "wrong metric name" look identical in a chart and only one of them is the caller's fault.
    precondition (($known_keys|count) == 0 || ($known_keys|in:$input.metric_key)) {
      error_type = "inputerror"
      error = "Metric '" ~ $input.metric_key ~ "' is not declared by this device's type. Declared metrics: " ~ ($known_keys|join:", ") ~ "."
    }

    // Nominal band from the schema. Null when the type declares the metric without a band, which is a legitimate state and is reported rather than defaulted to a made-up range.
    var $nominal_min {
      value = $metric_def|get:"nominal_min"
    }

    // Upper end of the same band.
    var $nominal_max {
      value = $metric_def|get:"nominal_max"
    }

    // Unit and label are prompt material only - they let the model say "3 degrees above" instead of "3 above".
    var $unit {
      value = ($metric_def|get:"unit"|first_notempty:"")|to_text
    }

    // Human label for the metric, falling back to the key itself.
    var $label {
      value = ($metric_def|get:"label"|first_notnull:$input.metric_key)|to_text
    }

    // Negated first, because add_secs_to_timestamp takes an int and the negation cannot be written inline in the filter argument.
    var $window_negative {
      value = 0 - ($hours * 3600)
    }

    var $cutoff {
      value = "now"|add_secs_to_timestamp:$window_negative
    }

    // The series itself: pre-folded 5-minute buckets rather than raw telemetry, which is exactly why metric_rollup exists. Ascending, because a shape is read left to right.
    db.query metric_rollup {
      where = $db.metric_rollup.device_id == $input.device_id && $db.metric_rollup.metric_key == $input.metric_key && $db.metric_rollup.bucket_ts >= $cutoff
      sort = {metric_rollup.bucket_ts: "asc"}
      return = {type: "list", paging: {page: 1, per_page: 500}}
    } as $rollup_page

    var $buckets {
      value = $rollup_page.items|safe_array
    }

    // The learned baseline the anomaly condition compares against. Its sample_count is what says whether a z-score means anything yet.
    db.query metric_baseline {
      where = $db.metric_baseline.device_id == $input.device_id && $db.metric_baseline.metric_key == $input.metric_key
      return = {type: "single"}
    } as $baseline

    // DETERMINISTIC SERIES ANALYSIS. Everything below is computed from the buckets, not asked of the model: the model is being asked to interpret a shape, and it should be interpreting the same numbers the UI will draw.
    var $values {
      value = []
    }

    // Bucket timestamps as text, so the prompt can state when a change happened.
    var $times {
      value = []
    }

    // Compact "time=value" lines, which is what the model actually reasons over.
    var $series_lines {
      value = []
    }

    // How many buckets sat outside the type's declared nominal band. Zero with a dramatic shape means "moving but still in spec".
    var $out_of_band {
      value = 0
    }

    // Average of the per-bucket stddev column: within-bucket jitter, which is the signature of sensor noise as opposed to a real excursion.
    var $stddev_total {
      value = 0
    }

    // Readings folded into the window, so a shape drawn from four samples is not presented as if it were drawn from four hundred.
    var $samples_total {
      value = 0
    }

    foreach ($buckets) {
      each as $bucket {
        var $v {
          value = ($bucket.avg_value|first_notnull:0)|to_decimal
        }

        array.push $values {
          value = $v
        }

        var $t {
          value = $bucket.bucket_ts|format_timestamp:"m-d H:i":"UTC"
        }

        array.push $times {
          value = $t
        }

        array.push $series_lines {
          value = $t ~ "=" ~ ($v|to_text)
        }

        math.add $stddev_total {
          value = ($bucket.stddev|first_notnull:0)
        }

        math.add $samples_total {
          value = ($bucket.sample_count|first_notnull:0)
        }

        // Band membership is only checkable when the type actually declared a band.
        conditional {
          if (($nominal_max != null) && ($v > $nominal_max)) {
            math.add $out_of_band {
              value = 1
            }
          }
          elseif (($nominal_min != null) && ($v < $nominal_min)) {
            math.add $out_of_band {
              value = 1
            }
          }
        }
      }
    }

    // Bucket count gates every derived statistic below; a two-bucket series has no shape and must not be given one.
    var $n {
      value = $values|count
    }

    // Series extremes and endpoints. Defaulted to 0 so a caller reading the response never meets a null where it expects a number.
    var $v_min {
      value = 0
    }

    // Upper extreme.
    var $v_max {
      value = 0
    }

    // Mean over the window.
    var $v_avg {
      value = 0
    }

    // First bucket, the left end of the shape.
    var $v_first {
      value = 0
    }

    // Last bucket, the right end - and the value an operator is actually looking at right now.
    var $v_last {
      value = 0
    }

    conditional {
      if ($n > 0) {
        var.update $v_min {
          value = ($values|sort)|first
        }

        var.update $v_max {
          value = ($values|sort)|last
        }

        var.update $v_avg {
          value = ($values|avg)|round:4
        }

        var.update $v_first {
          value = $values|first
        }

        var.update $v_last {
          value = $values|last
        }
      }
    }

    // Peak-to-trough travel. Every shape test below is expressed as a fraction of this, so the classifier works the same on a metric measured in degrees and one measured in volts.
    var $span {
      value = $v_max - $v_min
    }

    // Net movement across the window: large relative to the span means a trend, small means the series came back to where it started.
    var $net_change {
      value = $v_last - $v_first
    }

    // Largest single bucket-to-bucket jump, which is what separates a step from a ramp.
    var $max_step {
      value = 0
    }

    // Direction reversals between consecutive deltas - the signature of oscillation.
    var $direction_flips {
      value = 0
    }

    // Sum of absolute deltas; compared against the net change to measure how much of the movement was wasted going back and forth.
    var $total_travel {
      value = 0
    }

    // Sign of the previous delta: 1 up, -1 down, 0 not yet established.
    var $prev_sign {
      value = 0
    }

    // Previous bucket value, carried through the loop by hand because a foreach has no index.
    var $prev_value {
      value = null
    }

    foreach ($values) {
      each as $value {
        conditional {
          if ($prev_value != null) {
            var $delta {
              value = $value - $prev_value
            }

            var $abs_delta {
              value = $delta|abs
            }

            math.add $total_travel {
              value = $abs_delta
            }

            // High-water mark rather than a max filter: the scalar min/max filter aliases are rejected by the language server.
            conditional {
              if ($abs_delta > $max_step) {
                var.update $max_step {
                  value = $abs_delta
                }
              }
            }

            // Sign of this step, with exact equality treated as "no direction" so a flat stretch does not register as a reversal.
            var $sign {
              value = 0
            }

            conditional {
              if ($delta > 0) {
                var.update $sign {
                  value = 1
                }
              }
              elseif ($delta < 0) {
                var.update $sign {
                  value = -1
                }
              }
            }

            // A reversal needs both signs to be non-zero and opposite.
            conditional {
              if (($sign != 0) && ($prev_sign != 0) && ($sign != $prev_sign)) {
                math.add $direction_flips {
                  value = 1
                }
              }
            }

            conditional {
              if ($sign != 0) {
                var.update $prev_sign {
                  value = $sign
                }
              }
            }
          }
        }

        var.update $prev_value {
          value = $value
        }
      }
    }

    // Within-bucket jitter, averaged. Guarded division so an empty series reports 0.
    var $avg_stddev {
      value = 0
    }

    conditional {
      if ($n > 0) {
        var.update $avg_stddev {
          value = (($stddev_total / $n)|round:4)
        }
      }
    }

    // Baseline figures, defaulted so the response shape is stable whether or not a baseline row exists yet.
    var $ewma {
      value = $baseline|get:"ewma"
    }

    // Exponentially weighted variance; its square root is the sigma a z-score is measured in.
    var $ewmv {
      value = $baseline|get:"ewmv"
    }

    // Readings folded into the baseline. Under about 20 the z-score is not yet meaningful, which the prompt is told explicitly.
    var $baseline_samples {
      value = ($baseline|get:"sample_count"|first_notnull:0)|to_int
    }

    // Sigma, computed only when the variance is positive - sqrt of 0 is a divide-by-zero waiting to happen one line later.
    var $sigma {
      value = 0
    }

    conditional {
      if (($ewmv != null) && ($ewmv > 0)) {
        var.update $sigma {
          value = ($ewmv|sqrt)|round:4
        }
      }
    }

    // How far the latest bucket sits from the device's own learned normal, in sigmas. This is the number the anomaly rule condition fires on.
    var $z_last {
      value = 0
    }

    conditional {
      if (($sigma > 0) && ($ewma != null) && ($n > 0)) {
        var.update $z_last {
          value = ((($v_last - $ewma)|abs) / $sigma)|round:3
        }
      }
    }

    // SHAPE CLASSIFICATION, deterministic and ordered from most specific to least. Thresholds are fractions of the span so the classifier is unit-free. This is the fallback answer AND the prompt's starting hypothesis - the model is asked to confirm or correct a named shape rather than to invent one from scratch, which is a far easier question to answer honestly.
    var $shape {
      value = "insufficient_data"
    }

    // Prose form of the classification, reused verbatim in the deterministic explanation.
    var $shape_reason {
      value = "Fewer than four buckets in the window, which is not enough to describe a shape."
    }

    conditional {
      if ($n >= 4) {
        conditional {
          if ($span == 0) {
            var.update $shape {
              value = "flatline"
            }

            var.update $shape_reason {
              value = "Every bucket in the window holds the identical value " ~ ($v_last|to_text) ~ ", so the metric is not moving at all."
            }
          }
          elseif ($direction_flips >= ($n / 3)) {
            var.update $shape {
              value = "oscillation"
            }

            var.update $shape_reason {
              value = ($direction_flips|to_text) ~ " direction reversals across " ~ ($n|to_text) ~ " buckets, with total travel " ~ ($total_travel|to_text) ~ " against a net change of only " ~ ($net_change|to_text) ~ " - the series is going back and forth rather than anywhere."
            }
          }
          elseif ($max_step >= ($span * 0.6)) {
            var.update $shape {
              value = "step"
            }

            var.update $shape_reason {
              value = "A single bucket-to-bucket jump of " ~ ($max_step|to_text) ~ " accounts for most of the window's " ~ ($span|to_text) ~ " span, so the metric changed level abruptly rather than drifting."
            }
          }
          elseif (($net_change|abs) >= ($span * 0.6)) {
            var.update $shape {
              value = "ramp"
            }

            var.update $shape_reason {
              value = "Net change of " ~ ($net_change|to_text) ~ " over " ~ ($n|to_text) ~ " buckets in the same direction, with no single jump dominating - the metric is drifting steadily."
            }
          }
          elseif ($max_step >= ($span * 0.35)) {
            var.update $shape {
              value = "spike_train"
            }

            var.update $shape_reason {
              value = "Repeated excursions of up to " ~ ($max_step|to_text) ~ " that return towards the mean of " ~ ($v_avg|to_text) ~ ", rather than a sustained level change."
            }
          }
          else {
            var.update $shape {
              value = "noise"
            }

            var.update $shape_reason {
              value = "Movement of " ~ ($span|to_text) ~ " with no dominant step, trend or reversal pattern, and average within-bucket jitter of " ~ ($avg_stddev|to_text) ~ " - this looks like ordinary variation."
            }
          }
        }
      }
    }

    // The numeric summary. Returned to the caller AND stored on the insight's payload, so the UI can render the model's inputs alongside its claim and a reviewer can check the arithmetic later.
    var $series_summary {
      value = {
        metric_key           : $input.metric_key
        metric_label         : $label
        unit                 : $unit
        window_hours         : $hours
        window_from          : $cutoff|format_timestamp:"Y-m-d H:i:s":"UTC"
        window_to            : "now"|format_timestamp:"Y-m-d H:i:s":"UTC"
        bucket_count         : $n
        readings_folded      : $samples_total
        first_value          : $v_first
        last_value           : $v_last
        min_value            : $v_min
        max_value            : $v_max
        avg_value            : $v_avg
        span                 : $span
        net_change           : $net_change
        max_single_step      : $max_step
        direction_flips      : $direction_flips
        total_travel         : $total_travel
        avg_within_bucket_sd : $avg_stddev
        buckets_out_of_band  : $out_of_band
        nominal_min          : $nominal_min
        nominal_max          : $nominal_max
        baseline_ewma        : $ewma
        baseline_ewmv        : $ewmv
        baseline_sigma       : $sigma
        baseline_samples     : $baseline_samples
        z_of_last_bucket     : $z_last
        detected_shape       : $shape
        shape_reason         : $shape_reason
      }
    }

    // Context lines the model needs but that are not part of the numeric summary.
    var $device_line {
      value = ($device.name|to_text) ~ " [" ~ ($device.serial|to_text) ~ "], type " ~ (($device_type|get:"name"|first_notempty:"unknown")|to_text) ~ " (category " ~ (($device_type|get:"category"|first_notempty:"other")|to_text) ~ "), site " ~ (($site|get:"name"|first_notempty:"unknown")|to_text) ~ ", status " ~ ($device.status|to_text) ~ ", health " ~ (($device.health_score|first_notnull:0)|to_text)
    }

    // DETERMINISTIC EXPLANATION, written before the inference is attempted. It is what ships with no API key or on a 429, and it says only what the arithmetic supports.
    var $explanation {
      value = $label ~ " on " ~ ($device.name|to_text) ~ " over the last " ~ ($hours|to_text) ~ "h reads as a " ~ $shape ~ ". " ~ $shape_reason ~ " Latest value " ~ ($v_last|to_text) ~ " " ~ $unit ~ ", window range " ~ ($v_min|to_text) ~ " to " ~ ($v_max|to_text) ~ ", " ~ ($out_of_band|to_text) ~ " of " ~ ($n|to_text) ~ " bucket(s) outside the declared nominal band."
    }

    // Fault versus noise. Left as an explicit "unclear" rather than forced into a binary the numbers do not support.
    var $verdict {
      value = "unclear"
    }

    // Deterministic confidence is deliberately low: a shape classifier is a strong signal about form and a weak one about cause.
    var $confidence {
      value = 0.35
    }

    // What to check, defaulted to something actionable so the panel is never empty.
    var $checks {
      value = ["Compare this metric against the device's own baseline and against a sibling device of the same type at the same site.", "Confirm the sensor is reporting at its expected cadence before treating the shape as physical."]
    }

    // A flatline on a metric that should move is a stuck sensor far more often than a perfectly stable machine, so it gets its own verdict.
    conditional {
      if ($shape == "flatline") {
        var.update $verdict {
          value = "sensor_suspected"
        }

        var.update $checks {
          value = ["Verify the sensor is still sampling rather than repeating its last value.", "Check the device's firmware version and last_seen_at for a partial stall.", "Compare against another device of the same type at the same site - if only this one is flat, suspect the sensor."]
        }
      }
      elseif (($shape == "noise") && ($out_of_band == 0)) {
        var.update $verdict {
          value = "normal"
        }

        var.update $confidence {
          value = 0.5
        }

        var.update $checks {
          value = ["No action indicated: the metric is moving within its declared nominal band with no dominant pattern."]
        }
      }
      elseif ((($shape == "step") || ($shape == "ramp")) && ($out_of_band > 0)) {
        var.update $verdict {
          value = "fault_suspected"
        }

        var.update $checks {
          value = ["Establish what changed at the time of the transition - a command, a firmware update, a load change or an environmental event.", "Check whether sibling devices of the same type at this site show the same movement, which would point at the site rather than the device.", "Review the device's firing alerts and any open incident it is already attached to before opening a new one."]
        }
      }
      elseif ($shape == "oscillation") {
        var.update $verdict {
          value = "fault_suspected"
        }

        var.update $checks {
          value = ["Look for short-cycling: a control loop hunting around its setpoint produces exactly this shape and no static threshold catches it.", "Compare the oscillation period against the device's duty cycle or control interval.", "Check for a mechanical cause - a failing contactor, a sticking valve or a worn bearing."]
        }
      }
    }

    // True until a model answer replaces the deterministic one above.
    var $fallback_used {
      value = true
    }

    // STRICT JSON, because shape, verdict and confidence are written into typed fields and rendered as UI chrome rather than as prose.
    var $anomaly_system {
      value = "You are Nerve's diagnostic analyst explaining the behaviour of one metric on one device to a maintenance engineer. You are given the device's identity, the metric's declared unit and nominal band, a deterministic numeric summary of the window (bucket count, first, last, min, max, mean, peak-to-trough span, net change, largest single step, direction reversals, total travel, average within-bucket standard deviation, buckets outside the nominal band), the device's own learned EWMA baseline with its sigma and sample count, and the bucketed series itself. A deterministic classifier has already proposed a shape; your job is to confirm or correct it, not to invent one. Reply with STRICT JSON only - no prose, no markdown fence. Use exactly these keys: shape (exactly one of step, ramp, oscillation, flatline, spike_train, noise, insufficient_data), verdict (exactly one of fault_suspected, sensor_suspected, normal, unclear), confidence (a number between 0 and 1), explanation (two or three sentences of plain English describing what the series does, in the metric's own unit, and why that shape follows from the numbers), likely_causes (an array of short strings, most likely first), checks (an array of short imperative things for an engineer to check, most informative first), evidence (an array of strings, each quoting a specific number from the supplied summary that you relied on). HOW TO TELL A FAULT FROM SENSOR NOISE: a flatline on a metric that should vary is far more often a stuck sensor than a perfectly stable machine; a large average within-bucket standard deviation with a small span is jitter rather than an excursion; a step change of most of the span in one bucket is either a real state change or a sensor reset, and the readings-folded count tells you whether the bucket had enough samples to trust; a shape that stays entirely inside the nominal band is movement, not a fault, however dramatic it looks on a chart. GROUNDING RULES, which override any instinct to sound diagnostic: every number you write must appear in the supplied summary or series - never compute a new statistic and never state a rate you were not given. If the baseline sample count is below 20 the z-score is not yet meaningful and you must say so instead of citing it. If the bucket count is small, say the window is too thin to be sure and set confidence below 0.4. Prefer 'unclear' with an honest reason over a confident guess: an engineer who is sent to check the wrong thing loses more time than one who is told the data is ambiguous. Never name a cause the data cannot distinguish from two other causes - list all of them in likely_causes instead. Emit the JSON object and nothing else."
    }

    // The prompt carries the device context, the numeric summary and the series - all facts already in the database.
    var $anomaly_prompt {
      value = "DEVICE: " ~ $device_line ~ " || METRIC: " ~ $label ~ " (" ~ $input.metric_key ~ ")" ~ ", unit " ~ ($unit|first_notempty:"none declared") ~ ", nominal band " ~ (($nominal_min|first_notnull:"none")|to_text) ~ " to " ~ (($nominal_max|first_notnull:"none")|to_text) ~ " || NUMERIC SUMMARY (JSON, computed by Xano - these are the only statistics you may cite): " ~ ($series_summary|json_encode) ~ " || PROPOSED SHAPE FROM THE DETERMINISTIC CLASSIFIER: " ~ $shape ~ " because " ~ $shape_reason ~ " || SERIES (UTC bucket=value, 5-minute buckets, oldest first): " ~ (($series_lines|slice:0:200)|join:"; ")
    }

    function.run "Nerve/fn_claude" {
      input = {
        system     : $anomaly_system
        user_prompt: $anomaly_prompt
        max_tokens : 1100
        kind       : "anomaly_explanation"
        device_id  : $input.device_id
        title      : "Anomaly explanation: " ~ $input.metric_key ~ " on " ~ ($device.name|to_text)
        expect_json: true
      }
    } as $ai

    // Model answer accepted only when it actually parsed. Anything else keeps the deterministic analysis, which is derived from the same numbers and is never empty.
    var $likely_causes {
      value = []
    }

    conditional {
      if (($ai.fallback_used == false) && ($ai.json != null)) {
        var.update $explanation {
          value = $ai.json|get:"explanation"|first_notnull:$explanation
        }

        // The model may correct the classifier; the classifier's own answer stays in series_summary.detected_shape so the two can be compared.
        var.update $shape {
          value = ($ai.json|get:"shape"|first_notnull:$shape)|to_text
        }

        var.update $verdict {
          value = ($ai.json|get:"verdict"|first_notnull:$verdict)|to_text
        }

        var.update $confidence {
          value = ($ai.json|get:"confidence"|first_notnull:0.35)|to_decimal
        }

        var.update $checks {
          value = ($ai.json|get:"checks"|first_notnull:$checks)|safe_array
        }

        var.update $likely_causes {
          value = ($ai.json|get:"likely_causes"|safe_array)|safe_array
        }

        var.update $fallback_used {
          value = false
        }
      }
    }

    // Evidence: the model's own quoted numbers when it supplied them, otherwise the classifier's reasoning. Either way the response carries the basis for the claim.
    var $evidence {
      value = [$shape_reason]
    }

    conditional {
      if (($ai.fallback_used == false) && ($ai.json != null)) {
        var.update $evidence {
          value = ($ai.json|get:"evidence"|first_notnull:$evidence)|safe_array
        }
      }
    }

    // fn_claude wrote the insight row with whatever text came back - "" on the fallback path. Rewriting it here guarantees the stored insight is never empty and attaches the numeric summary the claim was derived from, so the explanation and its inputs travel together in the ai_insight feed.
    db.edit ai_insight {
      field_name = "id"
      field_value = $ai.insight_id
      data = {
        body         : $explanation
        confidence   : $confidence
        fallback_used: $fallback_used
        payload      : {
          shape         : $shape
          verdict       : $verdict
          likely_causes : $likely_causes
          checks        : $checks
          evidence      : $evidence
          series_summary: $series_summary
        }
      }
    } as $written

    var $latency_ms {
      value = ("now"|to_ms) - $started_ms
    }

    // Series returned to the caller, bounded so a week-long window does not ship 2000 buckets to a chart that can draw 200.
    var $series_out {
      value = $buckets|slice:0:200
    }
  }

  response = {
    success       : true
    device_id     : $input.device_id
    device_name   : $device.name
    metric_key    : $input.metric_key
    shape         : $shape
    verdict       : $verdict
    confidence    : $confidence
    explanation   : $explanation
    likely_causes : $likely_causes
    checks        : $checks
    evidence      : $evidence
    series_summary: $series_summary
    series        : $series_out
    fallback_used : $fallback_used
    model         : $ai.model
    insight_id    : $ai.insight_id
    latency_ms    : $latency_ms
  }
  tags = ["nerve"]
  guid = "gmcY3JoKSrD-fo2cM0ZM7UFrSCE"
}
