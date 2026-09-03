// A monitoring rule.
//
// natural_language_source keeps the English sentence a human typed when the rule was
// created through the AI composer, so six months later the rule explains itself instead
// of being an anonymous "temp_c > -15".
table alert_rule {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    text name filters=trim
    text description?

    // Scope: any of these may be null, which widens the rule. All null = whole fleet.
    int device_type_id? {
      table = "device_type"
    }

    int device_id? {
      table = "device"
    }

    int site_id? {
      table = "site"
    }

    text metric_key? filters=trim

    enum condition {
      values = ["gt", "lt", "outside_range", "rate_of_change", "flatline", "offline", "anomaly"]
    }

    decimal? threshold?
    decimal? threshold_high?

    // Sustain period: the condition must hold this long before firing, which is what
    // keeps a single noisy sample from paging anyone.
    int window_seconds?=0

    // Sigma multiple for anomaly rules.
    decimal z_threshold?=3

    enum severity?=warning {
      values = ["critical", "warning", "info"]
    }

    bool enabled?=true
    int cooldown_seconds?=900

    int created_by? {
      table = "user"
    }

    text natural_language_source?
    bool ai_generated?=false
    timestamp? last_fired_at?
    int fire_count?=0
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "enabled"}]}
    {type: "btree", field: [{name: "metric_key", op: "asc"}]}
    {type: "btree", field: [{name: "device_type_id"}]}
    {type: "btree", field: [{name: "site_id"}]}
    {type: "btree", field: [{name: "device_id"}]}
  ]

  tags = ["nerve"]
}
