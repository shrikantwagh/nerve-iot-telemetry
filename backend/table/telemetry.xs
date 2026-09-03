// Raw time-series readings, wide format: one row per reading, all metrics in one json
// object.
//
// Wide beats long here. A 12-metric device costs one insert instead of twelve, which is
// what lets a free-tier instance absorb the ingest rate of a real fleet. Per-metric reads
// are served by metric_rollup, and the fleet grid never touches this table at all.
table telemetry {
  auth = false

  schema {
    int id

    int device_id {
      table = "device"
    }

    // Device-reported time, not receipt time, so backfill and clock skew stay honest.
    timestamp ts

    // {metric_key: value}
    json metrics

    // Anything the ingest path noticed: anomaly keys, out-of-range keys, clamped values.
    json flags?

    int ingest_latency_ms?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "device_id", op: "asc"}, {name: "ts", op: "desc"}]}
    {type: "btree", field: [{name: "ts", op: "desc"}]}
  ]

  tags = ["nerve"]
  guid = "uX6AlOysxfYD3PLNxFUYKKeMVtE"
}
