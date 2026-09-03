// Partial edits are where rule validation usually leaks: patching only `threshold` on an outside_range rule has to be checked against the threshold_high already on the row, not against a null input. So everything below validates the MERGED rule, then writes only the fields the caller actually sent.
query "alert-rules/{rule_id}" verb=PATCH {
  api_group = "Nerve"
  auth = "user"

  input {
    int rule_id { table = "alert_rule" }

    text name? filters=trim|min:2|max:120

    text description? filters=trim|max:1000

    int device_type_id? { table = "device_type" }

    int device_id? { table = "device" }

    int site_id? { table = "site" }

    text metric_key? filters=trim|max:80

    // Declared as text rather than enum because PATCH needs "not supplied" to be distinguishable from a value, and an optional enum cannot express that. Membership is enforced by the switch default below, which is why the POST sibling runs the same switch.
    text condition? filters=trim

    decimal? threshold?

    decimal? threshold_high?

    int window_seconds? filters=min:0

    decimal? z_threshold?

    enum severity? { values = ["critical", "warning", "info"] }

    bool? enabled?

    int cooldown_seconds? filters=min:0

    text natural_language_source? filters=trim|max:1000
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

    // Rules decide who gets paged, so editing them is an operator action.
    precondition (($user.role == "operator") || ($user.role == "admin")) {
      error_type = "accessdenied"
      error = "Operator role or higher is required to edit alert rules."
    }

    // The judge-facing demo login is read-only, per the Nerve conventions in SYNTAX_CONTRACT s7.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    db.get alert_rule {
      field_name = "id"
      field_value = $input.rule_id
    } as $rule

    precondition ($rule != null) {
      error_type = "notfound"
      error = "Alert rule not found."
    }

    // Same existence checks as create: a scope pointed at a deleted row is a rule that silently stops firing.
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

    // The post-patch shape of the rule, which is the only thing worth validating. first_notnull means a caller cannot null a field back out through this endpoint - deliberate, since "omitted" and "clear this" would otherwise be the same request.
    var $eff_condition {
      value = $input.condition|first_notempty:$rule.condition
    }

    var $eff_metric_key {
      value = $input.metric_key|first_notempty:$rule.metric_key
    }

    var $eff_threshold {
      value = $input.threshold|first_notnull:$rule.threshold
    }

    var $eff_threshold_high {
      value = $input.threshold_high|first_notnull:$rule.threshold_high
    }

    var $eff_z_threshold {
      value = $input.z_threshold|first_notnull:$rule.z_threshold
    }

    // Byte-identical to the switch in alert_rules_POST. Duplicated rather than factored out because a shared validator would have to live in the functions lane, and the two lanes ship independently.
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

    switch ($eff_condition) {
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

      // fn_evaluate_rules gates rate_of_change on a non-null threshold, so without one the rule is inert.
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
        // This arm is the enum enforcement for PATCH, since a `text condition?` input cannot do it at the input layer.
        throw {
          name = "inputerror"
          value = "condition must be one of gt, lt, outside_range, rate_of_change, flatline, offline, anomaly."
        }
      }
    }

    precondition (($needs_metric_key == false) || !($eff_metric_key|is_empty)) {
      error_type = "inputerror"
      error = "metric_key is required for the " ~ ($eff_condition|to_text) ~ " condition."
    }

    precondition (($needs_threshold == false) || ($eff_threshold != null)) {
      error_type = "inputerror"
      error = "threshold is required for the " ~ ($eff_condition|to_text) ~ " condition."
    }

    precondition (($needs_threshold_high == false) || ($eff_threshold_high != null)) {
      error_type = "inputerror"
      error = "threshold_high is required for the outside_range condition."
    }

    // Reached only once both bounds are known non-null. An inverted range fires on every reading.
    precondition (($needs_threshold_high == false) || ($eff_threshold_high > $eff_threshold)) {
      error_type = "inputerror"
      error = "threshold_high must be greater than threshold."
    }

    precondition (($needs_z == false) || (($eff_z_threshold != null) && ($eff_z_threshold > 0))) {
      error_type = "inputerror"
      error = "z_threshold must be greater than 0 for the anomaly condition."
    }

    // Built field by field so an omitted input leaves the column alone. db.patch takes the object as a variable, which is exactly this shape.
    var $updates {
      value = {}
    }

    conditional {
      if ($input.name != null) {
        var.update $updates {
          value = $updates|set:"name":$input.name
        }
      }
    }

    conditional {
      if ($input.description != null) {
        var.update $updates {
          value = $updates|set:"description":$input.description
        }
      }
    }

    conditional {
      if ($input.device_type_id != null) {
        var.update $updates {
          value = $updates|set:"device_type_id":$input.device_type_id
        }
      }
    }

    conditional {
      if ($input.device_id != null) {
        var.update $updates {
          value = $updates|set:"device_id":$input.device_id
        }
      }
    }

    conditional {
      if ($input.site_id != null) {
        var.update $updates {
          value = $updates|set:"site_id":$input.site_id
        }
      }
    }

    conditional {
      if ($input.metric_key != null) {
        var.update $updates {
          value = $updates|set:"metric_key":$input.metric_key
        }
      }
    }

    conditional {
      if ($input.condition != null) {
        var.update $updates {
          value = $updates|set:"condition":$input.condition
        }
      }
    }

    conditional {
      if ($input.threshold != null) {
        var.update $updates {
          value = $updates|set:"threshold":$input.threshold
        }
      }
    }

    conditional {
      if ($input.threshold_high != null) {
        var.update $updates {
          value = $updates|set:"threshold_high":$input.threshold_high
        }
      }
    }

    conditional {
      if ($input.window_seconds != null) {
        var.update $updates {
          value = $updates|set:"window_seconds":$input.window_seconds
        }
      }
    }

    conditional {
      if ($input.z_threshold != null) {
        var.update $updates {
          value = $updates|set:"z_threshold":$input.z_threshold
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

    // Explicitly null-checked rather than truthiness-checked, because false is the interesting value here - disabling a noisy rule is the most common edit this endpoint serves.
    conditional {
      if ($input.enabled != null) {
        var.update $updates {
          value = $updates|set:"enabled":$input.enabled
        }
      }
    }

    conditional {
      if ($input.cooldown_seconds != null) {
        var.update $updates {
          value = $updates|set:"cooldown_seconds":$input.cooldown_seconds
        }
      }
    }

    conditional {
      if ($input.natural_language_source != null) {
        var.update $updates {
          value = $updates|set:"natural_language_source":$input.natural_language_source
        }
      }
    }

    // An empty patch would write an audit row claiming a change that never happened.
    precondition (($updates|count) > 0) {
      error_type = "inputerror"
      error = "No updatable fields were supplied."
    }

    db.patch alert_rule {
      field_name = "id"
      field_value = $input.rule_id
      data = $updates
    } as $updated

    // Only the changed fields go into the audit detail, alongside the pre-edit row, so a reviewer can reconstruct the diff without a second query.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "alert_rule.update"
        entity_type: "alert_rule"
        entity_id  : $input.rule_id
        detail     : {changes: $updates, before: $rule}
        source     : "ui"
      }
    } as $audit
  }

  response = $updated
  tags = ["nerve"]
  guid = "A5SXJYWv10HmHRBhp2KCnXXybhw"
}
