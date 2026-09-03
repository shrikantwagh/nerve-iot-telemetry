// Who did what.
//
// Separate from event_log (the Xano starter table) because this one records operator
// actions against the fleet: acking alerts, issuing a restart, rotating an API key. In an
// industrial context that trail is the difference between a tool ops can adopt and one
// compliance will not sign off on.
table audit_log {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int user_id? {
      table = "user"
    }

    text action filters=trim
    text entity_type? filters=trim
    int entity_id?

    json detail?
    text ip? filters=trim

    enum source?=ui {
      values = ["ui", "api", "task", "device", "system"]
    }
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "user_id"}]}
    {type: "btree", field: [{name: "action", op: "asc"}]}
    {type: "btree", field: [{name: "entity_type", op: "asc"}]}
  ]

  tags = ["nerve"]
}
