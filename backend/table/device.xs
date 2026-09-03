// A single monitored device.
//
// `metrics_latest` is deliberately denormalized: the fleet grid needs the newest reading
// for every device, and reading it off the device row makes that one query instead of one
// per device against the telemetry table.
table device {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    text serial filters=trim
    text name filters=trim

    int device_type_id {
      table = "device_type"
    }

    int site_id {
      table = "site"
    }

    enum status?=provisioning {
      values = ["online", "degraded", "offline", "maintenance", "provisioning"]
    }

    text firmware_version? filters=trim
    text location_label? filters=trim
    timestamp? last_seen_at?

    // 0-100 composite of recency, alert load and how far metrics sit from nominal.
    decimal health_score?=100

    date? install_date?
    json tags?
    text notes?

    // True when the device provisioned itself through the ingest API rather than the UI.
    bool auto_provisioned?=false

    // Newest reading, as {metric_key: value}.
    json metrics_latest?

    // Gateway this device reports through, when it is behind one. Used to explain a
    // cascade ("40 devices offline") as one gateway fault.
    int uplink_device_id? {
      table = "device"
    }
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "serial", op: "asc"}]}
    {type: "btree", field: [{name: "site_id"}]}
    {type: "btree", field: [{name: "device_type_id"}]}
    {type: "btree", field: [{name: "status"}]}
    {type: "btree", field: [{name: "last_seen_at", op: "desc"}]}
    {type: "btree", field: [{name: "health_score", op: "asc"}]}
  ]

  tags = ["nerve"]
}
