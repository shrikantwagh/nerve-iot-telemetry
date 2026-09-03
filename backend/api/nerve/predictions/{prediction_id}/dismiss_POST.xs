// Rejecting a forecast, on the record. A dismissal with a reason is how the predictor gets held to account - and it is also what stops task_predictive_sweep from re-opening the same prediction next hour, since its dedupe only looks for open rows.
query "predictions/{prediction_id}/dismiss" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    int prediction_id { table = "maintenance_prediction" }

    // Required, not optional. A dismissal without a reason is indistinguishable from someone clearing their queue, and the whole value of the audit trail here is being able to tell those apart.
    text reason
  }

  stack {
    // Role and demo flag live on the user row, not on the token.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Same operator-or-admin gate as scheduling: dismissing a failure forecast is as consequential as accepting one.
    precondition (($user.role == "admin") || ($user.role == "operator")) {
      error_type = "accessdenied"
      error = "Dismissing a prediction requires the operator or admin role."
    }

    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // A reason of spaces is not a reason.
    precondition (!(($input.reason|trim)|is_empty)) {
      error_type = "inputerror"
      error = "A dismissal reason is required."
    }

    db.get maintenance_prediction {
      field_name = "id"
      field_value = $input.prediction_id
    } as $prediction

    precondition ($prediction != null) {
      error_type = "notfound"
      error = "Prediction not found."
    }

    // Dismissing completed work would rewrite history; dismissing an already-dismissed row is a no-op worth rejecting so a double-click does not overwrite the first reason.
    precondition (($prediction.state == "open") || ($prediction.state == "scheduled")) {
      error_type = "inputerror"
      error = "Only open or scheduled predictions can be dismissed; this one is " ~ $prediction.state ~ "."
    }

    // maintenance_prediction has no dismissal columns, so the reason is folded into evidence alongside the fit it is rejecting - which is exactly where a reviewer will look for it.
    var $evidence {
      value = {}
    }

    // Built up from the existing object rather than replacing it: the fit inputs are the reason this dismissal can be judged later, and losing them would make the row worthless.
    conditional {
      if ($prediction.evidence != null) {
        var.update $evidence {
          value = $prediction.evidence
        }
      }
    }

    var.update $evidence {
      value = ((($evidence|set:"dismissed_reason":($input.reason|trim))|set:"dismissed_by":$auth.id)|set:"dismissed_by_name":$user.name)|set:"dismissed_at_ms":("now"|to_ms)
    }

    // scheduled_for and scheduled_by are deliberately left as-is: if this prediction was scheduled and is now being dismissed, who booked it is part of the story.
    db.edit maintenance_prediction {
      field_name = "id"
      field_value = $input.prediction_id
      data = {
        state   : "dismissed"
        evidence: $evidence
      }
    } as $updated

    // The audit row is the authoritative record of the reason; the evidence copy is the convenience one, so the queue UI can show it without a second fetch.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "prediction.dismiss"
        entity_type: "maintenance_prediction"
        entity_id  : $input.prediction_id
        detail     : {
          device_id           : $prediction.device_id
          component           : $prediction.component
          metric_key          : $prediction.metric_key
          previous_state      : $prediction.state
          reason              : $input.reason|trim
          confidence          : $prediction.confidence
          predicted_failure_at: $prediction.predicted_failure_at
          trend_slope         : $prediction.trend_slope
        }
        source     : "ui"
      }
    } as $audit
  }

  response = $updated
  tags = ["nerve"]
}
