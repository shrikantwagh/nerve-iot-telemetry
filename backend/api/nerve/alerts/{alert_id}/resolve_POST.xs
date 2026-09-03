// Resolving an alert is the one place three pieces of state have to move together: the alert, the device's health score, and the parent incident. An incident that outlives its own alerts is exactly the stale-dashboard problem Nerve exists to fix, so the rollup happens here rather than in a sweep the operator has to wait for.
query "alerts/{alert_id}/resolve" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    int alert_id { table = "alert" }

    // Kept in the audit detail, not on the alert - the resolution note is about the human action, not the measurement.
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
      error = "Operator role or higher is required to resolve alerts."
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

    // Idempotent-looking double resolves would move resolved_at backwards and forwards, so reject rather than silently restamp.
    precondition ($alert.state != "resolved") {
      error_type = "inputerror"
      error = "This alert is already resolved."
    }

    db.edit alert {
      field_name = "id"
      field_value = $input.alert_id
      data = {
        state      : "resolved"
        resolved_at: "now"
      }
    } as $resolved

    // health_score and status are derived from firing alerts, so clearing one has to re-derive them or the fleet grid keeps showing a degraded device nobody can explain. This is also the only step here that can throw - it raises notfound if the alert points at a deleted device.
    function.run "Nerve/fn_compute_health" {
      input = {device_id: $alert.device_id}
    } as $health

    // Reported back so the client can show the incident closing without a second round trip.
    var $incident_resolved {
      value = false
    }

    // Only alerts carry the ground truth about whether an incident is over; the incident row is a summary and cannot know on its own.
    conditional {
      if ($alert.incident_id != null) {
        // Counts firing AND acknowledged: an acked-but-unresolved sibling means the incident is still live.
        db.query alert {
          where = $db.alert.incident_id == $alert.incident_id && $db.alert.state != "resolved"
          return = {type: "count"}
        } as $unresolved_count

        conditional {
          if ($unresolved_count == 0) {
            db.edit incident {
              field_name = "id"
              field_value = $alert.incident_id
              data = {
                state      : "resolved"
                resolved_at: "now"
              }
            } as $incident

            var.update $incident_resolved {
              value = true
            }
          }
        }
      }
    }

    // The audit row records the cascade, not just the alert edit, because that cascade is what a reviewer will question.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "alert.resolve"
        entity_type: "alert"
        entity_id  : $alert.id
        detail     : {
          device_id         : $alert.device_id
          incident_id       : $alert.incident_id
          metric_key        : $alert.metric_key
          severity          : $alert.severity
          previous_state    : $alert.state
          note              : $input.note
          device_health      : $health.health_score
          device_status     : $health.status
          incident_resolved : $incident_resolved
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    alert            : $resolved
    device_health    : $health
    incident_resolved: $incident_resolved
  }
  tags = ["nerve"]
}
