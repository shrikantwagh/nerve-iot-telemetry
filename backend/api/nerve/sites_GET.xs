// Sites with their rollups. Returned in one shot rather than as a bare list the client then enriches, because "which site is worst" is the only reason anyone opens this screen.
query "sites" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
  }

  stack {
    // Sites are a small reference table; alphabetical because this list is a navigation control, not a leaderboard.
    db.query site {
      sort = {site.name: "asc"}
      return = {type: "list"}
    } as $sites

    // No SQL aggregate is available (db.direct_query is plan-gated), so the device table is scanned once, projected to the three columns the rollup needs, and every per-site number is folded out of that single pass.
    db.query device {
      output = ["id", "site_id", "status", "health_score"]
      return = {type: "list"}
    } as $devices

    // All keyed by site id as text, since object paths are text.
    var $device_counts {
      value = {}
    }

    // Numerators for the per-site average.
    var $health_sums {
      value = {}
    }

    // The three statuses an operator actually scans for. maintenance and provisioning are deliberately not broken out here - they are expected states, not problems.
    var $online_counts {
      value = {}
    }

    var $degraded_counts {
      value = {}
    }

    var $offline_counts {
      value = {}
    }

    foreach ($devices) {
      each as $device {
        var $skey {
          value = $device.site_id|to_text
        }

        var $next_count {
          value = ($device_counts|get:$skey:0) + 1
        }

        var.update $device_counts {
          value = $device_counts|set:$skey:$next_count
        }

        // Null contributes 0 to the sum rather than poisoning it.
        var $health {
          value = $device.health_score|first_notnull:0
        }

        var $next_health {
          value = ($health_sums|get:$skey:0) + $health
        }

        var.update $health_sums {
          value = $health_sums|set:$skey:$next_health
        }

        conditional {
          if ($device.status == "online") {
            var $next_online {
              value = ($online_counts|get:$skey:0) + 1
            }

            var.update $online_counts {
              value = $online_counts|set:$skey:$next_online
            }
          }
          elseif ($device.status == "degraded") {
            var $next_degraded {
              value = ($degraded_counts|get:$skey:0) + 1
            }

            var.update $degraded_counts {
              value = $degraded_counts|set:$skey:$next_degraded
            }
          }
          elseif ($device.status == "offline") {
            var $next_offline {
              value = ($offline_counts|get:$skey:0) + 1
            }

            var.update $offline_counts {
              value = $offline_counts|set:$skey:$next_offline
            }
          }
        }
      }
    }

    // Open incidents are always few, so one list read is cheaper than a count query per site. "investigating" is still open - someone owns it, but it is not over.
    db.query incident {
      where = $db.incident.state == "open" || $db.incident.state == "investigating"
      output = ["id", "site_id", "severity"]
      return = {type: "list"}
    } as $open_incidents

    var $incident_counts {
      value = {}
    }

    // Critical is tracked separately because one critical incident outranks any number of warnings when choosing which site to look at first.
    var $critical_counts {
      value = {}
    }

    foreach ($open_incidents) {
      each as $incident {
        // A cross-site incident has a null site_id and belongs to no row here.
        conditional {
          if ($incident.site_id != null) {
            var $ikey {
              value = $incident.site_id|to_text
            }

            var $next_incidents {
              value = ($incident_counts|get:$ikey:0) + 1
            }

            var.update $incident_counts {
              value = $incident_counts|set:$ikey:$next_incidents
            }

            conditional {
              if ($incident.severity == "critical") {
                var $next_critical {
                  value = ($critical_counts|get:$ikey:0) + 1
                }

                var.update $critical_counts {
                  value = $critical_counts|set:$ikey:$next_critical
                }
              }
            }
          }
        }
      }
    }

    var $rows {
      value = []
    }

    foreach ($sites) {
      each as $site {
        var $sid {
          value = $site.id|to_text
        }

        var $count {
          value = $device_counts|get:$sid:0
        }

        var $health_sum {
          value = $health_sums|get:$sid:0
        }

        // A site with no devices reports 0, not null: an empty site is a real state during rollout and should sort predictably.
        var $avg_health {
          value = 0
        }

        conditional {
          if ($count > 0) {
            var.update $avg_health {
              value = ($health_sum / $count)|round:1
            }
          }
        }

        array.push $rows {
          value = {
            id              : $site.id
            code            : $site.code
            name            : $site.name
            timezone        : $site.timezone
            region          : $site.region
            address         : $site.address
            lat             : $site.lat
            lng             : $site.lng
            created_at      : $site.created_at
            device_count    : $count
            avg_health_score: $avg_health
            online_count    : $online_counts|get:$sid:0
            degraded_count  : $degraded_counts|get:$sid:0
            offline_count   : $offline_counts|get:$sid:0
            open_incidents  : $incident_counts|get:$sid:0
            critical_incidents: $critical_counts|get:$sid:0
          }
        }
      }
    }
  }

  response = {
    total_sites  : $sites|count
    total_devices: $devices|count
    sites        : $rows
  }
  tags = ["nerve"]
  guid = "9pfwCUerVwvvWOk-PK5mz3udyvs"
}
