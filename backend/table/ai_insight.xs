// Every AI inference, logged.
//
// This table is the honesty mechanism. Model, token counts, latency and whether the
// deterministic fallback ran are all recorded, so nobody has to take an AI claim on
// faith: you can see which model produced it, when, from what, and how sure it was.
// It also makes the AI cost of the product measurable instead of a mystery line item.
table ai_insight {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    enum kind {
      values = ["fleet_digest", "predictive_maintenance", "anomaly_explanation", "incident_triage", "postmortem", "rule_synthesis", "nl_query"]
    }

    int device_id? {
      table = "device"
    }

    int incident_id? {
      table = "incident"
    }

    text title? filters=trim
    text body?
    decimal? confidence?
    json payload?

    text model? filters=trim
    int input_tokens?=0
    int output_tokens?=0
    int latency_ms?=0

    // True when the LLM call failed or no key was configured and the deterministic
    // analyzer produced this instead. A demo must never dead-end on a 429.
    bool fallback_used?=false
    text error?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "kind"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "incident_id"}]}
    {type: "btree", field: [{name: "device_id"}]}
  ]

  tags = ["nerve"]
}
