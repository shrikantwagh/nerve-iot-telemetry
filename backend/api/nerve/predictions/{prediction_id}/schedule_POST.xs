// Accepting a forecast. This is the endpoint that turns "this bearing will fail in nine days" into a dated commitment, optionally with the machine told to expect it.
query "predictions/{prediction_id}/schedule" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    // Path parameter; the table reference is what makes it a real foreign key rather than a bare int.
    int prediction_id { table = "maintenance_prediction" }

    // When the work is booked for. Defaults below to 24 hours out, so a one-click "accept" from the queue is still a dated commitment rather than an open-ended one.
    timestamp? scheduled_for?

        // Set true to also queue an enter_maintenance command, so the device stops alerting the moment the technician arrives instead of paging someone mid-service.
    bool issue_command?=false

    // Free text carried onto the queued command and into the audit detail.
    text note?
  }

  stack {
    // Role and demo flag are not carried on the JWT, so the caller has to be read before anything is written.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    // A valid token for a deleted user is still an invalid actor.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Operator or admin. Checked inline rather than via Quick Start/enforce_role, which only knows the starter kit's admin/member hierarchy and has no notion of Nerve's viewer role.
    precondition (($user.role == "admin") || ($user.role == "operator")) {
      error_type = "accessdenied"
      error = "Scheduling maintenance requires the operator or admin role."
    }

    // The judges' one-click demo login must not be able to alter the fleet it is demonstrating.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    db.get maintenance_prediction {
      field_name = "id"
      field_value = $input.prediction_id
    } as $prediction

    precondition ($prediction != null) {
      error_type = "notfound"
      error = "Prediction not found."
    }

    // dismissed and completed are terminal. Re-scheduling a completed job would silently reopen finished work; rescheduling an already-scheduled one is legitimate, so that is allowed.
    precondition (($prediction.state == "open") || ($prediction.state == "scheduled")) {
      error_type = "inputerror"
      error = "Only open or already-scheduled predictions can be scheduled; this one is " ~ $prediction.state ~ "."
    }

    // Default to a day out. Not to the predicted failure time - booking the work for the moment the part is expected to break defeats the purpose of predicting it.
    var $when {
      value = "now"|add_secs_to_timestamp:86400
    }

    conditional {
      if ($input.scheduled_for != null) {
        var.update $when {
          value = $input.scheduled_for
        }
      }
    }

    // scheduled_by records who accepted the forecast, which is the accountability the audit log alone cannot give (the audit row says an action happened; this column says the commitment is owned).
    db.edit maintenance_prediction {
      field_name = "id"
      field_value = $input.prediction_id
      data = {
        state       : "scheduled"
        scheduled_for: $when
        scheduled_by: $auth.id
      }
    } as $updated

    // Declared out here so the response shape does not depend on which branch ran.
    var $command_id {
      value = null
    }

    conditional {
      if ($input.issue_command == true) {
        // Queued, not sent: the device picks it up and acks it via /ingest/command/ack. Deliberately no device.status write here - the hold belongs to the machine confirming it, not to the planner requesting it, or a device that never acks would look like it was on the bench.
        db.add device_command {
          data = {
            created_at: "now"
            device_id : $prediction.device_id
            command   : "enter_maintenance"
            payload   : {
              reason               : "scheduled_maintenance"
              prediction_id        : $input.prediction_id
              component            : $prediction.component
              metric_key           : $prediction.metric_key
              scheduled_for        : $when
              recommended_action   : $prediction.recommended_action
            }
            state     : "queued"
            issued_by : $auth.id
            note      : $input.note|first_notempty:("Scheduled maintenance for " ~ ($prediction.component|first_notempty:"predicted component"))
          }
        } as $command

        var.update $command_id {
          value = $command.id
        }
      }
    }

    // The forecast's own numbers go into the audit detail, so a later review can ask whether the prediction that justified the downtime was any good.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "prediction.schedule"
        entity_type: "maintenance_prediction"
        entity_id  : $input.prediction_id
        detail     : {
          device_id           : $prediction.device_id
          component           : $prediction.component
          metric_key          : $prediction.metric_key
          previous_state      : $prediction.state
          scheduled_for       : $when
          confidence          : $prediction.confidence
          predicted_failure_at: $prediction.predicted_failure_at
          command_issued      : $input.issue_command
          command_id          : $command_id
          note                : $input.note
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {prediction: $updated, command_id: $command_id}
  tags = ["nerve"]
}
