// Triage actions on an incident: take it, retitle it, escalate it, close it. Resolving is the one that does real work - an incident is not resolved while its alerts are still firing.
query "incidents/{incident_id}" verb=PATCH {
  api_group = "Nerve"
  auth = "user"
  description = "Operator+ update of an incident's state, assignee, title or severity. Resolving stamps resolved_at and resolves every member alert still firing, so the alert queue and the incident agree."

  input {
    // Path parameter.
    int incident_id {
      table = "incident"
    }

    // Workflow state. Moving to "resolved" triggers the alert cascade below.
    enum state? {
      values = ["open", "investigating", "mitigated", "resolved"]
    }

    // Assign to an operator. Pass 0 to leave it unassigned rather than null, since a null input is indistinguishable from an omitted one.
    int assigned_to?

    // The correlation engine's generated title is a starting point, not a verdict.
    text title? filters=trim

    // Manual escalation or de-escalation, which the correlation sweep will not overwrite for an already-open incident.
    enum severity? {
      values = ["critical", "warning", "info"]
    }
  }

  stack {
    // Role is read from the database, not from the token: a token minted before a demotion must not still carry operator rights.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    // A valid token for a deleted user is still an unauthenticated request.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Viewers can read every incident in this group and change none of them.
    precondition (($user.role == "operator") || ($user.role == "admin")) {
      error_type = "accessdenied"
      error = "Operator role required to modify an incident."
    }

    // The judges' shared login must not be able to mutate the demo out from under the next judge.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Load the current row before mutating so the audit entry can record what actually changed.
    db.get incident {
      field_name = "id"
      field_value = $input.incident_id
    } as $incident

    precondition ($incident != null) {
      error_type = "notfound"
      error = "Incident not found."
    }

    // Patch payload is built rather than passed straight through, so an omitted field is left alone instead of being nulled.
    var $updates {
      value = {}
    }

    conditional {
      if ($input.state != null) {
        var.update $updates {
          value = $updates|set:"state":$input.state
        }
      }
    }

    conditional {
      if ($input.assigned_to != null) {
        var.update $updates {
          value = $updates|set:"assigned_to":$input.assigned_to
        }
      }
    }

    conditional {
      if (!($input.title|is_empty)) {
        var.update $updates {
          value = $updates|set:"title":$input.title
        }
      }
    }

    conditional {
      if ($input.severity != null) {
        var.update $updates {
          value = $updates|set:"severity":$input.severity
        }
      }
    }

    // An empty PATCH is a client bug, not a no-op worth logging.
    precondition (($updates|count) > 0) {
      error_type = "inputerror"
      error = "Supply at least one of state, assigned_to, title or severity."
    }

    // Transition detection, because the cascade must run on the edge and not on every save of an already-resolved incident.
    var $is_resolving {
      value = ($input.state == "resolved") && ($incident.state != "resolved")
    }

    // Reopening matters too: a resolved_at left behind on a reopened incident makes the detail timeline lie.
    var $is_reopening {
      value = ($input.state != null) && ($input.state != "resolved") && ($incident.state == "resolved")
    }

    conditional {
      if ($is_resolving) {
        var.update $updates {
          value = $updates|set:"resolved_at":"now"
        }
      }
      elseif ($is_reopening) {
        var.update $updates {
          value = $updates|set:"resolved_at":null
        }
      }
    }

    // db.patch rather than db.edit: edit replaces the row, and this is a partial update by construction.
    db.patch incident {
      field_name = "id"
      field_value = $input.incident_id
      data = $updates
    } as $updated

    // Counted so the response can tell the operator how much the one click actually closed.
    var $alerts_resolved {
      value = 0
    }

    // Closing an incident whose alerts still fire would leave the alert queue contradicting the incident list, and the next correlation sweep would re-adopt those alerts into a new incident.
    conditional {
      if ($is_resolving) {
        db.query alert {
          where = $db.alert.incident_id == $input.incident_id && $db.alert.state != "resolved"
          return = {type: "list"}
        } as $open_alerts

        foreach ($open_alerts) {
          each as $alert {
            db.edit alert {
              field_name = "id"
              field_value = $alert.id
              data = {state: "resolved", resolved_at: "now"}
            } as $resolved_alert

            math.add $alerts_resolved {
              value = 1
            }
          }
        }
      }
    }

    // Before-and-after in one row, so the audit log answers "who closed this and what did it look like" without a second lookup.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "incident.update"
        entity_type: "incident"
        entity_id  : $input.incident_id
        detail     : {
          changes         : $updates
          previous_state  : $incident.state
          previous_severity: $incident.severity
          previous_assignee: $incident.assigned_to
          alerts_resolved : $alerts_resolved
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    incident       : $updated
    alerts_resolved: $alerts_resolved
    resolved       : $is_resolving
    reopened       : $is_reopening
  }
  tags = ["nerve"]
  guid = "sOw0MoUzR15gr0xvJEYxRpi0WMs"
}
