// The thing that replaces hand-tuned thresholds: an O(1) incremental EWMA/EWMV per device per metric, so "abnormal" is learned from the device's own history instead of typed in by a human at 3am.
function "Nerve/fn_update_baseline" {
  description = "Advances the metric_baseline row for one (device, metric) with an incremental EWMA/EWMV update and returns the z-score of the supplied reading against it."

  input {
    // Which device reported the value.
    int device_id { table = "device" }

    // Metric key inside the reading's metrics object, e.g. "temp_c".
    text metric_key filters=trim

    // The reading itself.
    decimal value
  }

  stack {
    // (device_id, metric_key) is the natural key; there is no unique index to db.get against, so query for a single row.
    db.query metric_baseline {
      where = $db.metric_baseline.device_id == $input.device_id && $db.metric_baseline.metric_key == $input.metric_key
      return = {type: "single"}
    } as $baseline

    // First-ever reading for this pair: the row has to be created, and there is nothing yet to judge against.
    var $seeded {
      value = $baseline|is_null
    }

    // Seed defaults chosen so the shared arithmetic below produces exactly ewma=value, ewmv=0, sample_count=1 with no special-casing.
    var $alpha {
      value = 0.05
    }

    // Previous mean; equal to the reading on the seed path, which forces delta to 0.
    var $prev_ewma {
      value = $input.value
    }

    // Previous variance.
    var $prev_ewmv {
      value = 0
    }

    // Previous sample count; 0 on the seed path so the new count lands on 1.
    var $prev_n {
      value = 0
    }

    // The reading before this one, returned to the caller. This function overwrites last_value, so the rule engine cannot read the *previous* value off the row afterwards - it has to be handed down.
    var $prev_last_value {
      value = null
    }

    // Adopt the persisted state, including the row's own alpha so a metric can be tuned individually.
    conditional {
      if ($seeded == false) {
        var.update $alpha {
          value = $baseline.alpha
        }

        var.update $prev_ewma {
          value = $baseline.ewma
        }

        var.update $prev_ewmv {
          value = $baseline.ewmv
        }

        var.update $prev_n {
          value = $baseline.sample_count
        }

        var.update $prev_last_value {
          value = $baseline.last_value
        }
      }
    }

    // Deviation of this reading from the running mean - the quantity both the mean and the variance update consume.
    var $delta {
      value = $input.value - $prev_ewma
    }

    // Standard incremental EWMA: ewma + alpha * delta. Clamped for the same reason as
    // the variance below - it is a decimal column, and a wild reading drags the mean
    // with it.
    var $ewma_raw {
      value = $prev_ewma + ($alpha * $delta)
    }

    var $ewma_new {
      value = $ewma_raw
    }

    conditional {
      if ($ewma_raw > 1000000000) {
        var.update $ewma_new {
          value = 1000000000
        }
      }
      elseif ($ewma_raw < -1000000000) {
        var.update $ewma_new {
          value = -1000000000
        }
      }
    }

    // Its matching EWMV: (1 - alpha) * (ewmv + alpha * delta^2). Kept exactly as the
    // paired recurrence; changing either half breaks the z-score.
    var $ewmv_raw {
      value = (1 - $alpha) * ($prev_ewmv + ($alpha * $delta * $delta))
    }

    // CLAMPED, because this term SQUARES the delta and the column is a decimal.
    //
    // One absurd reading is enough to overflow it: a device reporting 2e5 against a
    // baseline near zero yields a variance around 4e10, which Postgres rejects with
    // "22003 NUMERIC VALUE OUT OF RANGE" - and because this runs on the ingest hot
    // path, that single bad sample would fail the whole batch and keep failing for
    // that device on every subsequent write. A monitoring system must not be
    // destroyed by the thing it is monitoring.
    //
    // The cap is far above any plausible real variance, so it never affects a healthy
    // baseline; it only stops a garbage value from becoming a permanent outage. The
    // z-score derived from a clamped variance is conservative (too small), which
    // fails toward "no alert" rather than a storm of false ones.
    var $ewmv_new {
      value = $ewmv_raw
    }

    conditional {
      if ($ewmv_raw > 1000000000) {
        var.update $ewmv_new {
          value = 1000000000
        }
      }
      elseif ($ewmv_raw < 0) {
        var.update $ewmv_new {
          value = 0
        }
      }
    }

    // Sample count after this reading.
    var $n {
      value = $prev_n + 1
    }

    // 20 prior samples is the floor for trusting a variance estimate; below that, and with a degenerate variance, any z-score is noise dressed as signal.
    var $warmed_up {
      value = ($prev_n >= 20) && ($ewmv_new > 0)
    }

    // Zero means "no opinion", which is what the rule engine's anomaly condition compares against.
    var $z {
      value = 0
    }

    // |delta| / sigma, with sigma taken from the freshly updated variance.
    conditional {
      if ($warmed_up) {
        var.update $z {
          value = ($delta|abs) / ($ewmv_new|sqrt)
        }
      }
    }

    // Two write paths rather than db.add_or_edit, because the seed path has no id to match on.
    var $row {
      value = null
    }

    // Persist. last_value is kept so the flatline and rate_of_change rules have a previous reading to compare with.
    conditional {
      if ($seeded) {
        db.add metric_baseline {
          data = {
            device_id   : $input.device_id
            metric_key  : $input.metric_key
            ewma        : $ewma_new
            ewmv        : $ewmv_new
            alpha       : $alpha
            sample_count: $n
            last_value  : $input.value
            updated_at  : "now"
          }
        } as $added

        var.update $row {
          value = $added
        }
      }
      else {
        db.edit metric_baseline {
          field_name = "id"
          field_value = $baseline.id
          data = {
            ewma        : $ewma_new
            ewmv        : $ewmv_new
            sample_count: $n
            last_value  : $input.value
            updated_at  : "now"
          }
        } as $edited

        var.update $row {
          value = $edited
        }
      }
    }
  }

  response = {
    z_score       : $z
    ewma          : $ewma_new
    ewmv          : $ewmv_new
    sample_count  : $n
    warmed_up     : $warmed_up
    previous_value: $prev_last_value
  }
  tags = ["nerve"]
  guid = "wlptwf2_FDAe8UithFoNW0ORNgA"
}
