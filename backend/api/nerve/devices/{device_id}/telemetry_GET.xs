// Chart data for one device. Reads raw telemetry for narrow windows and pre-built 5-minute rollups for wide ones, so a "last 7 days" chart costs the same as a "last 30 minutes" chart. The unit and nominal band come out of the device type's metric_schema, so the frontend never hard-codes what a metric means.
query "devices/{device_id}/telemetry" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    int device_id { table = "device" }

    // One key, or a comma-separated list for an overlaid multi-metric chart ("temp_c,door_open").
    text metric_key

    // Defaults to 24 hours before `to`.
    timestamp? from?

    // Defaults to now.
    timestamp? to?

    // auto picks raw or rollup from the window width. raw and rollup force the source, which is what makes a "why does the chart look smoothed" question answerable.
    text resolution?=auto
  }

  stack {
    // Establishes the device exists and, more importantly, which type supplies the metric_schema below.
    db.get device {
      field_name = "id"
      field_value = $input.device_id
      output = ["id", "name", "serial", "device_type_id", "site_id"]
    } as $device

    precondition ($device != null) {
      error_type = "notfound"
      error = "Device not found."
    }

    // metric_schema is the whole point of this read: it carries unit, label, kind and the nominal band the chart draws behind the line.
    db.get device_type {
      field_name = "id"
      field_value = $device.device_type_id
      output = ["id", "code", "name", "category", "metric_schema"]
    } as $device_type

    // index_by groups into arrays per key, so each lookup below takes |first. A type with no schema yields an empty index and the series still return, just without a unit or a band.
    var $schema_index {
      value = ($device_type.metric_schema|first_notnull:[])|index_by:"key"
    }

    // Window resolution: `to` defaults to now, `from` to 24 hours before it. 24h is the default because it is the window that contains both a shift change and an overnight drift.
    var $to_ts {
      value = "now"
    }

    conditional {
      if ($input.to != null) {
        var.update $to_ts {
          value = $input.to
        }
      }
    }

    var $from_ts {
      value = $to_ts|add_secs_to_timestamp:-86400
    }

    conditional {
      if ($input.from != null) {
        var.update $from_ts {
          value = $input.from
        }
      }
    }

    // An inverted window returns nothing and looks like missing data, so it is rejected loudly instead.
    precondition (($from_ts|to_ms) < ($to_ts|to_ms)) {
      error_type = "inputerror"
      error = "from must be earlier than to."
    }

    var $window_seconds {
      value = (($to_ts|to_ms) - ($from_ts|to_ms)) / 1000
    }

    // THE THRESHOLD: 3 hours (10800s). At the simulator's 10-second cadence a 3-hour window is ~1080 raw readings per metric - enough to show a real waveform, few enough that the (device_id, ts) index scan is cheap and the payload stays under the point cap without throwing detail away. Past 3 hours raw rows outgrow what a chart can draw (24h is ~8600 rows for one metric) so metric_rollup's 5-minute buckets are read instead: 24h becomes 288 points, and because the buckets carry min_value and max_value the spikes that a plain average would erase are still drawn as a band.
    var $raw_threshold_seconds {
      value = 10800
    }

    // Points per series actually returned. Anything denser than this is invisible on a screen and only costs bandwidth.
    var $point_cap {
      value = 500
    }

    // Rows fetched before downsampling. Raw is held tighter than rollup because raw rows are wide json and there are far more of them.
    var $raw_row_cap {
      value = 1200
    }

    var $rollup_row_cap {
      value = 2000
    }

    // auto is the decision above; raw and rollup are explicit operator overrides, which exist so "the chart is smoothing my spike" can be checked rather than argued about.
    var $source {
      value = "rollup"
    }

    conditional {
      if ($input.resolution == "raw") {
        var.update $source {
          value = "raw"
        }
      }
      elseif ($input.resolution == "rollup") {
        var.update $source {
          value = "rollup"
        }
      }
      elseif ($window_seconds <= $raw_threshold_seconds) {
        var.update $source {
          value = "raw"
        }
      }
    }

    // A comma list is split, trimmed and de-duplicated. filter_empty drops the blanks a trailing comma leaves behind.
    var $raw_keys {
      value = $input.metric_key|split:","
    }

    var $trimmed_keys {
      value = []
    }

    foreach ($raw_keys) {
      each as $raw_key {
        array.push $trimmed_keys {
          value = $raw_key|trim
        }
      }
    }

    // Capped at six: this is an overlaid chart, and beyond six lines nobody can read it anyway. The cap also bounds the per-key work below.
    var $keys {
      value = (($trimmed_keys|filter_empty)|unique)|slice:0:6
    }

    precondition (($keys|count) > 0) {
      error_type = "inputerror"
      error = "metric_key is required (one key, or a comma-separated list)."
    }

    // Set by whichever branch below hits its row cap, and echoed in the response so a clipped chart is labelled rather than silently wrong.
    var $truncated {
      value = false
    }

    // Reported so a caller can tell "no data" from "downsampled 4:1".
    var $stride {
      value = 1
    }

    var $series {
      value = []
    }

    conditional {
      if ($source == "raw") {
        // One read for every requested metric: telemetry is wide format, so every key in this window is already in these rows and a per-key query would re-scan the same index range N times. metadata off - the caller gets points, not a paging envelope.
        db.query telemetry {
          where = $db.telemetry.device_id == $input.device_id && $db.telemetry.ts >= $from_ts && $db.telemetry.ts <= $to_ts
          sort = {telemetry.ts: "asc"}
          output = ["ts", "metrics"]
          return = {type: "list", paging: {page: 1, per_page: $raw_row_cap, metadata: false}}
        } as $raw_rows

        var $raw_count {
          value = $raw_rows|count
        }

        conditional {
          if ($raw_count >= $raw_row_cap) {
            var.update $truncated {
              value = true
            }
          }
        }

        // Downsample by stride rather than by slicing, so a clipped series still spans the whole requested window instead of showing only its first few minutes.
        conditional {
          if ($raw_count > $point_cap) {
            var.update $stride {
              value = (($raw_count / $point_cap)|ceil)|to_int
            }
          }
        }

        // Keys outer, rows inner. This is O(keys x rows) - bounded at 6 x 1200 by the caps above - and is the price of not issuing one query per key against the largest table in the instance.
        foreach ($keys) {
          each as $key {
            var $schema_matches {
              value = $schema_index|get:$key:[]
            }

            var $schema_entry {
              value = $schema_matches|first
            }

            var $points {
              value = []
            }

            // Row position within the result, used for the stride test. Reset per key so every series is sampled at the same offsets and the overlaid lines stay aligned.
            var $row_index {
              value = 0
            }

            foreach ($raw_rows) {
              each as $row {
                var $value {
                  value = $row.metrics|get:$key
                }

                var $keep {
                  value = ($row_index|mod:$stride) == 0
                }

                // A metric absent from a reading is skipped rather than plotted as zero - a gap in a chart is honest, a zero is a lie.
                conditional {
                  if ($value != null && $keep) {
                    array.push $points {
                      value = {
                        ts   : $row.ts
                        value: $value
                        min  : $value
                        max  : $value
                      }
                    }
                  }
                }

                math.add $row_index {
                  value = 1
                }
              }
            }

            // min and max equal value on the raw path: a single reading has no spread. They are still emitted so the client renders one shape for both sources.
            array.push $series {
              value = {
                metric_key : $key
                label      : $schema_entry|get:"label":$key
                unit       : $schema_entry|get:"unit"
                kind       : $schema_entry|get:"kind"
                nominal_min: $schema_entry|get:"nominal_min"
                nominal_max: $schema_entry|get:"nominal_max"
                precision  : $schema_entry|get:"precision"
                point_count: $points|count
                points     : $points
              }
            }
          }
        }
      }
      else {
        // Rollups are queried per key because metric_rollup is long format and its composite index is (device_id, metric_key, bucket_ts) - one query per key uses that index exactly, where a single query could not.
        foreach ($keys) {
          each as $key {
            var $schema_matches {
              value = $schema_index|get:$key:[]
            }

            var $schema_entry {
              value = $schema_matches|first
            }

            db.query metric_rollup {
              where = $db.metric_rollup.device_id == $input.device_id && $db.metric_rollup.metric_key == $key && $db.metric_rollup.bucket_ts >= $from_ts && $db.metric_rollup.bucket_ts <= $to_ts
              sort = {metric_rollup.bucket_ts: "asc"}
              output = ["bucket_ts", "avg_value", "min_value", "max_value", "sample_count"]
              return = {type: "list", paging: {page: 1, per_page: $rollup_row_cap, metadata: false}}
            } as $buckets

            var $bucket_count {
              value = $buckets|count
            }

            // 2000 five-minute buckets is about a week. A longer window clips, and says so.
            conditional {
              if ($bucket_count >= $rollup_row_cap) {
                var.update $truncated {
                  value = true
                }
              }
            }

            var $key_stride {
              value = 1
            }

            conditional {
              if ($bucket_count > $point_cap) {
                var.update $key_stride {
                  value = (($bucket_count / $point_cap)|ceil)|to_int
                }
              }
            }

            // Reported at the top level; with one key this is exact, with several it is the last key's stride.
            var.update $stride {
              value = $key_stride
            }

            var $points {
              value = []
            }

            var $bucket_index {
              value = 0
            }

            foreach ($buckets) {
              each as $bucket {
                var $keep {
                  value = ($bucket_index|mod:$key_stride) == 0
                }

                // value is the bucket average; min and max are carried through so the chart can shade the range the average hides. An empty bucket (sample_count 0) is skipped for the same reason a missing raw reading is.
                conditional {
                  if ($keep && ($bucket.avg_value != null)) {
                    array.push $points {
                      value = {
                        ts          : $bucket.bucket_ts
                        value       : $bucket.avg_value
                        min         : $bucket.min_value
                        max         : $bucket.max_value
                        sample_count: $bucket.sample_count
                      }
                    }
                  }
                }

                math.add $bucket_index {
                  value = 1
                }
              }
            }

            array.push $series {
              value = {
                metric_key : $key
                label      : $schema_entry|get:"label":$key
                unit       : $schema_entry|get:"unit"
                kind       : $schema_entry|get:"kind"
                nominal_min: $schema_entry|get:"nominal_min"
                nominal_max: $schema_entry|get:"nominal_max"
                precision  : $schema_entry|get:"precision"
                point_count: $points|count
                points     : $points
              }
            }
          }
        }
      }
    }
  }

  // point_cap, stride and truncated are all returned rather than hidden: a chart that has been downsampled or clipped should be able to label itself, because "the spike is missing" is otherwise indistinguishable from "there was no spike".
  response = {
    device_id      : $input.device_id
    device_name    : $device.name
    from           : $from_ts
    to             : $to_ts
    window_seconds : $window_seconds
    source         : $source
    resolution     : $input.resolution
    bucket_seconds : 300
    point_cap      : $point_cap
    stride         : $stride
    truncated      : $truncated
    series         : $series
  }
  tags = ["nerve"]
}
