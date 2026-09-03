// A forecast that something is going to fail, derived from a trend rather than a
// threshold breach.
//
// trend_slope is the measured rate of change per hour over the rollup window, so the
// prediction is falsifiable: you can check the arithmetic. The AI writes the
// recommendation; the maths decides whether there is one to write.
table maintenance_prediction {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int device_id {
      table = "device"
    }

    // Which part is implicated, e.g. "battery pack", "spindle bearing".
    text component filters=trim

    text metric_key? filters=trim

    // Units per hour, from a least-squares fit over metric_rollup.
    decimal? trend_slope?

    timestamp? predicted_failure_at?
    decimal? confidence?

    // The fit inputs, so the forecast can be checked: samples, r_squared, window, limit.
    json evidence?

    text recommended_action?

    enum state?=open {
      values = ["open", "scheduled", "dismissed", "completed"]
    }

    int scheduled_by? {
      table = "user"
    }

    timestamp? scheduled_for?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "device_id"}]}
    {type: "btree", field: [{name: "state"}]}
    {type: "btree", field: [{name: "predicted_failure_at", op: "asc"}]}
  ]

  tags = ["nerve"]
  guid = "lK84u4hw04ZMCKq314Ox_z8uoRo"
}
