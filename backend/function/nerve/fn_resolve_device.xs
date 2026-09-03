// Device self-provisioning. This is the function that replaces AWS IoT's thing-types / thing-groups / policies / certs walk: a serial arrives and a charted device comes back.
function "Nerve/fn_resolve_device" {
  description = "Resolves a serial to a device row, refreshing reported firmware and location, and auto-provisioning the device from a device_type code plus a site code when it is unknown."

  input {
    // The device's identity. Everything else is decoration it can supply later.
    text serial filters=trim

    // device_type.code, not id - a device knows what it is, not what row it is.
    text device_type_code?

    // site.code, same reasoning.
    text site_code?

    // Friendly name; falls back to the serial so the fleet grid never shows a blank row.
    text name?

    // Reported on every register call, so a fleet-wide firmware view stays current.
    text firmware_version?

    // Physical placement, e.g. "Aisle 4 / Freezer 12".
    text location_label?

    // Caller-supplied labels, stored as-is on the device.
    json tags?

    // Set false to make this a pure lookup - used by paths that must not create rows as a side effect.
    bool create_if_missing?=true
  }

  stack {
    // Serial is the unique key, so a plain get is the whole lookup.
    db.get device {
      field_name = "serial"
      field_value = $input.serial
    } as $found

    // Working copy, because $found is replaced on both the update and the create path.
    var $device {
      value = $found
    }

    // Reported back to the caller so an ingest endpoint can tell "registered" from "already known".
    var $created {
      value = false
    }

    // Non-throwing failure channel: a dangling reference is a caller mistake, not a server fault.
    var $fail_reason {
      value = null
    }

    // Branch selectors computed once, so the conditionals below stay flat (else-if-nesting is unsupported).
    var $device_found {
      value = !($found|is_null)
    }

    // Provisioning is only allowed for a genuinely unknown serial.
    var $should_create {
      value = ($found|is_null) && ($input.create_if_missing == true)
    }

    // A returning device may have flashed new firmware or been physically moved; keep those two fields honest.
    conditional {
      if ($device_found) {
        var $updates {
          value = {}
        }

        // Only write on an actual change - a no-op patch per reading is pointless row churn.
        conditional {
          if ($input.firmware_version != null && $input.firmware_version != $found.firmware_version) {
            var.update $updates {
              value = $updates|set:"firmware_version":$input.firmware_version
            }
          }
        }

        // Same treatment for placement.
        conditional {
          if ($input.location_label != null && $input.location_label != $found.location_label) {
            var.update $updates {
              value = $updates|set:"location_label":$input.location_label
            }
          }
        }

        // db.patch takes a variable data object, which is exactly what an optional-field diff produces.
        conditional {
          if (($updates|count) > 0) {
            db.patch device {
              field_name = "id"
              field_value = $found.id
              data = $updates
            } as $patched

            var.update $device {
              value = $patched
            }
          }
        }
      }
    }

    // Unknown serial with provisioning allowed: resolve both references by code before writing anything.
    conditional {
      if ($should_create) {
        db.get device_type {
          field_name = "code"
          field_value = $input.device_type_code
        } as $device_type

        // Site is the tenancy anchor for alerts and incidents, so it is equally mandatory.
        db.get site {
          field_name = "code"
          field_value = $input.site_code
        } as $site

        // Refuse to write a device pointing at a type or site that does not exist - a half-provisioned row is worse than none, and both columns are non-null.
        conditional {
          if (($device_type|is_null) || ($site|is_null)) {
            var.update $fail_reason {
              value = "Unknown device_type_code or site_code for serial " ~ $input.serial ~ "; device not created."
            }
          }
          else {
            db.add device {
              data = {
                created_at      : "now"
                serial          : $input.serial
                name            : $input.name|first_notempty:$input.serial
                device_type_id  : $device_type.id
                site_id         : $site.id
                status          : "provisioning"
                firmware_version: $input.firmware_version
                location_label  : $input.location_label
                tags            : $input.tags
                health_score    : 100
                auto_provisioned: true
                last_seen_at    : "now"
              }
            } as $new_device

            var.update $device {
              value = $new_device
            }

            var.update $created {
              value = true
            }
          }
        }
      }
    }

    // Lookup-only mode found nothing: say so rather than returning a bare null the caller has to interpret.
    conditional {
      if (($device_found == false) && ($input.create_if_missing == false)) {
        var.update $fail_reason {
          value = "No device registered with serial " ~ $input.serial ~ "."
        }
      }
    }
  }

  response = {device: $device, created: $created, error: $fail_reason}
  tags = ["nerve"]
  guid = "Czb_K0eUYMuHz98FimS0CgNnqTQ"
}
