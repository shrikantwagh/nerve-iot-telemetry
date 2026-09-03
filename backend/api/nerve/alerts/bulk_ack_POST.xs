// Bulk ack is the escape valve for the 3am pile-up: the operator selects the noise, claims it in one call, and gets a count back. Wrapped in a transaction because a half-applied bulk ack leaves nobody sure which alerts they actually own.
query "alerts/bulk-ack" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    // Declared as int[] so Xano validates element types before the stack runs; min:1 rejects an empty selection instead of writing a pointless audit row.
    int[] alert_ids filters=min:1|max:500

    // Bulk acks almost always have one reason behind them, so capturing it once is worth more than a note per alert.
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

    // Declared outside the transaction so the counts survive to the response.
    var $changed {
      value = 0
    }

    // Echoed back so an optimistic UI can reconcile exactly which rows moved rather than refetching the page.
    var $changed_ids {
      value = []
    }

    // Not an error: a bulk ack submitted from a list that has since gone stale must not fail wholesale.
    var $skipped {
      value = 0
    }

    // All-or-nothing. The alternative is an operator who acked "most of" a storm and cannot tell which half.
    db.transaction {
      stack {
        foreach ($input.alert_ids) {
          each as $alert_id {
            db.get alert {
              field_name = "id"
              field_value = $alert_id
              output = ["id", "state"]
            } as $alert

            // Only firing alerts move. Already-acknowledged rows keep their original acked_by, because the first person to claim it is the one who owns it.
            conditional {
              if (($alert != null) && ($alert.state == "firing")) {
                db.edit alert {
                  field_name = "id"
                  field_value = $alert.id
                  data = {
                    state          : "acknowledged"
                    acknowledged_at: "now"
                    acked_by       : $auth.id
                  }
                } as $acked

                math.add $changed {
                  value = 1
                }

                array.push $changed_ids {
                  value = $alert.id
                }
              }
              else {
                math.add $skipped {
                  value = 1
                }
              }
            }
          }
        }
      }
    }

    // One audit row for one operator action. Per-alert rows here would bury the log under exactly the burst the operator was trying to clear.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "alert.bulk_ack"
        entity_type: "alert"
        detail     : {
          requested : ($input.alert_ids|count)
          changed   : $changed
          skipped   : $skipped
          alert_ids : $changed_ids
          note      : $input.note
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    requested: ($input.alert_ids|count)
    changed  : $changed
    skipped  : $skipped
    alert_ids: $changed_ids
  }
  tags = ["nerve"]
}
