// Charts are why this exists. A device-detail page reading 14 days of raw wide-format telemetry is a table scan per chart; reading 5-minute buckets is 4032 rows and stays flat as the fleet grows. Rollups are also what makes the 14-day raw retention in task_prune_telemetry survivable - the history is not lost, it is downsampled.
task task_rollup_metrics {
  description = "Every 5 minutes, folds raw telemetry into 5-minute metric_rollup buckets (avg/min/max/last/stddev/sample_count per device and metric), processing only complete buckets newer than the newest existing rollup so re-runs are cheap and idempotent."
  active = true

  stack {
    // Bucket width. Also written onto every row as bucket_seconds so a future 1-minute or 1-hour tier can coexist in the same table.
    var $bucket_ms {
      value = 300000
    }

    // Per-run ceiling on raw readings. Sized so the aggregation loop finishes inside the 5-minute interval with room to spare; the remainder is picked up next run, which is exactly why the watermark below is a stored bucket rather than a stored timestamp.
    var $read_cap {
      value = 5000
    }

    // The current bucket is still filling. Writing it now would produce a partial row that nothing would ever correct, because the watermark logic never revisits a bucket. So the run stops one bucket short of now.
    var $current_bucket_start {
      value = ((("now"|to_ms) / $bucket_ms)|floor) * $bucket_ms
    }

    // The watermark: the newest bucket already folded. Everything up to and including it is done.
    db.query metric_rollup {
      sort = {metric_rollup.bucket_ts: "desc"}
      return = {type: "single"}
    } as $newest

    // First run on an empty table would otherwise try to fold the entire history in one go. 24 hours of backfill is enough to make the demo charts look real without a multi-minute cold start; older raw data simply never gets rollups, which is acceptable because it is also the data task_prune_telemetry will drop.
    var $from_ms {
      value = $current_bucket_start - 86400000
    }

    // Strictly newer than the watermark: start at the bucket *after* the last one written, so no bucket is ever folded twice and no db.add_or_edit composite-key gymnastics are needed.
    conditional {
      if ($newest != null) {
        var.update $from_ms {
          value = ($newest.bucket_ts|to_ms) + $bucket_ms
        }
      }
    }

    // Half-open window [from, current): complete buckets only. totals tells us whether the cap truncated the window, which changes what is safe to write.
    db.query telemetry {
      where = $db.telemetry.ts >= $from_ms && $db.telemetry.ts < $current_bucket_start
      sort = {telemetry.ts: "asc"}
      return = {type: "list", paging: {page: 1, per_page: $read_cap, totals: true}}
      output = ["items.device_id", "items.ts", "items.metrics", "itemsTotal"]
    } as $page

    // Ascending ts matters twice: the truncation logic below depends on the tail being the newest, and `last_value` per bucket is simply the last reading seen.
    var $readings {
      value = $page.items|safe_array
    }

    // Total in the window, not just what was read - the difference is what this run defers.
    var $available {
      value = ($page.itemsTotal|first_notnull:0)|to_int
    }

    // A truncated window means the newest bucket in this batch is almost certainly incomplete: readings for it are still sitting past the cap.
    var $truncated {
      value = $available > ($readings|count)
    }

    // Accumulator keyed "device|metric|bucket_start". A flat map is used rather than nested objects so the write pass is a single |entries walk.
    var $acc {
      value = {}
    }

    // Every bucket_start touched, so the truncation guard can find the newest one and count how many distinct buckets are in play.
    var $bucket_starts {
      value = []
    }

    // Highest bucket seen; the candidate to withhold when the window was truncated.
    var $max_bucket {
      value = 0
    }

    // Non-numeric metrics (state strings, booleans) are counted but not folded - averaging "compressor_on" is meaningless, and the raw rows keep them for 14 days regardless.
    var $skipped_values {
      value = 0
    }

    foreach ($readings) {
      each as $row {
        // Floor to the bucket the reading belongs in. Epoch-ms throughout so no timezone can shift a bucket boundary.
        var $bucket_start {
          value = ((($row.ts|to_ms) / $bucket_ms)|floor) * $bucket_ms
        }

        array.push $bucket_starts {
          value = $bucket_start
        }

        conditional {
          if ($bucket_start > $max_bucket) {
            var.update $max_bucket {
              value = $bucket_start
            }
          }
        }

        // Wide format means one row carries every metric, so the fan-out to one accumulator entry per metric happens here rather than in the database.
        foreach ($row.metrics|entries) {
          each as $metric {
            // is_int/is_decimal rather than a null check: a state metric would otherwise poison avg and stddev with a coerced 0.
            var $numeric {
              value = ($metric.value|is_int) || ($metric.value|is_decimal)
            }

            conditional {
              if ($numeric) {
                var $v {
                  value = $metric.value|to_decimal
                }

                // "|" is safe as a separator because it cannot appear in an int id, and `get`/`set` treat "." as a path separator - which a metric key could plausibly contain.
                var $key {
                  value = ($row.device_id|to_text) ~ "|" ~ $metric.key ~ "|" ~ ($bucket_start|to_text)
                }

                var $cur {
                  value = $acc|get:$key
                }

                // First sighting of this (device, metric, bucket). Running sums rather than a values array: memory stays O(buckets) instead of O(readings), and stddev only needs sum and sum-of-squares.
                var $next {
                  value = {
                    device_id   : $row.device_id
                    metric_key  : $metric.key
                    bucket_start: $bucket_start
                    n           : 1
                    sum         : $v
                    sumsq       : $v * $v
                    min         : $v
                    max         : $v
                    last        : $v
                  }
                }

                conditional {
                  if ($cur != null) {
                    // Explicit comparisons rather than min/max filters: the scalar aliases num_min/num_max are rejected by the language server, and the bare names resolve to the array reducers.
                    var $new_min {
                      value = $cur.min
                    }

                    conditional {
                      if ($v < $cur.min) {
                        var.update $new_min {
                          value = $v
                        }
                      }
                    }

                    var $new_max {
                      value = $cur.max
                    }

                    conditional {
                      if ($v > $cur.max) {
                        var.update $new_max {
                          value = $v
                        }
                      }
                    }

                    // `last` is unconditional because the outer query is sorted ts ascending, so the final assignment wins.
                    var.update $next {
                      value = {
                        device_id   : $cur.device_id
                        metric_key  : $cur.metric_key
                        bucket_start: $cur.bucket_start
                        n           : $cur.n + 1
                        sum         : $cur.sum + $v
                        sumsq       : $cur.sumsq + ($v * $v)
                        min         : $new_min
                        max         : $new_max
                        last        : $v
                      }
                    }
                  }
                }

                var.update $acc {
                  value = $acc|set:$key:$next
                }
              }
              else {
                math.add $skipped_values {
                  value = 1
                }
              }
            }
          }
        }
      }
    }

    // Distinct buckets in this batch, needed to decide whether withholding the newest one would stall progress entirely.
    var $distinct_buckets {
      value = ($bucket_starts|unique)|count
    }

    // The truncation guard: when the cap cut the window mid-bucket, the newest bucket is short some readings, so hold it back and let the next run fold it whole.
    var $drop_max {
      value = false
    }

    // Unless it is the *only* bucket - a fleet dense enough to fill the cap inside 5 minutes would otherwise never advance the watermark and would re-read the same rows forever. Writing one slightly-short bucket is strictly better than making no progress.
    conditional {
      if ($truncated && $distinct_buckets > 1) {
        var.update $drop_max {
          value = true
        }
      }
    }

    // Rows written this run.
    var $written {
      value = 0
    }

    // Buckets deliberately deferred, reported so a persistently truncated run is visible.
    var $deferred {
      value = 0
    }

    foreach ($acc|entries) {
      each as $entry {
        var $b {
          value = $entry.value
        }

        var $skip {
          value = $drop_max && ($b.bucket_start == $max_bucket)
        }

        conditional {
          if ($skip) {
            math.add $deferred {
              value = 1
            }
          }
          else {
            var $n {
              value = $b.n
            }

            var $avg {
              value = $b.sum / $n
            }

            // Population variance via E[x^2] - E[x]^2. One pass, no second walk over the readings; the trade is float cancellation, which is why it is clamped below.
            var $variance {
              value = ($b.sumsq / $n) - ($avg * $avg)
            }

            // Cancellation on a near-constant series can push this a hair below zero, and sqrt of a negative is not a number anyone wants in a chart.
            conditional {
              if ($variance < 0) {
                var.update $variance {
                  value = 0
                }
              }
            }

            // No created_at column on metric_rollup: bucket_ts *is* the row's time, and a separate insert time would only invite confusion.
            db.add metric_rollup {
              data = {
                device_id     : $b.device_id
                metric_key    : $b.metric_key
                bucket_ts     : $b.bucket_start
                bucket_seconds: 300
                avg_value     : $avg|round:4
                min_value     : $b.min
                max_value     : $b.max
                last_value    : $b.last
                stddev        : ($variance|sqrt)|round:4
                sample_count  : $n
              }
            } as $rollup

            math.add $written {
              value = 1
            }
          }
        }
      }
    }

    // The skip counts are the interesting half of this line: a run that keeps deferring is a run that needs a bigger cap or a shorter interval.
    debug.log {
      value = "task_rollup_metrics: read " ~ (($readings|count)|to_text) ~ "/" ~ ($available|to_text) ~ " reading(s) over " ~ ($distinct_buckets|to_text) ~ " bucket(s), wrote " ~ ($written|to_text) ~ " rollup(s), deferred " ~ ($deferred|to_text) ~ " incomplete bucket(s), skipped " ~ ($skipped_values|to_text) ~ " non-numeric value(s)."
    }

    // Audited only when rows were written, and the detail is deliberately the skip counts as well as the write count - "how much did this run leave behind" is the question an operator will actually ask.
    conditional {
      if ($written > 0) {
        function.run "Nerve/fn_audit" {
          input = {
            action     : "metric.rollup"
            entity_type: "metric_rollup"
            detail     : {
              rollups_written    : $written
              readings_read      : $readings|count
              readings_available : $available
              buckets_seen       : $distinct_buckets
              buckets_deferred   : $deferred
              non_numeric_skipped: $skipped_values
              window_from_ms     : $from_ms
              window_to_ms       : $current_bucket_start
            }
            source     : "task"
          }
        } as $audit
      }
    }
  }

  schedule = [{starts_on: 2026-09-03 00:00:00+0000, freq: 300}]
  tags = ["nerve"]
}
