// Retire an ingest credential. Soft-disable, never delete: every alert and telemetry row this key produced references it, and hard-deleting the row would turn that history into unexplainable orphans.
query "api-keys/{key_id}" verb=DELETE {
  api_group = "Nerve"
  auth = "user"

  input {
    // Path parameter typed as a reference so the language server knows which table it points at.
    int key_id { table = "api_key" }
  }

  stack {
    // Role read fresh from the row, so a demotion takes effect immediately.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    // Valid token, deleted account.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "The account for this token no longer exists."
    }

    // Inline rather than via the quick-start enforce_role helper, which only knows admin/member.
    precondition ($user.role == "admin") {
      error_type = "accessdenied"
      error = "Admin role required."
    }

    // Revoking ingest for the whole fleet is exactly the kind of thing a shared read-only demo account must not be able to do.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Read before write so the audit row can record what was disabled, and so an unknown id 404s instead of silently succeeding.
    db.get api_key {
      field_name = "id"
      field_value = $input.key_id
      output = ["id", "name", "key_prefix", "site_id", "enabled", "use_count"]
    } as $key

    // A patch against a missing id would report success without changing anything.
    precondition ($key != null) {
      error_type = "notfound"
      error = "No API key with that id."
    }

    // Patch rather than edit: only `enabled` changes, and every other column stays as the historical record of this credential.
    db.patch api_key {
      field_name = "id"
      field_value = $input.key_id
      data = {enabled: false}
    } as $disabled

    // Revocation is a security event; the prior state is recorded so a repeat call is distinguishable from the first one.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $user.id
        action     : "api_key.disable"
        entity_type: "api_key"
        entity_id  : $key.id
        detail     : {name: $key.name, key_prefix: $key.key_prefix, was_enabled: $key.enabled, use_count: $key.use_count}
        source     : "ui"
      }
    } as $audit
  }

  response = {
    id: $key.id
    name: $key.name
    key_prefix: $key.key_prefix
    enabled: false
    was_enabled: $key.enabled
    note: "Disabled, not deleted. Telemetry and alerts already attributed to this key keep their reference."
  }
  tags = ["nerve"]
  guid = "3I4ydSiwAI9Hvc2fivo_SBLPAlo"
}
