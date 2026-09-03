// The one detector that cannot live on the ingest path: "stopped reporting" is the absence of a reading, so only a clock can notice it. This is also the task that turns a dead gateway into a single incident - it flips the whole downstream tree offline within a minute, and fn_correlate then groups those alerts under the gateway's uplink key.
task task_offline_sweep {
  description = "Every 60s, flips devices whose heartbeat is older than their device type's offline_after_seconds to status offline, fires one deduped offline alert per device honouring any matching offline rule's cooldown, and recomputes health."
  active = true

  stack {
    // Only devices that could still transition. Already-offline devices have nothing to detect and maintenance is an engineer's explicit hold that this task must never overrule.
    // last_seen_at != null is deliberate: a device that has never reported has nothing to go *offline* from, and flipping freshly created provisioning rows would page someone about hardware that was never plugged in.
    db.query device {
      where = $db.device.status != "offline" && $db.device.status != "maintenance" && $db.device.last_seen_at != null
      sort = {device.last_seen_at: "asc"}
      return = {type: "list", paging: {page: 1, per_page: 500, totals: true}}
      output = ["items.id", "items.name", "items.serial", "items.status", "items.device_type_id", "items.site_id", "items.last_seen_at", "itemsTotal"]
    } as $page

    // Stalest first plus a hard cap means an overloaded run degrades into "the worst 500 get handled this minute", not into an unbounded scan that outlives its own 60s interval.
    var $candidates {
      value = $page.items|safe_array
    }

    // Reported in the audit row so a fleet that has outgrown one sweep is visible rather than silently under-swept.
    var $skipped {
      value = ($page.itemsTotal|first_notnull:0) - ($candidates|count)
    }

    // Wall clock, sampled once so every device in this sweep is judged against the same instant.
    var $now_ms {
      value = "now"|to_ms
    }

    // Counters for the audit detail.
    var $marked_offline {
      value = 0
    }

    // Alerts actually minted this sweep; the gap between this and $marked_offline is the dedupe and cooldown doing their job.
    var $alerts_fired {
      value = 0
    }

    // Names, so the audit row is readable without joining back to device.
    var $offline_devices {
      value = []
    }

    foreach ($candidates) {
      each as $device {
        // The staleness threshold belongs to the type: a mains-powered gateway silent for 5 minutes is dead, a battery sensor on a 15-minute duty cycle is fine.
        db.get device_type {
          field_name = "id"
          field_value = $device.device_type_id
        } as $device_type

        // Schema default, so a half-configured type cannot make an entire class of devices look dead.
        var $offline_after {
          value = ($device_type|get:"offline_after_seconds"|first_notnull:300)|to_int
        }

        // Epoch-ms arithmetic keeps timezones out of the comparison entirely.
        var $age_seconds {
          value = ($now_ms - ($device.last_seen_at|to_ms)) / 1000
        }

        conditional {
          if ($age_seconds > $offline_after) {
            // Written before the alert so that if this run dies mid-loop, the device's status already reflects reality.
            db.edit device {
              field_name = "id"
              field_value = $device.id
              data = {status: "offline"}
            } as $offlined

            math.add $marked_offline {
              value = 1
            }

            array.push $offline_devices {
              value = $device.name
            }

            // An operator-authored offline rule supplies the severity and the cooldown. There may be several matching scopes; the first is taken rather than firing one alert per matching rule, because the device being unreachable is one event no matter how many rules describe it.
            db.query alert_rule {
              where = $db.alert_rule.enabled == true && $db.alert_rule.condition == "offline" && ($db.alert_rule.device_id == null || $db.alert_rule.device_id == $device.id) && ($db.alert_rule.device_type_id == null || $db.alert_rule.device_type_id == $device.device_type_id) && ($db.alert_rule.site_id == null || $db.alert_rule.site_id == $device.site_id)
              return = {type: "single"}
            } as $rule

            // No configured rule still means an alert: unreachable hardware is not an opinion, so the fleet is protected out of the box. Critical is the right default - the device is not reporting at all.
            var $severity {
              value = "critical"
            }

            // Cooldown seconds only exist when a rule does.
            var $cooldown_seconds {
              value = 900
            }

            conditional {
              if ($rule != null) {
                var.update $severity {
                  value = $rule.severity|first_notempty:"critical"
                }

                var.update $cooldown_seconds {
                  value = ($rule.cooldown_seconds|first_notnull:900)|to_int
                }
              }
            }

            // Dedupe is keyed on the device and the "offline" sentinel metric rather than on the rule, so the same silence cannot be raised twice by two matching rules - and, more importantly, cannot be re-raised every 60 seconds for the rest of the outage. This is the whole reason the task is safe to run at 1-minute cadence.
            db.query alert {
              where = $db.alert.device_id == $device.id && $db.alert.metric_key == "offline" && $db.alert.state == "firing"
              return = {type: "exists"}
            } as $already_firing

            // Second gate: a rule that fired recently for anything stays quiet, matching fn_evaluate_rules' contract so an operator's cooldown means the same thing on both paths.
            var $cooldown_ok {
              value = true
            }

            conditional {
              if ($rule != null && $rule.last_fired_at != null) {
                var.update $cooldown_ok {
                  value = ($rule.last_fired_at|to_ms) < ($now_ms - ($cooldown_seconds * 1000))
                }
              }
            }

            conditional {
              if ($already_firing == false && $cooldown_ok) {
                // context carries what fn_correlate's prompt and the incident view reason over. Structured, not prose, because the AI triage step consumes it.
                var $context {
                  value = {
                    metric_key           : "offline"
                    condition            : "offline"
                    age_seconds          : $age_seconds|round:0
                    offline_after_seconds: $offline_after
                    last_seen_at         : $device.last_seen_at
                    serial               : $device.serial
                    previous_status      : $device.status
                    rule_name            : $rule|get:"name"|first_notempty:"built-in offline detection"
                  }
                }

                // metric_key is the sentinel "offline" rather than a real metric: it is what the dedupe query above matches on, and it reads correctly in the alert list.
                db.add alert {
                  data = {
                    created_at    : "now"
                    alert_rule_id : $rule|get:"id"
                    device_id     : $device.id
                    metric_key    : "offline"
                    observed_value: $age_seconds|round:0
                    threshold     : $offline_after
                    severity      : $severity
                    state         : "firing"
                    fired_at      : "now"
                    message       : $device.name ~ " (" ~ $device.serial ~ ") has not reported for " ~ (($age_seconds|round:0)|to_text) ~ "s, past its " ~ ($offline_after|to_text) ~ "s threshold."
                    context       : $context
                  }
                } as $alert

                math.add $alerts_fired {
                  value = 1
                }

                // Stamp the rule so its cooldown has something to measure from, and so the rules UI can show how noisy it is. Only when a rule actually drove the decision.
                conditional {
                  if ($rule != null) {
                    db.edit alert_rule {
                      field_name = "id"
                      field_value = $rule.id
                      data = {
                        fire_count   : ($rule.fire_count|first_notnull:0) + 1
                        last_fired_at: "now"
                      }
                    } as $bumped_rule
                  }
                }
              }
            }

            // Last, so the new firing alert is already in the table and counts against the score. fn_compute_health re-derives "offline" from the same staleness rule, so it confirms the status set above rather than fighting it.
            function.run "Nerve/fn_compute_health" {
              input = {device_id: $device.id}
            } as $health
          }
        }
      }
    }

    // A run that changes nothing is the normal case and must stay cheap; the log line is how a demo shows the sweep is alive.
    debug.log {
      value = "task_offline_sweep: scanned " ~ (($candidates|count)|to_text) ~ " device(s), marked " ~ ($marked_offline|to_text) ~ " offline, fired " ~ ($alerts_fired|to_text) ~ " alert(s), skipped " ~ ($skipped|to_text) ~ " over the per-run cap."
    }

    // Only audit real transitions - a per-minute "nothing changed" row would bury the entries a human actually needs.
    conditional {
      if ($marked_offline > 0) {
        function.run "Nerve/fn_audit" {
          input = {
            action     : "device.offline_sweep"
            entity_type: "device"
            detail     : {
              marked_offline    : $marked_offline
              alerts_fired      : $alerts_fired
              devices           : $offline_devices
              scanned           : $candidates|count
              skipped_over_cap  : $skipped
            }
            source     : "task"
          }
        } as $audit
      }
    }
  }

  schedule = [{starts_on: 2026-09-03 00:00:00+0000, freq: 60}]
  tags = ["nerve"]
}
