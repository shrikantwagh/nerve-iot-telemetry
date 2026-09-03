// A class of device. `metric_schema` is the declarative contract that makes onboarding
// one API call instead of six console screens: it tells the backend a class's units,
// nominal bands and hard sensor limits, and tells the frontend how to chart them.
table device_type {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    // Stable code devices reference when self-registering, e.g. "amr-ld250".
    text code filters=trim|lower

    text name filters=trim

    enum category {
      values = ["robot", "refrigeration", "hvac", "machine_tool", "power", "gateway", "other"]
    }

    text manufacturer? filters=trim
    text model? filters=trim
    text icon? filters=trim

    // Seconds of silence before the offline sweep marks a device of this class down.
    int offline_after_seconds?=300

    // [{key,label,unit,kind,nominal_min,nominal_max,hard_min,hard_max,precision}]
    json metric_schema?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "code", op: "asc"}]}
    {type: "btree", field: [{name: "category"}]}
  ]

  tags = ["nerve"]
  guid = "wT431g1pvVn0EC1jpbPVh4X_bXE"
}
