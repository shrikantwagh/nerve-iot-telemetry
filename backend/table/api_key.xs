// Ingest credentials for devices. Devices authenticate with these, never with a user JWT
// they have no way to obtain. Only the hash is stored; plaintext is shown once at creation.
table api_key {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    text name filters=trim

    // First 8 chars, kept in the clear so a key is identifiable in the UI.
    text key_prefix filters=trim

    password key_hash

    int site_id? {
      table = "site"
    }

    int created_by? {
      table = "user"
    }

    bool enabled?=true
    timestamp? last_used_at?
    int use_count?=0
    json scopes?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "key_prefix", op: "asc"}]}
    {type: "btree", field: [{name: "enabled"}]}
  ]

  tags = ["nerve"]
  guid = "76I10iecRoCdgIee887rSnYczvw"
}
