// The rule engine, called once per ingested reading. Everything here exists to fire the *fewest* alerts that still describe reality - cooldowns and dedupe are the product, not a nicety.
function "Nerve/fn_evaluate_rules" {
  description = "Evaluates every enabled alert_rule whose scope matches this device against one reading, honouring per-rule cooldowns and firing-alert dedupe, and inserts alert rows for the rules that trip."

  input {
    // The reporting device.
    int device_id { table = "device" }

    // Denormalized from the device so this function does not have to re-read it per call.
    int device_type_id { table = "device_type" }

    // Same reasoning; site scope is the coarsest rule scope.
    int site_id { table = "site" }

    // The wide-format reading: {metric_key: value}.
    json metrics

    // {metric_key: z_score} from fn_update_baseline, consumed by the "anomaly" condition.
    json z_scores?

    // {metric_key: previous_value} from fn_update_baseline's response. Required for correct flatline/rate_of_change results: the caller advances the baseline first (to get z-scores), which overwrites metric_baseline.last_value with the CURRENT reading - so the row can no longer supply the prior one.
    json previous_values?

    // Reading timestamp; defaults to now when the device did not stamp it.
    timestamp? ts?
  }

  stack {
    // A scope column matches when it is null (wildcard) or equal to this device's value. All three scopes are ANDed, so a rule may pin any combination of device, type and site.
    db.query alert_rule {
      where = $db.alert_rule.enabled == true && ($db.alert_rule.device_id == null || $db.alert_rule.device_id == $input.device_id) && ($db.alert_rule.device_type_id == null || $db.alert_rule.device_type_id == $input.device_type_id) && ($db.alert_rule.site_id == null || $db.alert_rule.site_id == $input.site_id)
      return = {type: "list"}
    } as $rules

    // Used for the alert's fired_at and for the rule's last_fired_at, so cooldown maths and the alert timeline agree.
    var $now_ts {
      value = "now"
    }

    // Honour a device-supplied timestamp when there is one - replayed batches must not all collapse onto ingest time.
    conditional {
      if ($input.ts != null) {
        var.update $now_ts {
          value = $input.ts
        }
      }
    }

    // Accumulators; the caller uses these to decide whether to trigger correlation.
    var $alert_ids {
      value = []
    }

    // Count of rules that actually produced an alert on this reading.
    var $alerts_fired {
      value = 0
    }

    // Reported back so a quiet result can be distinguished from "no rules matched this device at all".
    var $rules_evaluated {
      value = $rules|count
    }

    foreach ($rules) {
      each as $rule {
        // The rule's metric may simply be absent from this reading; every condition below treats null as "no opinion".
        var $value {
          value = $input.metrics|get:$rule.metric_key
        }

        // Missing z-score defaults to 0 so an anomaly rule cannot fire on an un-warmed baseline.
        var $z {
          value = $input.z_scores|get:$rule.metric_key:0
        }

        // flatline and rate_of_change need the previous reading, which lives on the baseline row.
        db.query metric_baseline {
          where = $db.metric_baseline.device_id == $input.device_id && $db.metric_baseline.metric_key == $rule.metric_key
          return = {type: "single"}
        } as $baseline

        // Previous value, hoisted so the switch arms stay one-liners. The row is only the fallback: it is correct when rules run before the baseline advance, and stale-by-one-reading when they run after.
        var $prev_value {
          value = $baseline|get:"last_value"
        }

        // A caller-supplied previous value always wins, because only the caller knows whether it already advanced the baseline for this reading.
        conditional {
          if (($input.previous_values|get:$rule.metric_key) != null) {
            var.update $prev_value {
              value = $input.previous_values|get:$rule.metric_key
            }
          }
        }

        // Cooldown. Without this a rule that is genuinely firing mints one alert per reading and buries the operator - the precise alert-fatigue failure Nerve exists to fix.
        var $cooldown_ok {
          value = true
        }

        // A rule that has never fired has nothing to cool down from.
        conditional {
          if ($rule.last_fired_at != null) {
            var $cooldown_ms {
              value = ($rule.cooldown_seconds|first_notnull:0) * 1000
            }

            // Compare in epoch milliseconds; timestamp columns compare cleanly once converted.
            var $cutoff_ms {
              value = ("now"|to_ms) - $cooldown_ms
            }

            var.update $cooldown_ok {
              value = ($rule.last_fired_at|to_ms) < $cutoff_ms
            }
          }
        }

        // Dedupe: an already-firing alert for this rule and device is the same event, not a new one. It gets resolved or acked, never re-raised.
        db.query alert {
          where = $db.alert.alert_rule_id == $rule.id && $db.alert.device_id == $input.device_id && $db.alert.state == "firing"
          return = {type: "exists"}
        } as $already_firing

        // Did the reading actually trip the rule's condition?
        var $hit {
          value = false
        }

        // One arm per alert_rule.condition enum value. "offline" is deliberately absent: it is a *lack* of readings, so the offline sweep task owns it and this per-reading path cannot see it.
        switch ($rule.condition) {
          case ("gt") {
            var.update $hit {
              value = ($value != null) && ($rule.threshold != null) && ($value > $rule.threshold)
            }
          } break

          case ("lt") {
            var.update $hit {
              value = ($value != null) && ($rule.threshold != null) && ($value < $rule.threshold)
            }
          } break

          case ("outside_range") {
            var.update $hit {
              value = ($value != null) && ($rule.threshold != null) && ($rule.threshold_high != null) && (($value < $rule.threshold) || ($value > $rule.threshold_high))
            }
          } break

          case ("anomaly") {
            var.update $hit {
              value = $z > $rule.z_threshold
            }
          } break

          case ("flatline") {
            var.update $hit {
              value = ($value != null) && ($prev_value != null) && ($value == $prev_value)
            }
          } break

          case ("rate_of_change") {
            var.update $hit {
              value = ($value != null) && ($prev_value != null) && ($rule.threshold != null) && ((($value - $prev_value)|abs) > $rule.threshold)
            }
          } break

          default {
            var.update $hit {
              value = false
            }
          }
        }

        // All three gates must pass. Collapsed into one variable so the fire block does not nest three deep.
        var $should_fire {
          value = $hit && $cooldown_ok && ($already_firing == false)
        }

        // Value as text, defaulted, because an anomaly rule can fire on a metric the reading omitted.
        var $value_text {
          value = ($value|first_notnull:0)|to_text
        }

        conditional {
          if ($should_fire) {
            // Human-readable first line: what tripped, on what metric, at what value. The operator should not need the context blob to triage.
            var $message {
              value = $rule.name ~ ": " ~ $rule.metric_key ~ " = " ~ $value_text ~ " on device #" ~ ($input.device_id|to_text)
            }

            // context carries the evidence the AI triage step later reasons over, so it is stored structured rather than prose.
            var $context {
              value = {
                metric_key    : $rule.metric_key
                observed_value: $value
                threshold     : $rule.threshold
                threshold_high: $rule.threshold_high
                z_score       : $z
                z_threshold   : $rule.z_threshold
                condition     : $rule.condition
                rule_name     : $rule.name
                previous_value: $prev_value
              }
            }

            db.add alert {
              data = {
                created_at    : "now"
                alert_rule_id : $rule.id
                device_id     : $input.device_id
                metric_key    : $rule.metric_key
                observed_value: $value
                threshold     : $rule.threshold
                z_score       : $z
                severity      : $rule.severity
                state         : "firing"
                fired_at      : $now_ts
                message       : $message
                context       : $context
              }
            } as $alert

            array.push $alert_ids {
              value = $alert.id
            }

            math.add $alerts_fired {
              value = 1
            }

            // Stamp the rule so the cooldown above has something to measure from next reading, and so the rules UI can show how noisy a rule is.
            db.edit alert_rule {
              field_name = "id"
              field_value = $rule.id
              data = {
                fire_count   : ($rule.fire_count|first_notnull:0) + 1
                last_fired_at: $now_ts
              }
            } as $bumped_rule
          }
        }
      }
    }
  }

  response = {
    alerts_fired   : $alerts_fired
    alert_ids      : $alert_ids
    rules_evaluated: $rules_evaluated
  }
  tags = ["nerve"]
  guid = "Gq9OWH_75YD1ZWcV4XAphFfutr4"
}
