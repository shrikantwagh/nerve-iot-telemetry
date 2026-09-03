// Acknowledge means "a human owns this now". It deliberately does NOT clear the condition or rescore the device: an acked critical is still a critical, and pretending otherwise is how dashboards go green while the freezer keeps warming.
query "alerts/{alert_id}/ack" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    int alert_id { table = "alert" }

    // Folded into the audit detail rather than onto the alert row - alert.message belongs to the rule engine and overwriting it would destroy the evidence.
    text note? filters=trim|max:500
  }

  stack {
    // Role and demo gating both need the caller's own row, so one read serves both checks.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    // A valid token for a deleted user is unauthorized, not merely forbidden.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Viewers may read the triage queue but must not change its state.
    precondition (($user.role == "operator") || ($user.role == "admin")) {
      error_type = "accessdenied"
      error = "Operator role or higher is required to acknowledge alerts."
    }

    // The judge-facing demo login is read-only, per the Nerve conventions in SYNTAX_CONTRACT s7.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    db.get alert {
      field_name = "id"
      field_value = $input.alert_id
    } as $alert

    precondition ($alert != null) {
      error_type = "notfound"
      error = "Alert not found."
    }

    // Acking something already over is meaningless and would rewrite a resolved alert's timeline; acking twice is tolerated so a double-click is not an error.
    precondition ($alert.state != "resolved") {
      error_type = "inputerror"
      error = "This alert is already resolved."
    }

    db.edit alert {
      field_name = "id"
      field_value = $input.alert_id
      data = {
        state          : "acknowledged"
        acknowledged_at: "now"
        acked_by       : $auth.id
      }
    } as $acked

    // Who silenced what, and why, is the first question asked in any post-incident review.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "alert.ack"
        entity_type: "alert"
        entity_id  : $alert.id
        detail     : {
          device_id     : $alert.device_id
          incident_id   : $alert.incident_id
          metric_key    : $alert.metric_key
          severity      : $alert.severity
          previous_state: $alert.state
          note          : $input.note
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {alert: $acked, acked_by_name: $user.name}
  tags = ["nerve"]
  guid = "1azRl5PCe1x0jIiuVz35I3YmIvw"
}
