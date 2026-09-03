// One rule firing against one device. Alerts are the raw signal; incident is the
// human-facing unit of work they get folded into.
table alert {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int alert_rule_id? {
      table = "alert_rule"
    }

    int device_id {
      table = "device"
    }

    int incident_id? {
      table = "incident"
    }

    text metric_key? filters=trim
    decimal? observed_value?
    decimal? threshold?
    decimal? z_score?

    enum severity?=warning {
      values = ["critical", "warning", "info"]
    }

    enum state?=firing {
      values = ["firing", "acknowledged", "resolved"]
    }

    timestamp fired_at?=now
    timestamp? resolved_at?
    timestamp? acknowledged_at?

    int acked_by? {
      table = "user"
    }

    text message?

    // The window of readings that fired it: what the AI reasons over, and what an
    // operator needs in order to judge whether it is real.
    json context?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "state"}]}
    {type: "btree", field: [{name: "device_id"}]}
    {type: "btree", field: [{name: "incident_id"}]}
    {type: "btree", field: [{name: "severity"}]}
    {type: "btree", field: [{name: "fired_at", op: "desc"}]}
    {type: "btree", field: [{name: "alert_rule_id"}]}
  ]

  tags = ["nerve"]
  guid = "o2zJdtV8-xNKffTHO5qOvEcbbw4"
}
