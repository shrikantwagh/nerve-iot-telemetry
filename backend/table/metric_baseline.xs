// Learned per-device, per-metric baseline. This is what replaces hand-tuned thresholds.
//
// EWMA mean and EWMV variance are updated incrementally on every reading, so detection
// costs O(1) per sample and needs no historical scan. A reading is anomalous when
// |x - ewma| / sqrt(ewmv) exceeds the rule z threshold. Each device learns its own
// normal, which is why one hot-running motor does not have to be configured as an
// exception.
table metric_baseline {
  auth = false

  schema {
    int id

    int device_id {
      table = "device"
    }

    text metric_key filters=trim

    // Exponentially weighted moving average and variance.
    decimal ewma?=0
    decimal ewmv?=0

    // Smoothing factor. Lower means longer memory.
    decimal alpha?=0.05

    int sample_count?=0
    decimal? last_value?
    timestamp? updated_at?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "device_id", op: "asc"}, {name: "metric_key", op: "asc"}]}
  ]

  tags = ["nerve"]
  guid = "758JsuaBf1Z2sIgfeBslHWgh9wU"
}
