// An action dispatched to a device. Commands are first-class so an operator can fix the
// problem from the incident view instead of switching to another tool.
table device_command {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int device_id {
      table = "device"
    }

    enum command {
      values = ["restart", "firmware_update", "calibrate", "set_config", "return_to_dock", "enter_maintenance", "clear_fault"]
    }

    json payload?

    enum state?=queued {
      values = ["queued", "sent", "acked", "failed", "expired"]
    }

    int issued_by? {
      table = "user"
    }

    int incident_id? {
      table = "incident"
    }

    timestamp? sent_at?
    timestamp? acked_at?
    json result?
    text note? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "device_id"}]}
    {type: "btree", field: [{name: "state"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]

  tags = ["nerve"]
}
