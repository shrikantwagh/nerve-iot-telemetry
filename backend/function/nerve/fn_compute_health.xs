// Turns "42 firing alerts and a stale heartbeat" into one number an operator can sort a fleet grid by. Written onto the device so the grid is one query, not N.
function "Nerve/fn_compute_health" {
  description = "Recomputes a device's 0-100 health score from its firing alerts, heartbeat staleness and open maintenance predictions, derives a status, and persists both onto the device row."

  input {
    // The device to rescore.
    int device_id { table = "device" }
  }

  stack {
    // Need status and last_seen_at, so a full read rather than a projection.
    db.get device {
      field_name = "id"
      field_value = $input.device_id
    } as $device

    // A missing device is a caller bug, not a scoring outcome.
    precondition ($device != null) {
      error_type = "notfound"
      error = "Device not found."
    }

    // The staleness threshold is per device *type* - a gateway that misses 5 minutes is dead, a battery-powered sensor is not.
    db.get device_type {
      field_name = "id"
      field_value = $device.device_type_id
    } as $device_type

    // Only firing alerts count. Acknowledged means a human is on it; resolved means it is over.
    db.query alert {
      where = $db.alert.device_id == $input.device_id && $db.alert.state == "firing"
      return = {type: "list"}
    } as $alerts

    // Start from perfect and deduct, so the score is explainable rather than fitted.
    var $score {
      value = 100
    }

    // Drives the "degraded" status below.
    var $has_critical {
      value = false
    }

    // Same, at the lower severity.
    var $has_warning {
      value = false
    }

    // Weights are deliberately far apart: one critical must outrank a dozen infos, or the score stops discriminating.
    foreach ($alerts) {
      each as $alert {
        conditional {
          if ($alert.severity == "critical") {
            math.sub $score {
              value = 25
            }

            var.update $has_critical {
              value = true
            }
          }
          elseif ($alert.severity == "warning") {
            math.sub $score {
              value = 8
            }

            var.update $has_warning {
              value = true
            }
          }
          else {
            math.sub $score {
              value = 2
            }
          }
        }
      }
    }

    // Fall back to the schema default when the type omits it, so a half-configured type cannot make every device look offline.
    var $offline_after {
      value = $device_type|get:"offline_after_seconds"|first_notnull:300
    }

    // A device that never checked in is treated as maximally stale rather than as healthy.
    var $age_seconds {
      value = 999999999
    }

    // Heartbeat age in seconds, computed in epoch ms to avoid timezone entering the arithmetic.
    conditional {
      if ($device.last_seen_at != null) {
        var.update $age_seconds {
          value = (("now"|to_ms) - ($device.last_seen_at|to_ms)) / 1000
        }
      }
    }

    // Past the type's own threshold the device is not reporting at all, which dominates any metric problem.
    var $stale {
      value = $age_seconds > $offline_after
    }

    // Graded rather than binary: a device halfway to its timeout is a warning sign worth surfacing before it flips.
    conditional {
      if ($stale) {
        math.sub $score {
          value = 30
        }
      }
      elseif ($age_seconds > ($offline_after / 2)) {
        math.sub $score {
          value = 10
        }
      }
    }

    // Open predictions are future failures, so they shave the score without implying anything is wrong right now.
    db.query maintenance_prediction {
      where = $db.maintenance_prediction.device_id == $input.device_id && $db.maintenance_prediction.state == "open"
      return = {type: "count"}
    } as $open_predictions

    math.sub $score {
      value = $open_predictions * 10
    }

    // Clamp to the column's documented 0-100 range. Written as a conditional because the scalar min/max filter names collide with the array ones.
    conditional {
      if ($score < 0) {
        var.update $score {
          value = 0
        }
      }
      elseif ($score > 100) {
        var.update $score {
          value = 100
        }
      }
    }

    // Start from the current status so an unrecognised value is preserved rather than silently rewritten.
    var $status {
      value = $device.status
    }

    // A manual maintenance hold is an engineer's decision and outranks anything measured here - never overwrite it.
    conditional {
      if ($device.status == "maintenance") {
        var.update $status {
          value = "maintenance"
        }
      }
      elseif ($stale) {
        var.update $status {
          value = "offline"
        }
      }
      elseif ($has_critical || $has_warning) {
        var.update $status {
          value = "degraded"
        }
      }
      else {
        var.update $status {
          value = "online"
        }
      }
    }

    // Denormalized onto the device so the fleet grid and the map never have to aggregate at read time.
    db.edit device {
      field_name = "id"
      field_value = $input.device_id
      data = {
        health_score: $score
        status      : $status
      }
    } as $updated_device
  }

  response = {health_score: $score, status: $status}
  tags = ["nerve"]
  guid = "I0Q7FFRV3gsgs7k6zaT2wJI0iKk"
}
