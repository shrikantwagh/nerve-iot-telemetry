// The rules screen has to answer "what is this rule actually watching, and is it noisy?" without a second call per row. Scope ids are resolved to names in the join and to a sentence in the loop, because a list of foreign keys is not a rules page.
query "alert-rules" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    // Nullable as well as optional: a bare `bool` would arrive as false and silently hide every enabled rule.
    bool? enabled?

    // Lets the device and site detail screens show "rules that apply here" from this same endpoint.
    int device_type_id? { table = "device_type" }

    int site_id? { table = "site" }

    int device_id? { table = "device" }
  }

  stack {
    // All three scope tables are left-joined because every scope column is nullable - a null scope is a wildcard, not a missing row, and an inner join would drop fleet-wide rules entirely.
    db.query alert_rule {
      join = {
        device_type: {table: "device_type", type: "left", where: $db.alert_rule.device_type_id == $db.device_type.id}
        site       : {table: "site", type: "left", where: $db.alert_rule.site_id == $db.site.id}
        device     : {table: "device", type: "left", where: $db.alert_rule.device_id == $db.device.id}
        user       : {table: "user", type: "left", where: $db.alert_rule.created_by == $db.user.id}
      }
      eval = {
        device_type_name: $db.device_type.name
        device_type_code: $db.device_type.code
        site_name       : $db.site.name
        site_code       : $db.site.code
        device_name     : $db.device.name
        device_serial   : $db.device.serial
        created_by_name : $db.user.name
      }
      where = ($db.alert_rule.enabled ==? $input.enabled) && ($db.alert_rule.device_type_id ==? $input.device_type_id) && ($db.alert_rule.site_id ==? $input.site_id) && ($db.alert_rule.device_id ==? $input.device_id)
      sort = {alert_rule.created_at: "desc"}
      return = {type: "list"}
    } as $rules

    // Enriched copies rather than in-place edits, so the joined row is never partially rewritten.
    var $enriched {
      value = []
    }

    // How many rules have actually paged somebody - the headline number for judging whether the rule set is tuned.
    var $rules_that_have_fired {
      value = 0
    }

    foreach ($rules) {
      each as $rule {
        // Widest scope first, so the sentence degrades to something true rather than empty when a name is missing.
        var $scope_label {
          value = "every device in the fleet"
        }

        // Hoisted out of the string concatenations below, because a filter argument that is itself a concatenation does not read unambiguously.
        var $device_label {
          value = $rule.device_name|first_notempty:"an unnamed device"
        }

        var $type_label {
          value = $rule.device_type_name|first_notempty:"a device type"
        }

        var $site_label {
          value = $rule.site_name|first_notempty:"a site"
        }

        // Most specific wins. Type-plus-site is called out separately because it is the combination the seeded demo rules use and "all freezers at Osaka" is the sentence an operator recognises.
        conditional {
          if ($rule.device_id != null) {
            var.update $scope_label {
              value = $device_label
            }
          }
          elseif (($rule.device_type_id != null) && ($rule.site_id != null)) {
            var.update $scope_label {
              value = "every " ~ $type_label ~ " at " ~ $site_label
            }
          }
          elseif ($rule.device_type_id != null) {
            var.update $scope_label {
              value = "every " ~ $type_label ~ " in the fleet"
            }
          }
          elseif ($rule.site_id != null) {
            var.update $scope_label {
              value = "every device at " ~ $site_label
            }
          }
        }

        // Same idea for the condition: the operator should not have to mentally join `condition` to `threshold` and `threshold_high`.
        var $metric_label {
          value = $rule.metric_key|first_notempty:"heartbeat"
        }

        var $condition_label {
          value = $metric_label ~ " " ~ ($rule.condition|to_text)
        }

        switch ($rule.condition) {
          case ("gt") {
            var.update $condition_label {
              value = $metric_label ~ " rises above " ~ ($rule.threshold|to_text)
            }
          } break

          case ("lt") {
            var.update $condition_label {
              value = $metric_label ~ " falls below " ~ ($rule.threshold|to_text)
            }
          } break

          case ("outside_range") {
            var.update $condition_label {
              value = $metric_label ~ " leaves " ~ ($rule.threshold|to_text) ~ " to " ~ ($rule.threshold_high|to_text)
            }
          } break

          case ("rate_of_change") {
            var.update $condition_label {
              value = $metric_label ~ " jumps by more than " ~ ($rule.threshold|to_text) ~ " between readings"
            }
          } break

          case ("anomaly") {
            var.update $condition_label {
              value = $metric_label ~ " deviates more than " ~ ($rule.z_threshold|to_text) ~ " sigma from this device's own learned baseline"
            }
          } break

          case ("flatline") {
            var.update $condition_label {
              value = $metric_label ~ " stops changing"
            }
          } break

          case ("offline") {
            var.update $condition_label {
              value = "the device stops reporting"
            }
          } break

          default {
            var.update $condition_label {
              value = $rule.condition|to_text
            }
          }
        }

        conditional {
          if (($rule.fire_count|first_notnull:0) > 0) {
            math.add $rules_that_have_fired {
              value = 1
            }
          }
        }

        // set: rather than a hand-built object, so a column added to alert_rule later still reaches the client without editing this endpoint.
        array.push $enriched {
          value = $rule|set:"scope_label":$scope_label|set:"condition_label":$condition_label
        }
      }
    }
  }

  response = {
    items                : $enriched
    itemsTotal           : ($enriched|count)
    rules_that_have_fired: $rules_that_have_fired
  }
  tags = ["nerve"]
}
