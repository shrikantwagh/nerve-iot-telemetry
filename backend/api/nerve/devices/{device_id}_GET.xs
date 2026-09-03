// Everything the Device Detail screen needs, in one request. The device_type is returned whole rather than projected because its metric_schema is what tells the frontend which charts exist, what units to label them with, and where to draw the nominal band.
query "devices/{device_id}" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    int device_id { table = "device" }
  }

  stack {
    // Full row: metrics_latest, tags and notes are all rendered on this screen, so a projection would just mean a second read.
    db.get device {
      field_name = "id"
      field_value = $input.device_id
    } as $device

    precondition ($device != null) {
      error_type = "notfound"
      error = "Device not found."
    }

    db.get site {
      field_name = "id"
      field_value = $device.site_id
    } as $site

    // Unprojected on purpose - metric_schema is the payload the charts are built from.
    db.get device_type {
      field_name = "id"
      field_value = $device.device_type_id
    } as $device_type

    // Null for anything that talks to the network directly. When set, this is the device whose failure would explain this one's, so it is worth a click.
    var $uplink {
      value = null
    }

    conditional {
      if ($device.uplink_device_id != null) {
        db.get device {
          field_name = "id"
          field_value = $device.uplink_device_id
          output = ["id", "name", "serial", "status", "health_score"]
        } as $uplink_device

        var.update $uplink {
          value = $uplink_device
        }
      }
    }

    // Only firing: acknowledged means a human owns it and resolved means it is history. Both live in the timeline endpoint instead of cluttering the header.
    db.query alert {
      where = $db.alert.device_id == $input.device_id && $db.alert.state == "firing"
      sort = {alert.fired_at: "desc"}
      return = {type: "list"}
    } as $firing_alerts

    // Ascending by predicted date: the soonest predicted failure is the one worth scheduling, and a null prediction date sorts to the front where it is visible rather than buried.
    db.query maintenance_prediction {
      where = $db.maintenance_prediction.device_id == $input.device_id && $db.maintenance_prediction.state == "open"
      sort = {maintenance_prediction.predicted_failure_at: "asc"}
      return = {type: "list"}
    } as $open_predictions

    // Capped at ten with metadata off, because the command console shows a short recent history and the full log belongs to the timeline endpoint.
    db.query device_command {
      where = $db.device_command.device_id == $input.device_id
      sort = {device_command.created_at: "desc"}
      return = {type: "list", paging: {page: 1, per_page: 10, metadata: false}}
    } as $recent_commands
  }

  // metrics_latest is lifted to the top level even though it is also inside `device`: it is the single most-read value on this screen and the chart code should not have to know it lives denormalized on the device row.
  response = {
    device          : $device
    site            : $site
    device_type     : $device_type
    metrics_latest  : $device.metrics_latest
    uplink          : $uplink
    firing_alerts   : $firing_alerts
    open_predictions: $open_predictions
    recent_commands : $recent_commands
  }
  tags = ["nerve"]
}
