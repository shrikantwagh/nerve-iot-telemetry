// The first request the dashboard makes. Everything the Overview screen renders is assembled here in one round trip, because six parallel tile requests on a free-plan rate limit (10 req / 20 s) is a blank dashboard.
query "fleet/overview" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
  }

  stack {
    // One clock for the whole response. Tiles computed against different "now"s disagree by a second and look like a bug.
    // to_ms, not the bare literal. "now" is only interpreted as a timestamp inside a
    // db `data = {}` block; returned directly in a response it serialises as the literal
    // three-character string "now", which is what the live endpoint was emitting.
    var $now {
      value = "now"|to_ms
    }

    // Ingest-rate tile window.
    var $hour_ago {
      value = "now"|add_secs_to_timestamp:-3600
    }

    // Average health, the below-60 count and the per-site rollup all need the actual health values, and there is no SQL aggregate available (db.direct_query is plan-gated). So the device table is scanned exactly once, projected down to the columns the rollups need, and every derived number below is folded out of this single pass. Sorted ascending so the worst-health slice is free.
    db.query device {
      sort = {device.health_score: "asc"}
      output = ["id", "name", "serial", "status", "health_score", "site_id", "device_type_id", "last_seen_at"]
      return = {type: "list"}
    } as $devices

    // Pre-seeded with every status enum value, so a status with zero devices still renders a "0" tile instead of vanishing from the object.
    var $status_counts {
      value = {online: 0, degraded: 0, offline: 0, maintenance: 0, provisioning: 0}
    }

    // Numerator for the fleet-wide average.
    var $health_sum {
      value = 0
    }

    // The "needs attention" tile: 60 is the score below which fn_compute_health has already deducted for at least one critical, or for staleness plus a warning.
    var $below_60 {
      value = 0
    }

    // Per-site accumulators, keyed by site id as text because object paths are text.
    var $site_device_counts {
      value = {}
    }

    // Numerators for each site's average health.
    var $site_health_sums {
      value = {}
    }

    foreach ($devices) {
      each as $device {
        // Site id as an object path.
        var $skey {
          value = $device.site_id|to_text
        }

        // Read-modify-write into the map. Hoisted into a var because a filter chain inside a filter argument binds greedily.
        var $next_site_count {
          value = ($site_device_counts|get:$skey|first_notnull:0) + 1
        }

        var.update $site_device_counts {
          value = $site_device_counts|set:$skey:$next_site_count
        }

        // A null health_score contributes 0 rather than poisoning the sum with null.
        var $device_health {
          value = $device.health_score|first_notnull:0
        }

        var $next_site_health {
          value = ($site_health_sums|get:$skey|first_notnull:0) + $device_health
        }

        var.update $site_health_sums {
          value = $site_health_sums|set:$skey:$next_site_health
        }

        math.add $health_sum {
          value = $device_health
        }

        // Defaulted to 100 here, not 0: an unscored device is not evidence of a problem, and counting it as one would inflate the tile the operator triages by.
        var $health_or_perfect {
          value = $device.health_score|first_notnull:100
        }

        conditional {
          if ($health_or_perfect < 60) {
            math.add $below_60 {
              value = 1
            }
          }
        }

        // status is an enum, so it is already text and can index the map directly.
        var $next_status_count {
          value = ($status_counts|get:$device.status|first_notnull:0) + 1
        }

        var.update $status_counts {
          value = $status_counts|set:$device.status:$next_status_count
        }
      }
    }

    // Free off the scan above.
    var $device_total {
      value = $devices|count
    }

    // Guarded because an empty fleet must return 0, not a division error, on a freshly seeded instance.
    var $avg_health {
      value = 0
    }

    conditional {
      if ($device_total > 0) {
        var.update $avg_health {
          value = ($health_sum / $device_total)|round:1
        }
      }
    }

    // Sites are few and the rollup needs their names anyway, so this is a list rather than a count.
    db.query site {
      sort = {site.name: "asc"}
      output = ["id", "code", "name", "region", "timezone"]
      return = {type: "list"}
    } as $sites

    // Lets the worst-devices slice below carry a site name without a per-device join.
    var $site_names {
      value = {}
    }

    foreach ($sites) {
      each as $site {
        var $name_key {
          value = $site.id|to_text
        }

        var.update $site_names {
          value = $site_names|set:$name_key:$site.name
        }
      }
    }

    // Open incidents are the short list the whole product exists to produce, so there are never many. One list read serves both the severity tiles and the per-site column - three count queries could not do the second. "investigating" counts as open: someone is on it, but it is not over.
    db.query incident {
      where = $db.incident.state == "open" || $db.incident.state == "investigating"
      output = ["id", "severity", "state", "site_id", "title", "opened_at"]
      return = {type: "list"}
    } as $open_incidents

    // Pre-seeded for the same reason as the status map.
    var $incidents_by_severity {
      value = {critical: 0, warning: 0, info: 0}
    }

    // Per-site column of the rollup table.
    var $site_incident_counts {
      value = {}
    }

    foreach ($open_incidents) {
      each as $incident {
        var $next_sev_count {
          value = ($incidents_by_severity|get:$incident.severity|first_notnull:0) + 1
        }

        var.update $incidents_by_severity {
          value = $incidents_by_severity|set:$incident.severity:$next_sev_count
        }

        // A site-less incident (cross-site correlation) is still counted in the severity tiles above but has no row to land in here.
        conditional {
          if ($incident.site_id != null) {
            var $inc_site_key {
              value = $incident.site_id|to_text
            }

            var $next_site_incidents {
              value = ($site_incident_counts|get:$inc_site_key|first_notnull:0) + 1
            }

            var.update $site_incident_counts {
              value = $site_incident_counts|set:$inc_site_key:$next_site_incidents
            }
          }
        }
      }
    }

    // Alerts are the high-cardinality table - a noisy fleet has thousands firing - and the tile only needs three integers, so these are index-only counts rather than a scan.
    db.query alert {
      where = $db.alert.state == "firing" && $db.alert.severity == "critical"
      return = {type: "count"}
    } as $alerts_critical

    db.query alert {
      where = $db.alert.state == "firing" && $db.alert.severity == "warning"
      return = {type: "count"}
    } as $alerts_warning

    db.query alert {
      where = $db.alert.state == "firing" && $db.alert.severity == "info"
      return = {type: "count"}
    } as $alerts_info

    // Ingest-rate tile. telemetry is by far the largest table, so this is a count and never a scan.
    db.query telemetry {
      where = $db.telemetry.ts >= $hour_ago
      return = {type: "count"}
    } as $readings_last_hour

    // Assembled after both the device scan and the incident scan, since it consumes maps built by each.
    var $site_rollup {
      value = []
    }

    foreach ($sites) {
      each as $site {
        var $sid {
          value = $site.id|to_text
        }

        var $site_devices {
          value = $site_device_counts|get:$sid|first_notnull:0
        }

        var $site_health {
          value = $site_health_sums|get:$sid|first_notnull:0
        }

        var $site_incidents {
          value = $site_incident_counts|get:$sid|first_notnull:0
        }

        // A site with no devices yet reports 0 rather than being omitted - an empty site is a real operational state during rollout.
        var $site_avg_health {
          value = 0
        }

        conditional {
          if ($site_devices > 0) {
            var.update $site_avg_health {
              value = ($site_health / $site_devices)|round:1
            }
          }
        }

        array.push $site_rollup {
          value = {
            id              : $site.id
            code            : $site.code
            name            : $site.name
            region          : $site.region
            device_count    : $site_devices
            open_incidents  : $site_incidents
            avg_health_score: $site_avg_health
          }
        }
      }
    }

    // The device scan was sorted health-ascending, so the five worst are the first five - no second query and no re-sort.
    var $worst_slice {
      value = $devices|slice:0:5
    }

    // Enriched with the site name because this list is rendered as clickable rows, and "which site" is the first question an operator asks about a sick device.
    var $worst_devices {
      value = []
    }

    foreach ($worst_slice) {
      each as $worst {
        var $worst_site_key {
          value = $worst.site_id|to_text
        }

        var $worst_site_name {
          value = $site_names|get:$worst_site_key
        }

        array.push $worst_devices {
          value = {
            id          : $worst.id
            name        : $worst.name
            serial      : $worst.serial
            status      : $worst.status
            health_score: $worst.health_score
            last_seen_at: $worst.last_seen_at
            site_id     : $worst.site_id
            site_name   : $worst_site_name
          }
        }
      }
    }

    // Newest daily digest, written by task_fleet_digest. Returned as-is (including fallback_used) so the UI can label rule-derived prose honestly instead of passing it off as model output.
    db.query ai_insight {
      where = $db.ai_insight.kind == "fleet_digest"
      sort = {ai_insight.created_at: "desc"}
      return = {type: "single"}
    } as $fleet_digest
  }

  response = {
    generated_at    : $now
    totals          : {
      devices           : $device_total
      avg_health_score  : $avg_health
      below_health_60   : $below_60
      readings_last_hour: $readings_last_hour
      open_incidents    : $open_incidents|count
      firing_alerts     : $alerts_critical + $alerts_warning + $alerts_info
    }
    devices_by_status: $status_counts
    incidents_open_by_severity: $incidents_by_severity
    alerts_firing_by_severity : {
      critical: $alerts_critical
      warning : $alerts_warning
      info    : $alerts_info
    }
    sites           : $site_rollup
    worst_devices   : $worst_devices
    ai_digest       : $fleet_digest
  }
  tags = ["nerve"]
  guid = "0nBAZUM8jJgoIYg9heLgfLwlS0I"
}
