// A rule that validates but can never fire is worse than a rejected one - it looks like coverage. Every constraint fn_evaluate_rules silently relies on (a threshold for the threshold conditions, a metric_key for everything except offline, a positive z) is enforced here, at the only point where a human is present to fix it.
query "alert-rules" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    text name filters=trim|min:2|max:120

    text description? filters=trim|max:1000

    // All three scope columns are optional and independent: null means wildcard, and fn_evaluate_rules ANDs them, so a rule may pin any combination.
    int device_type_id? { table = "device_type" }

    int device_id? { table = "device" }

    int site_id? { table = "site" }

    // The key inside telemetry.metrics that this rule reads. Required for every condition except offline.
    text metric_key? filters=trim|max:80

    // Declared as an enum so a bogus condition is rejected by the input layer before the stack runs; the switch below still re-checks it, because the PATCH sibling cannot use an enum and both must agree.
    enum condition { values = ["gt", "lt", "outside_range", "rate_of_change", "flatline", "offline", "anomaly"] }

    decimal? threshold?

    // Upper bound for outside_range only; ignored by every other condition.
    decimal? threshold_high?

    int window_seconds?=0 filters=min:0

    decimal z_threshold?=3

    enum severity?="warning" { values = ["critical", "warning", "info"] }

    bool enabled?=true

    // 15 minutes by default. Zero is allowed but means one alert per reading, which is the alert fatigue this product exists to remove.
    int cooldown_seconds?=900 filters=min:0

    // The English sentence a human (or the AI composer) typed. Kept so the rule stays self-documenting long after whoever wrote it has left.
    text natural_language_source? filters=trim|max:1000

    bool ai_generated?=false
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

    // Rules decide who gets paged, so authoring them is an operator action.
    precondition (($user.role == "operator") || ($user.role == "admin")) {
      error_type = "accessdenied"
      error = "Operator role or higher is required to create alert rules."
    }

    // The judge-facing demo login is read-only, per the Nerve conventions in SYNTAX_CONTRACT s7.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // A scope pinned to a row that does not exist is a rule that never fires. Catching it now beats debugging silence later.
    conditional {
      if ($input.device_id != null) {
        db.has device {
          field_name = "id"
          field_value = $input.device_id
        } as $device_exists

        precondition ($device_exists) {
          error_type = "inputerror"
          error = "device_id does not refer to an existing device."
        }
      }
    }

    conditional {
      if ($input.device_type_id != null) {
        db.has device_type {
          field_name = "id"
          field_value = $input.device_type_id
        } as $type_exists

        precondition ($type_exists) {
          error_type = "inputerror"
          error = "device_type_id does not refer to an existing device type."
        }
      }
    }

    conditional {
      if ($input.site_id != null) {
        db.has site {
          field_name = "id"
          field_value = $input.site_id
        } as $site_exists

        precondition ($site_exists) {
          error_type = "inputerror"
          error = "site_id does not refer to an existing site."
        }
      }
    }

    // The switch computes requirement flags instead of validating inline, so the preconditions below read as one flat list of rules rather than seven nested branches - and so the PATCH sibling can carry a byte-identical copy.
    var $needs_metric_key {
      value = true
    }

    var $needs_threshold {
      value = false
    }

    var $needs_threshold_high {
      value = false
    }

    var $needs_z {
      value = false
    }

    switch ($input.condition) {
      case ("gt") {
        var.update $needs_threshold {
          value = true
        }
      } break

      case ("lt") {
        var.update $needs_threshold {
          value = true
        }
      } break

      // Not in the brief's list, but fn_evaluate_rules gates rate_of_change on a non-null threshold too, so without one the rule is inert.
      case ("rate_of_change") {
        var.update $needs_threshold {
          value = true
        }
      } break

      case ("outside_range") {
        var.update $needs_threshold {
          value = true
        }

        var.update $needs_threshold_high {
          value = true
        }
      } break

      // The only condition that reads no threshold at all - it compares against the device's own learned baseline.
      case ("anomaly") {
        var.update $needs_z {
          value = true
        }
      } break

      case ("flatline") {
        var.update $needs_metric_key {
          value = true
        }
      } break

      // offline observes the absence of readings, so there is no metric to name.
      case ("offline") {
        var.update $needs_metric_key {
          value = false
        }
      } break

      default {
        throw {
          name = "inputerror"
          value = "condition must be one of gt, lt, outside_range, rate_of_change, flatline, offline, anomaly."
        }
      }
    }

    precondition (($needs_metric_key == false) || !($input.metric_key|is_empty)) {
      error_type = "inputerror"
      error = "metric_key is required for the " ~ ($input.condition|to_text) ~ " condition."
    }

    precondition (($needs_threshold == false) || ($input.threshold != null)) {
      error_type = "inputerror"
      error = "threshold is required for the " ~ ($input.condition|to_text) ~ " condition."
    }

    precondition (($needs_threshold_high == false) || ($input.threshold_high != null)) {
      error_type = "inputerror"
      error = "threshold_high is required for the outside_range condition."
    }

    // Reached only once both bounds are known non-null, so the comparison cannot be against a null. An inverted range would make the rule fire on every single reading.
    precondition (($needs_threshold_high == false) || ($input.threshold_high > $input.threshold)) {
      error_type = "inputerror"
      error = "threshold_high must be greater than threshold."
    }

    // Zero or negative sigma means every reading is an anomaly, which is the same failure as an inverted range.
    precondition (($needs_z == false) || (($input.z_threshold != null) && ($input.z_threshold > 0))) {
      error_type = "inputerror"
      error = "z_threshold must be greater than 0 for the anomaly condition."
    }

    db.add alert_rule {
      data = {
        created_at             : "now"
        name                   : $input.name
        description            : $input.description
        device_type_id         : $input.device_type_id
        device_id              : $input.device_id
        site_id                : $input.site_id
        metric_key             : $input.metric_key
        condition              : $input.condition
        threshold              : $input.threshold
        threshold_high         : $input.threshold_high
        window_seconds         : $input.window_seconds
        z_threshold            : $input.z_threshold
        severity               : $input.severity
        enabled                : $input.enabled
        cooldown_seconds       : $input.cooldown_seconds
        created_by             : $auth.id
        natural_language_source: $input.natural_language_source
        ai_generated           : $input.ai_generated
        fire_count             : 0
      }
    } as $rule

    // Who changed the paging policy, and to what, is the audit question that actually gets asked after a missed incident.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "alert_rule.create"
        entity_type: "alert_rule"
        entity_id  : $rule.id
        detail     : $rule
        source     : "ui"
      }
    } as $audit
  }

  response = $rule
  tags = ["nerve"]
}
