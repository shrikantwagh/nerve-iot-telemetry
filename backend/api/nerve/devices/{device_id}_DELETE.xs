// Admin-only decommission. Nine tables carry a device_id, so this endpoint is mostly about not leaving nine tables full of rows pointing at an id that no longer resolves - a dangling device_id turns the device detail screen and the incident view into null-pointer soup.
query "devices/{device_id}" verb=DELETE {
  api_group = "Nerve"
  auth = "user"

  input {
    int device_id { table = "device" }
  }

  stack {
    // Read from the row, not the token, so a demotion is effective immediately.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Stricter than the rest of this lane: deleting a device destroys its entire telemetry history, which no operator should be able to do by mistyping a URL.
    precondition ($user.role == "admin") {
      error_type = "accessdenied"
      error = "Admin role required to delete a device."
    }

    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Snapshotted before anything is destroyed, because the audit row is the only trace that will survive this request.
    db.get device {
      field_name = "id"
      field_value = $input.device_id
    } as $device

    precondition ($device != null) {
      error_type = "notfound"
      error = "Device not found."
    }

    // Downstream devices are NOT deleted - a gateway going away does not mean the freezers behind it did. Their uplink is detached instead, which costs them cascade correlation but keeps the devices and their history intact.
    db.query device {
      where = $db.device.uplink_device_id == $input.device_id
      output = ["id", "name"]
      return = {type: "list"}
    } as $dependents

    foreach ($dependents) {
      each as $dependent {
        db.edit device {
          field_name = "id"
          field_value = $dependent.id
          data = {uplink_device_id: null}
        } as $detached
      }
    }

    // The bulk of the rows. Deleted rather than orphaned: none of it is interpretable without the device, and metric_rollup plus telemetry are the two largest tables in the instance.
    db.bulk.delete telemetry {
      where = $db.telemetry.device_id == $input.device_id
    } as $telemetry_deleted

    db.bulk.delete metric_rollup {
      where = $db.metric_rollup.device_id == $input.device_id
    } as $rollups_deleted

    db.bulk.delete metric_baseline {
      where = $db.metric_baseline.device_id == $input.device_id
    } as $baselines_deleted

    // Alerts go with the device. Their incidents survive: an incident is a cross-device story and may well still be open, so alert_count on those rows is knowingly left high rather than recomputed here.
    db.bulk.delete alert {
      where = $db.alert.device_id == $input.device_id
    } as $alerts_deleted

    db.bulk.delete device_command {
      where = $db.device_command.device_id == $input.device_id
    } as $commands_deleted

    db.bulk.delete maintenance_prediction {
      where = $db.maintenance_prediction.device_id == $input.device_id
    } as $predictions_deleted

    // Device-scoped AI output only. Incident-scoped insights have a null device_id and are untouched.
    db.bulk.delete ai_insight {
      where = $db.ai_insight.device_id == $input.device_id
    } as $insights_deleted

    // A rule pinned to this one device has nothing left to evaluate. Rules scoped by type or site are left alone - they were never about this device specifically.
    db.bulk.delete alert_rule {
      where = $db.alert_rule.device_id == $input.device_id
    } as $rules_deleted

    // Last, so a failure above leaves the device present and the cleanup re-runnable rather than leaving orphans behind a missing parent.
    db.del device {
      field_name = "id"
      field_value = $input.device_id
    }

    // The snapshot plus the cascade counts, so the row explains not just that a device went away but how much history went with it.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "device.delete"
        entity_type: "device"
        entity_id  : $input.device_id
        detail     : {
          serial          : $device.serial
          name            : $device.name
          device_type_id  : $device.device_type_id
          site_id         : $device.site_id
          status          : $device.status
          health_score    : $device.health_score
          cascade_deleted : {
            telemetry             : $telemetry_deleted
            metric_rollup         : $rollups_deleted
            metric_baseline       : $baselines_deleted
            alert                 : $alerts_deleted
            device_command        : $commands_deleted
            maintenance_prediction: $predictions_deleted
            ai_insight            : $insights_deleted
            alert_rule            : $rules_deleted
          }
          uplink_detached : $dependents|count
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    deleted        : true
    device_id      : $input.device_id
    serial         : $device.serial
    uplink_detached: $dependents|count
    cascade_deleted: {
      telemetry             : $telemetry_deleted
      metric_rollup         : $rollups_deleted
      metric_baseline       : $baselines_deleted
      alert                 : $alerts_deleted
      device_command        : $commands_deleted
      maintenance_prediction: $predictions_deleted
      ai_insight            : $insights_deleted
      alert_rule            : $rules_deleted
    }
  }
  tags = ["nerve"]
}
