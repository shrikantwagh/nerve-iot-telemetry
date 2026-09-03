// List the ingest credentials. Admin-only, and the response is assembled field by field rather than filtered - a whitelist cannot leak a column somebody adds to the table next month, whereas a blacklist can.
query "api-keys" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    // Disabled keys are hidden by default so the admin screen shows the live surface, but they stay retrievable because ingest history references them.
    bool include_disabled?=false
  }

  stack {
    // Role lives on the user row, not in the token, so it is read fresh - a demotion must take effect immediately, not at next login.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    // A structurally valid token for a deleted account.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "The account for this token no longer exists."
    }

    // Written inline rather than delegated to the quick-start enforce_role helper, whose hierarchy is admin/member and knows nothing about Nerve's admin/operator/viewer.
    precondition ($user.role == "admin") {
      error_type = "accessdenied"
      error = "Admin role required."
    }

    // Parenthesised OR is how an optional filter is expressed in a where clause: with the flag set the clause is satisfied unconditionally, otherwise it pins enabled.
    db.query api_key {
      where = ($input.include_disabled == true) || ($db.api_key.enabled == true)
      sort = {api_key.created_at: "desc"}
      return = {type: "list"}
    } as $rows

    // Accumulator for the redacted view.
    var $items {
      value = []
    }

    // The one place key_hash could escape. Every field is named explicitly and key_hash is simply not among them.
    foreach ($rows) {
      each as $row {
        array.push $items {
          value = {
            id          : $row.id
            created_at  : $row.created_at
            name        : $row.name
            key_prefix  : $row.key_prefix
            site_id     : $row.site_id
            created_by  : $row.created_by
            enabled     : $row.enabled
            last_used_at: $row.last_used_at
            use_count   : $row.use_count
            scopes      : $row.scopes
          }
        }
      }
    }
  }

  response = {items: $items, count: ($items|count)}
  tags = ["nerve"]
}
