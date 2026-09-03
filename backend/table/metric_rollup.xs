// Pre-aggregated 5-minute buckets, built by task_rollup_metrics.
//
// Charts read from here rather than from raw telemetry, so a 24-hour view is a few
// hundred rows instead of a few hundred thousand. That is the difference between a
// dashboard that feels instant and the "slow dashboards" complaint we are rebuilding
// away from.
table metric_rollup {
  auth = false

  schema {
    int id

    int device_id {
      table = "device"
    }

    text metric_key filters=trim

    // Start of the bucket window.
    timestamp bucket_ts

    int bucket_seconds?=300

    decimal? avg_value?
    decimal? min_value?
    decimal? max_value?
    decimal? last_value?
    decimal? stddev?
    int sample_count?=0
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "device_id", op: "asc"}, {name: "metric_key", op: "asc"}, {name: "bucket_ts", op: "desc"}]}
    {type: "btree", field: [{name: "bucket_ts", op: "desc"}]}
  ]

  tags = ["nerve"]
}
