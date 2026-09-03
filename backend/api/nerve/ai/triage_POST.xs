// Force an incident-correlation sweep right now. The 2-minute cron already does this; the demo needs a button that makes forty alerts collapse into one incident while a judge is watching.
query "ai/triage" verb=POST {
  api_group = "Nerve"
  auth = "user"
  description = "Runs Nerve/fn_correlate on demand over a recent window, grouping unattached firing alerts into incidents and asking Claude for a root-cause hypothesis on newly opened ones. Operator role or higher; the demo account is read-only because this creates incidents."

  input {
    // How far back to sweep. Defaults to fn_correlate's own 15-minute window; widened for a replay, narrowed to isolate a single fault injection.
    int lookback_seconds?=900

    // Set false to correlate without spending an inference - used when replaying a scenario repeatedly.
    bool call_ai?=true
  }

  stack {
    // Role and demo status both live on the user row, so one read serves both gates below.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    // A valid token for a deleted user is still an unauthenticated request.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user not found."
    }

    // Numeric ranks rather than string comparisons, so the gate reads as a threshold and a fourth role would not need new branches.
    var $role_levels {
      value = {viewer: 1, operator: 2, admin: 3}
    }

    // An unrecognised role scores 0 and is therefore denied - failing closed is the only safe default here.
    var $role_rank {
      value = $role_levels|get:$user.role:0
    }

    // Triage writes incident rows and links alerts to them; that is an operator action, not a viewer one.
    precondition ($role_rank >= 2) {
      error_type = "accessdenied"
      error = "Operator role or higher is required to run a triage sweep."
    }

    // This endpoint mutates fleet state (it opens incidents and reassigns alerts), so it is closed to the read-only demo account per the Nerve conventions.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Clamp before handing the value to fn_correlate: a 1-second window correlates nothing and a 30-day window would fold last month's noise into today's incident.
    var $lookback {
      value = $input.lookback_seconds
    }

    // Floor and ceiling applied as explicit branches - the scalar min/max filter aliases are rejected by the language server.
    conditional {
      if ($lookback < 60) {
        var.update $lookback {
          value = 60
        }
      }
      elseif ($lookback > 86400) {
        var.update $lookback {
          value = 86400
        }
      }
    }

    // The whole product in one call: grouping, incident reuse, AI hypothesis, deterministic fallback.
    function.run "Nerve/fn_correlate" {
      input = {
        lookback_seconds: $lookback
        call_ai         : $input.call_ai
      }
    } as $sweep

    // Who forced a sweep, when and with what window - correlation rewrites alert ownership, so it has to be answerable after the fact.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $user.id
        action     : "ai.triage"
        entity_type: "incident"
        entity_id  : ($sweep.incident_ids|first)
        detail     : {
          lookback_seconds : $lookback
          call_ai          : $input.call_ai
          incidents_created: $sweep.incidents_created
          incidents_touched: $sweep.incidents_touched
          alerts_grouped   : $sweep.alerts_grouped
          incident_ids     : $sweep.incident_ids
        }
        source     : "ui"
      }
    } as $audit

    // A one-line result the UI can toast without re-deriving it from the counters.
    var $summary {
      value = ($sweep.alerts_grouped|to_text) ~ " firing alert(s) grouped into " ~ ($sweep.incidents_touched|to_text) ~ " incident(s), " ~ ($sweep.incidents_created|to_text) ~ " newly opened."
    }

    // Zero is a legitimate outcome, not a failure - it means every firing alert is already attached to an incident.
    var $quiet {
      value = ($sweep.incidents_touched == 0)
    }
  }

  response = {
    success          : true
    summary          : $summary
    quiet            : $quiet
    lookback_seconds : $lookback
    incidents_created: $sweep.incidents_created
    incidents_touched: $sweep.incidents_touched
    alerts_grouped   : $sweep.alerts_grouped
    incident_ids     : $sweep.incident_ids
  }
  tags = ["nerve"]
  guid = "J9dYAn_8VjdkMSomFA60PZjw7JM"
}
