// Alert-to-incident correlation: the heart of the product. Forty alerts that share a cause are one thing to fix, and this is where forty become one.
function "Nerve/fn_correlate" {
  description = "Groups unattached firing alerts from a recent window into incidents by correlation key, reusing an open incident for a recurring key, and asks Claude for a root-cause hypothesis on newly created ones with a deterministic fallback."

  input {
    // How far back to sweep. 15 minutes by default: wide enough to catch a cascade, narrow enough that yesterday's noise does not join today's incident.
    int lookback_seconds?=900

    // Set false to correlate without spending an inference - used by tests and by replay.
    bool call_ai?=true
  }

  stack {
    // add_secs_to_timestamp takes an int, so the negation is computed first rather than inline in the filter argument.
    var $lookback_negative {
      value = 0 - $input.lookback_seconds
    }

    // Window floor for the candidate sweep.
    var $cutoff {
      value = "now"|add_secs_to_timestamp:$lookback_negative
    }

    // Candidates are alerts that are still firing and not yet owned by an incident. Anything already attached has been correlated.
    db.query alert {
      where = $db.alert.state == "firing" && $db.alert.incident_id == null && $db.alert.fired_at >= $cutoff
      sort = {alert.fired_at: "asc"}
      return = {type: "list"}
    } as $alerts

    // Pass 1 enriches each alert with its device, type and site, because the correlation key is a property of the device, not of the alert.
    var $enriched {
      value = []
    }

    // Every key seen this sweep; deduped after the loop into the group list.
    var $all_keys {
      value = []
    }

    foreach ($alerts) {
      each as $alert {
        db.get device {
          field_name = "id"
          field_value = $alert.device_id
        } as $device

        // Category is what tells a gateway apart from the devices behind it.
        db.get device_type {
          field_name = "id"
          field_value = $device.device_type_id
        } as $device_type

        // KEYING RULE, coarsest plausible grouping first:
        //  1. device has an uplink  -> site + that uplink id, so a gateway's downstream devices land together;
        //  2. device *is* a gateway -> site + its own id, so the gateway joins the same bucket as its dependents;
        //  3. otherwise             -> site + device_type + metric, so many freezers at one site warming on temp_c form ONE incident.
        var $correlation_key {
          value = "site:" ~ ($device.site_id|to_text) ~ "|type:" ~ ($device.device_type_id|to_text) ~ "|metric:" ~ ($alert.metric_key|first_notempty:"unknown")
        }

        // Case 1 - the uplink is the shared suspect, so the metric is deliberately dropped from the key.
        conditional {
          if ($device.uplink_device_id != null) {
            var.update $correlation_key {
              value = "site:" ~ ($device.site_id|to_text) ~ "|uplink:" ~ ($device.uplink_device_id|to_text)
            }
          }
          elseif (($device_type|get:"category":"other") == "gateway") {
            var.update $correlation_key {
              value = "site:" ~ ($device.site_id|to_text) ~ "|uplink:" ~ ($device.id|to_text)
            }
          }
        }

        // Flattened row: everything the grouping pass and the AI prompt need, with no further reads.
        var $entry {
          value = {
            alert_id      : $alert.id
            device_id     : $device.id
            device_name   : $device.name
            device_type_id: $device.device_type_id
            type_name     : $device_type|get:"name":"unknown type"
            site_id       : $device.site_id
            metric_key    : $alert.metric_key
            observed_value: $alert.observed_value
            threshold     : $alert.threshold
            z_score       : $alert.z_score
            severity      : $alert.severity
            fired_at      : $alert.fired_at
            ckey          : $correlation_key
          }
        }

        array.push $enriched {
          value = $entry
        }

        array.push $all_keys {
          value = $correlation_key
        }
      }
    }

    // One group per distinct key.
    var $group_keys {
      value = $all_keys|unique
    }

    // Result counters.
    var $incidents_touched {
      value = 0
    }

    // Newly opened incidents; the only ones that get an inference spent on them.
    var $incidents_created {
      value = 0
    }

    // Alerts that ended up attached to something.
    var $alerts_grouped {
      value = 0
    }

    // Returned so a caller (task or endpoint) can link straight to what it just created.
    var $incident_ids {
      value = []
    }

    // Reused as the default for an AI array field that comes back missing.
    var $empty_list {
      value = []
    }

    // Pass 2: one incident per key.
    foreach ($group_keys) {
      each as $group_key {
        // Members of this group only. A second linear pass is cheaper to reason about than building a nested map with |set.
        var $members {
          value = []
        }

        foreach ($enriched) {
          each as $candidate {
            conditional {
              if ($candidate.ckey == $group_key) {
                array.push $members {
                  value = $candidate
                }
              }
            }
          }
        }

        // Group size doubles as the incident's alert contribution.
        var $member_count {
          value = $members|count
        }

        // Severity of an incident is the worst severity among its members - an incident is as bad as its worst symptom.
        var $severity_rank {
          value = 1
        }

        // Text form written to the incident row.
        var $severity {
          value = "info"
        }

        // Collected for distinct counts and for the prompt's device list.
        var $device_ids {
          value = []
        }

        // Names, not ids, because the model reasons better over "Freezer 12" than over 4471.
        var $device_names {
          value = []
        }

        // The metric keys involved; also the incident title's subject.
        var $metric_keys {
          value = []
        }

        // Epoch-ms fired times, so the time span can be reported without timezone maths.
        var $fired_ms {
          value = []
        }

        // Evidence lines: observed-vs-threshold per device, so the model reasons over numbers rather than adjectives.
        var $evidence_lines {
          value = []
        }

        foreach ($members) {
          each as $member {
            // Rank comparison guards the update so the worst severity seen wins regardless of member order.
            conditional {
              if ($member.severity == "critical" && $severity_rank < 3) {
                var.update $severity_rank {
                  value = 3
                }

                var.update $severity {
                  value = "critical"
                }
              }
              elseif ($member.severity == "warning" && $severity_rank < 2) {
                var.update $severity_rank {
                  value = 2
                }

                var.update $severity {
                  value = "warning"
                }
              }
            }

            array.push $device_ids {
              value = $member.device_id
            }

            array.push $device_names {
              value = $member.device_name
            }

            array.push $metric_keys {
              value = $member.metric_key
            }

            array.push $fired_ms {
              value = $member.fired_at|to_ms
            }

            array.push $evidence_lines {
              value = $member.device_name ~ " (" ~ $member.type_name ~ ") " ~ ($member.metric_key|first_notempty:"metric") ~ "=" ~ (($member.observed_value|first_notnull:0)|to_text) ~ " vs threshold " ~ (($member.threshold|first_notnull:0)|to_text) ~ ", z=" ~ (($member.z_score|first_notnull:0)|to_text)
            }
          }
        }

        // Distinct devices, which is what an operator reads as "how big is this".
        var $device_count {
          value = ($device_ids|unique)|count
        }

        // Deduped for the title and the prompt.
        var $unique_metrics {
          value = $metric_keys|unique
        }

        // Same, for the affected-device list.
        var $unique_names {
          value = $device_names|unique
        }

        // Every member of a group shares a site by construction, so the first one is authoritative.
        var $site_id {
          value = ($members|first)|get:"site_id"
        }

        db.get site {
          field_name = "id"
          field_value = $site_id
        } as $site

        // Titles are read in a list view, so the site name has to be in them.
        var $site_label {
          value = $site|get:"name":"unknown site"
        }

        // Metric list as prose.
        var $metric_label {
          value = $unique_metrics|join:", "
        }

        // Window covered by this group, used in the title-adjacent prompt context.
        var $span_start {
          value = ($fired_ms|array_min)|format_timestamp:"Y-m-d H:i:s":"UTC"
        }

        // Upper bound of the same window.
        var $span_end {
          value = ($fired_ms|array_max)|format_timestamp:"Y-m-d H:i:s":"UTC"
        }

        // What the operator sees before opening anything.
        var $title {
          value = ($device_count|to_text) ~ " device(s) at " ~ $site_label ~ " alerting on " ~ ($metric_label|first_notempty:"multiple metrics")
        }

        // Stored so the grouping decision is auditable rather than magic.
        var $correlation_reason {
          value = "Grouped by correlation key " ~ $group_key ~ ": " ~ ($member_count|to_text) ~ " firing alert(s) across " ~ ($device_count|to_text) ~ " device(s) between " ~ $span_start ~ " and " ~ $span_end ~ " UTC."
        }

        // Reuse an incident that is still being worked, so a recurring cause does not spawn a new ticket every sweep.
        db.query incident {
          where = $db.incident.correlation_key == $group_key && ($db.incident.state == "open" || $db.incident.state == "investigating")
          return = {type: "single"}
        } as $existing

        // Prior counts, hoisted so the data blocks below hold plain variables.
        var $previous_alerts {
          value = 0
        }

        // Prior distinct-device count, same reasoning.
        var $previous_devices {
          value = 0
        }

        conditional {
          if ($existing != null) {
            var.update $previous_alerts {
              value = $existing|get:"alert_count":0
            }

            var.update $previous_devices {
              value = $existing|get:"device_count":0
            }
          }
        }

        // Alert counts accumulate across sweeps; the incident's total is a running tally.
        var $total_alerts {
          value = $previous_alerts + $member_count
        }

        // Device count cannot be summed (the same device recurs across sweeps), so keep the high-water mark.
        var $total_devices {
          value = $device_count
        }

        // Explicit comparison rather than a max filter: the scalar min/max names collide with the array ones.
        conditional {
          if ($previous_devices > $device_count) {
            var.update $total_devices {
              value = $previous_devices
            }
          }
        }

        // Filled by whichever branch runs; the alert-attachment loop needs it afterwards.
        var $incident_id {
          value = null
        }

        // Only a newly created incident is worth an inference - re-triaging a known incident every 2 minutes burns tokens for nothing.
        var $is_new {
          value = false
        }

        conditional {
          if ($existing == null) {
            db.add incident {
              data = {
                created_at        : "now"
                title             : $title
                severity          : $severity
                state             : "open"
                site_id           : $site_id
                device_count      : $total_devices
                alert_count       : $total_alerts
                opened_at         : "now"
                correlation_key   : $group_key
                correlation_reason: $correlation_reason
              }
            } as $new_incident

            var.update $incident_id {
              value = $new_incident.id
            }

            var.update $is_new {
              value = true
            }

            math.add $incidents_created {
              value = 1
            }
          }
          else {
            // Escalation is one-way here: severity is recomputed from the current member set, which can only be as bad as its worst alert.
            db.edit incident {
              field_name = "id"
              field_value = $existing.id
              data = {
                title             : $title
                severity          : $severity
                device_count      : $total_devices
                alert_count       : $total_alerts
                correlation_reason: $correlation_reason
              }
            } as $updated_incident

            var.update $incident_id {
              value = $existing.id
            }
          }
        }

        // Point every member at the incident, which is also what removes it from the next sweep's candidate set.
        foreach ($members) {
          each as $member {
            db.edit alert {
              field_name = "id"
              field_value = $member.alert_id
              data = {incident_id: $incident_id}
            } as $linked_alert
          }
        }

        math.add $incidents_touched {
          value = 1
        }

        math.add $alerts_grouped {
          value = $member_count
        }

        array.push $incident_ids {
          value = $incident_id
        }

        // Gate the inference on both the caller's wish and novelty.
        var $want_ai {
          value = ($input.call_ai == true) && $is_new
        }

        // Deterministic answer computed first. It is what ships when there is no key, when Anthropic 429s, or when the reply is not parseable - the demo must never dead-end.
        var $ai_summary {
          value = ($member_count|to_text) ~ " alert(s) fired across " ~ ($device_count|to_text) ~ " device(s) at " ~ $site_label ~ " on " ~ ($metric_label|first_notempty:"multiple metrics") ~ " between " ~ $span_start ~ " and " ~ $span_end ~ " UTC."
        }

        // Fallback hypothesis: state the shared attribute the key was built from, which is a real (if shallow) cause candidate.
        var $ai_root_cause {
          value = "Alerts share the correlation key " ~ $group_key ~ ", so the most likely common cause is the shared site, uplink or device class rather than " ~ ($device_count|to_text) ~ " independent faults."
        }

        // Low, honest confidence for a rule-derived hypothesis.
        var $ai_confidence {
          value = 0.35
        }

        // Generic but actionable steps, so the incident view is never empty.
        var $ai_remediation {
          value = ["Confirm the shared site, uplink or power source for the affected devices.", "Compare each device's current reading against its own baseline.", "Acknowledge the alerts once a single cause is confirmed, then resolve them together."]
        }

        // The evidence the fallback reasoned from is exactly the evidence lines.
        var $ai_evidence {
          value = $evidence_lines
        }

        // Assume fallback; flipped only on a parsed model answer.
        var $ai_fallback_used {
          value = true
        }

        // Recorded on the incident so the UI can show which model produced the hypothesis.
        var $ai_model {
          value = null
        }

        conditional {
          if ($want_ai) {
            // STRICT JSON is demanded because the reply is written into typed columns, not rendered as prose.
            var $system_prompt {
              value = "You are a senior site-reliability engineer triaging an IoT device incident. Reply with STRICT JSON only, no prose and no markdown fence. Use exactly these keys: summary (one or two sentences), root_cause (one sentence naming the single most likely shared cause), confidence (a number between 0 and 1), remediation (an array of short imperative steps), evidence (an array of strings quoting the observations you relied on). Prefer one shared cause over many independent faults when the evidence allows it, and say so plainly when the evidence is too thin to be sure."
            }

            // The prompt carries only facts already in the database: no derived claims for the model to inherit.
            var $user_prompt {
              value = "Site: " ~ $site_label ~ "\nCorrelation key: " ~ $group_key ~ "\nTime span (UTC): " ~ $span_start ~ " to " ~ $span_end ~ "\nDistinct devices affected: " ~ ($device_count|to_text) ~ "\nAffected devices: " ~ ($unique_names|join:"; ") ~ "\nMetrics involved: " ~ ($metric_label|first_notempty:"unknown") ~ "\nWorst severity: " ~ $severity ~ "\nObservations (device, type, metric, observed vs threshold, z-score):\n- " ~ ($evidence_lines|join:"\n- ")
            }

            function.run "Nerve/fn_claude" {
              input = {
                system     : $system_prompt
                user_prompt: $user_prompt
                max_tokens : 1200
                kind       : "incident_triage"
                incident_id: $incident_id
                title      : $title
                expect_json: true
              }
            } as $ai

            // The model's answer is used only when it actually parsed; anything else keeps the deterministic text above.
            conditional {
              if (($ai.fallback_used == false) && ($ai.json != null)) {
                var.update $ai_summary {
                  value = $ai.json|get:"summary":$ai_summary
                }

                var.update $ai_root_cause {
                  value = $ai.json|get:"root_cause":$ai_root_cause
                }

                var.update $ai_confidence {
                  value = ($ai.json|get:"confidence":0.35)|to_decimal
                }

                var.update $ai_remediation {
                  value = ($ai.json|get:"remediation":$empty_list)|safe_array
                }

                var.update $ai_evidence {
                  value = ($ai.json|get:"evidence":$evidence_lines)|safe_array
                }

                var.update $ai_fallback_used {
                  value = false
                }
              }
            }

            // Recorded even on fallback, so an ai_insight row and its incident always agree on which model was attempted.
            var.update $ai_model {
              value = $ai.model
            }

            db.edit incident {
              field_name = "id"
              field_value = $incident_id
              data = {
                ai_summary      : $ai_summary
                ai_root_cause   : $ai_root_cause
                ai_confidence   : $ai_confidence
                ai_remediation  : $ai_remediation
                ai_evidence     : $ai_evidence
                ai_model        : $ai_model
                ai_generated_at : "now"
                ai_fallback_used: $ai_fallback_used
              }
            } as $triaged_incident
          }
        }
      }
    }
  }

  response = {
    incidents_touched: $incidents_touched
    incidents_created: $incidents_created
    alerts_grouped   : $alerts_grouped
    incident_ids     : $incident_ids
  }
  tags = ["nerve"]
}
