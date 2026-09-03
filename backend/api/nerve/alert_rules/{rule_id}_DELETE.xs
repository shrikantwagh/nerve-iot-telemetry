// Deleting a rule that has fired takes its alerts' provenance with it - alert.alert_rule_id is the only link back to why anyone was paged. So a rule with history is refused by default and the operator is pointed at enabled=false, which is what "delete this rule" almost always means.
query "alert-rules/{rule_id}" verb=DELETE {
  api_group = "Nerve"
  auth = "user"

  input {
    int rule_id { table = "alert_rule" }

    // Off by default so the destructive path is chosen rather than stumbled into. With force, the referencing alerts are detached (alert_rule_id nulled) rather than deleted - the alert history survives, it just loses its rule.
    bool force?=false
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

    // Rules decide who gets paged, so removing them is an operator action.
    precondition (($user.role == "operator") || ($user.role == "admin")) {
      error_type = "accessdenied"
      error = "Operator role or higher is required to delete alert rules."
    }

    // The judge-facing demo login is read-only, per the Nerve conventions in SYNTAX_CONTRACT s7.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Read before delete so the audit row can record what the rule actually was; after db.del there is nothing left to describe.
    db.get alert_rule {
      field_name = "id"
      field_value = $input.rule_id
    } as $rule

    precondition ($rule != null) {
      error_type = "notfound"
      error = "Alert rule not found."
    }

    db.query alert {
      where = $db.alert.alert_rule_id == $input.rule_id
      return = {type: "count"}
    } as $alert_count

    // Refuse rather than cascade. The alert history is the audit trail for every page this rule ever sent, and a foreign key error at delete time is a worse way to learn that.
    precondition (($alert_count == 0) || ($input.force == true)) {
      error_type = "inputerror"
      error = "This rule still owns " ~ ($alert_count|to_text) ~ " alerts. Set enabled=false to retire it and keep the history, or pass force=true to detach those alerts and delete anyway."
    }

    // Reported back so the operator sees the cost of the force they just used.
    var $detached {
      value = 0
    }

    // Detach in a transaction with the delete: an interrupted run that nulled half the references and left the rule in place would be indistinguishable from data corruption.
    db.transaction {
      stack {
        conditional {
          if ($alert_count > 0) {
            db.query alert {
              where = $db.alert.alert_rule_id == $input.rule_id
              return = {type: "list"}
              output = ["id"]
            } as $orphans

            foreach ($orphans) {
              each as $orphan {
                db.edit alert {
                  field_name = "id"
                  field_value = $orphan.id
                  data = {alert_rule_id: null}
                } as $detached_alert

                math.add $detached {
                  value = 1
                }
              }
            }
          }
        }

        db.del alert_rule {
          field_name = "id"
          field_value = $input.rule_id
        }
      }
    }

    // The whole rule goes into the detail, because after this there is no row left to look up.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "alert_rule.delete"
        entity_type: "alert_rule"
        entity_id  : $input.rule_id
        detail     : {deleted_rule: $rule, forced: $input.force, detached_alerts: $detached}
        source     : "ui"
      }
    } as $audit
  }

  response = {
    deleted        : true
    rule_id        : $input.rule_id
    detached_alerts: $detached
  }
  tags = ["nerve"]
  guid = "1VW5MA8-jSRYf9FVl_tqiJflfuE"
}
