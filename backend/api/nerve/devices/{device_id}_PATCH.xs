// Operator edits to a device. Deliberately narrow: serial, device_type_id and health_score are not editable here, because serial is the identity ingest matches on, the type determines which charts exist, and health_score is derived - letting a human type one in would make the number meaningless.
query "devices/{device_id}" verb=PATCH {
  api_group = "Nerve"
  auth = "user"

  input {
    int device_id { table = "device" }

    text name?

    text location_label?

    // Replaces the whole array; there is no per-tag add/remove, so the client sends the full set.
    json tags?

    text notes?

    // Only a maintenance hold or its release. Every other status is measured, not declared - see the transition gate below.
    enum status? { values = ["online", "degraded", "offline", "maintenance", "provisioning"] }

    // Physical relocation.
    int site_id?
  }

  stack {
    // Read from the row rather than the token so a demotion takes effect on the next request, not on the next login.
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
      error = "Operator or admin role required to edit a device."
    }

    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Needed both for the transition gate and for the audit row's before-image.
    db.get device {
      field_name = "id"
      field_value = $input.device_id
    } as $device

    precondition ($device != null) {
      error_type = "notfound"
      error = "Device not found."
    }

    // status is owned by fn_compute_health and the offline sweep. The one thing a human legitimately knows that the telemetry does not is "this box is on a bench and its silence is expected", so the only permitted moves are into maintenance and back out of it. Anything else would be overwritten by the next reading anyway, which is worse than refusing it.
    var $status_transition_ok {
      value = true
    }

    conditional {
      if ($input.status != null) {
        var.update $status_transition_ok {
          value = ($input.status == "maintenance") || ($device.status == "maintenance")
        }
      }
    }

    precondition ($status_transition_ok) {
      error_type = "inputerror"
      error = "status may only be set to 'maintenance', or changed away from 'maintenance'. Every other status is derived from telemetry."
    }

    // Relocation must land on a real site, or the fleet rollup gains a phantom bucket.
    conditional {
      if ($input.site_id != null) {
        db.get site {
          field_name = "id"
          field_value = $input.site_id
          output = ["id", "code", "name"]
        } as $new_site

        precondition ($new_site != null) {
          error_type = "inputerror"
          error = "Unknown site_id."
        }
      }
    }

    // Built incrementally so an omitted field is left alone rather than being overwritten with null - the difference between PATCH and PUT, and the reason db.patch exists.
    var $updates {
      value = {}
    }

    // Hoisted out of the conditional because a filter chain used as a filter argument binds greedily; when the input is absent this is simply null and never read.
    var $new_name {
      value = $input.name|trim
    }

    conditional {
      if ($input.name != null) {
        precondition (($new_name|strlen) > 0) {
          error_type = "inputerror"
          error = "name cannot be set to blank."
        }

        var.update $updates {
          value = $updates|set:"name":$new_name
        }
      }
    }

    conditional {
      if ($input.location_label != null) {
        var.update $updates {
          value = $updates|set:"location_label":$input.location_label
        }
      }
    }

    // Note that fn_resolve_device deliberately never touches tags on the ingest path, so an operator's curated set here is authoritative and will not be overwritten by whatever a device reports.
    conditional {
      if ($input.tags != null) {
        var.update $updates {
          value = $updates|set:"tags":$input.tags
        }
      }
    }

    conditional {
      if ($input.notes != null) {
        var.update $updates {
          value = $updates|set:"notes":$input.notes
        }
      }
    }

    conditional {
      if ($input.status != null) {
        var.update $updates {
          value = $updates|set:"status":$input.status
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

    // An empty PATCH is a client bug worth surfacing, not a silent 200 that looks like it worked.
    precondition (($updates|count) > 0) {
      error_type = "inputerror"
      error = "No editable fields supplied. Editable: name, location_label, tags, notes, status, site_id."
    }

    db.patch device {
      field_name = "id"
      field_value = $input.device_id
      data = $updates
    } as $patched

    // Whether the status actually moved, not merely whether it was sent - re-sending the current status should not trigger a rescore.
    var $status_changed {
      value = ($input.status != null) && ($input.status != $device.status)
    }

    // Releasing a maintenance hold must not leave the device claiming "online" while it has been silent for an hour, so the score and status are immediately re-derived from what is actually observable. fn_compute_health preserves a maintenance hold, so entering maintenance is safe to rescore too.
    conditional {
      if ($status_changed) {
        function.run "Nerve/fn_compute_health" {
          input = {device_id: $input.device_id}
        } as $rescored
      }
    }

    // fn_compute_health writes status and health_score directly to the row, so $patched is stale whenever it ran. One extra read on a rare mutation buys a response that is actually true.
    db.get device {
      field_name = "id"
      field_value = $input.device_id
    } as $device_after

    // Before-image kept alongside the diff: "who changed this and what was it before" is the only question an audit log gets asked.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "device.update"
        entity_type: "device"
        entity_id  : $input.device_id
        detail     : {
          changes: $updates
          before : {
            name          : $device.name
            location_label: $device.location_label
            tags          : $device.tags
            notes         : $device.notes
            status        : $device.status
            site_id       : $device.site_id
          }
          rescored: $status_changed
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    device        : $device_after
    changed       : $updates
    status_changed: $status_changed
  }
  tags = ["nerve"]
  guid = "Zs3LYkzSIFhx0G5mhX_xZc9-oiE"
}
