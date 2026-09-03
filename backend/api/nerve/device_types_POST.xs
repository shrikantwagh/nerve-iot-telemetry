// Creates a device type. This is the endpoint that replaces AWS IoT's six console screens: one call declares a class of hardware, its offline threshold, and every metric it reports - and from that moment a device of this type is chartable and rule-able with no further configuration.
query "device-types" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    // Short stable identifier. The ingest register path resolves a type by code, so this is the string device firmware ships with.
    text code

    text name

    // Drives cascade correlation: fn_correlate treats a "gateway" as the root of everything reporting through it.
    enum category { values = ["robot", "refrigeration", "hvac", "machine_tool", "power", "gateway", "other"] }

    text manufacturer?

    text model?

    text icon?

    // How long silence is tolerated before this class of device is called offline. Per type because a mains-powered gateway missing five minutes is dead and a battery sensor is not.
    int offline_after_seconds?=300

    // The declarative contract this whole product is built on: [{key, label, unit, kind, nominal_min, nominal_max, hard_min, hard_max, precision}]. Required, and validated below, because a type with a malformed schema produces charts with no units and rules with no metrics - failures that surface far from their cause.
    json metric_schema
  }

  stack {
    // Read from the row rather than the token so a demotion takes effect immediately.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    precondition ($user.role == "admin" || $user.role == "operator") {
      error_type = "accessdenied"
      error = "Operator or admin role required to create a device type."
    }

    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Trimmed, not case-folded: ingest matches this exactly and rewriting it here would break already-flashed firmware.
    var $code {
      value = $input.code|trim
    }

    precondition (($code|strlen) > 0) {
      error_type = "inputerror"
      error = "code is required and cannot be blank."
    }

    var $name {
      value = $input.name|trim
    }

    precondition (($name|strlen) > 0) {
      error_type = "inputerror"
      error = "name is required and cannot be blank."
    }

    db.has device_type {
      field_name = "code"
      field_value = $code
    } as $code_taken

    precondition ($code_taken == false) {
      error_type = "inputerror"
      error = "A device type with code '" ~ $code ~ "' already exists."
    }

    // A silence window of zero or less would flip every device of this type offline on arrival.
    precondition ($input.offline_after_seconds > 0) {
      error_type = "inputerror"
      error = "offline_after_seconds must be greater than 0."
    }

    // Shape first: everything below indexes into the array, and a scalar or object here would fail in a much less legible way.
    precondition ($input.metric_schema|is_array) {
      error_type = "inputerror"
      error = "metric_schema must be an array of metric definition objects."
    }

    precondition (($input.metric_schema|count) > 0) {
      error_type = "inputerror"
      error = "metric_schema must declare at least one metric; a type with no metrics cannot be charted or alerted on."
    }

    // Collected rather than thrown one at a time, so an operator pasting a schema gets every problem in one response instead of fixing them one round trip apiece.
    var $schema_errors {
      value = []
    }

    // Duplicates are checked after the loop; a repeated key would make the schema lookup in the telemetry endpoint ambiguous.
    var $seen_keys {
      value = []
    }

    // Position in the array, so an error names which entry is wrong.
    var $index {
      value = 0
    }

    foreach ($input.metric_schema) {
      each as $metric {
        var $position {
          value = $index|to_text
        }

        var $is_obj {
          value = $metric|is_object
        }

        conditional {
          if ($is_obj == false) {
            array.push $schema_errors {
              value = "entry " ~ $position ~ " is not an object"
            }
          }
          else {
            var $key {
              value = $metric|get:"key"
            }

            // key is the join between a reading's json, a baseline row, a rollup row and a rule. Blank is as bad as missing.
            conditional {
              if (($key == null) || (($key|to_text|trim|strlen) == 0)) {
                array.push $schema_errors {
                  value = "entry " ~ $position ~ " is missing 'key'"
                }
              }
              else {
                array.push $seen_keys {
                  value = $key
                }
              }
            }

            var $label {
              value = $metric|get:"label"
            }

            // label is what the chart axis and the alert message say. A missing one makes both unreadable.
            conditional {
              if (($label == null) || (($label|to_text|trim|strlen) == 0)) {
                array.push $schema_errors {
                  value = "entry " ~ $position ~ " is missing 'label'"
                }
              }
            }

            // Presence only, deliberately: a state metric such as door_open has no unit, and "" is a legitimate answer. What is not legitimate is omitting the property, because then the chart cannot tell "unitless" from "nobody said".
            var $has_unit {
              value = $metric|has:"unit"
            }

            conditional {
              if ($has_unit == false) {
                array.push $schema_errors {
                  value = "entry " ~ $position ~ " is missing 'unit' (use \"\" for a unitless metric)"
                }
              }
            }

            var $kind {
              value = $metric|get:"kind"
            }

            // Constrained to the three the frontend can render: gauge draws a line with a band, counter draws a rate, state draws a step chart. Anything else would silently fall through to no chart at all.
            var $kind_ok {
              value = ($kind == "gauge") || ($kind == "counter") || ($kind == "state")
            }

            conditional {
              if ($kind_ok == false) {
                array.push $schema_errors {
                  value = "entry " ~ $position ~ " has an invalid 'kind' (expected gauge, counter or state)"
                }
              }
            }
          }
        }

        math.add $index {
          value = 1
        }
      }
    }

    var $unique_keys {
      value = $seen_keys|unique
    }

    // A duplicate key makes every downstream lookup ambiguous - index_by would return two entries and the first one silently wins.
    conditional {
      if (($seen_keys|count) != ($unique_keys|count)) {
        array.push $schema_errors {
          value = "metric keys must be unique within a schema"
        }
      }
    }

    // One precondition carrying every problem found.
    precondition (($schema_errors|count) == 0) {
      error_type = "inputerror"
      error = "metric_schema is invalid: " ~ ($schema_errors|join:"; ")
    }

    db.add device_type {
      data = {
        created_at           : "now"
        code                 : $code
        name                 : $name
        category             : $input.category
        manufacturer         : $input.manufacturer
        model                : $input.model
        icon                 : $input.icon
        offline_after_seconds: $input.offline_after_seconds
        metric_schema        : $input.metric_schema
      }
    } as $device_type

    // A new type changes what the fleet can measure, so the schema itself goes into the audit detail - "when did we start recording vibration_mm_s" is answerable from this row.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "device_type.create"
        entity_type: "device_type"
        entity_id  : $device_type.id
        detail     : {
          code                 : $code
          name                 : $name
          category             : $input.category
          offline_after_seconds: $input.offline_after_seconds
          metric_keys          : $unique_keys
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    device_type : $device_type
    metric_count: $unique_keys|count
    metric_keys : $unique_keys
  }
  tags = ["nerve"]
  guid = "LDmkPFSbVU0OIFZuJMYPeEf-Ccg"
}
