// Close the loop. The AI says what is wrong; this is the one click that acts on it across every affected device at once, without leaving the incident view and without the operator hand-copying eight serials into another tool.
query "incidents/{incident_id}/commands" verb=POST {
  api_group = "Nerve"
  auth = "user"
  description = "Operator+ fan-out of one remediation command to every device affected by an incident, optionally narrowed to a subset. Creates device_command rows linked back to the incident so the detail view shows what was tried."

  input {
    // Path parameter.
    int incident_id {
      table = "incident"
    }

    // Values mirror device_command.command exactly; anything else is a 400 before it reaches the fan-out.
    enum command {
      values = ["restart", "firmware_update", "calibrate", "set_config", "return_to_dock", "enter_maintenance", "clear_fault"]
    }

    // Command arguments - a firmware version, a config key, a calibration offset. Opaque here and interpreted by the device agent.
    json payload?

    // Narrows the fan-out. Omit to hit every device the incident touches; ids outside the incident are reported back rather than silently obeyed.
    int[] device_ids?

    // Why the command was issued. Stored on each row so the incident timeline reads as a decision log, not a click log.
    text note? filters=trim
  }

  stack {
    // Role from the database rather than from the token, so a demotion takes effect on the next request.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Issuing a command physically moves hardware. Viewers do not get to do that.
    precondition (($user.role == "operator") || ($user.role == "admin")) {
      error_type = "accessdenied"
      error = "Operator role required to issue a command."
    }

    // The judges' shared login must not be able to restart the demo fleet mid-presentation.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    db.get incident {
      field_name = "id"
      field_value = $input.incident_id
    } as $incident

    precondition ($incident != null) {
      error_type = "notfound"
      error = "Incident not found."
    }

    // The affected set is derived from the incident's member alerts, not supplied by the client: the incident defines the blast radius.
    db.query alert {
      where = $db.alert.incident_id == $input.incident_id
      return = {type: "list"}
    } as $alerts

    // Distinct device ids from the members.
    var $affected_ids {
      value = []
    }

    foreach ($alerts) {
      each as $alert {
        array.push $affected_ids {
          value = $alert.device_id
        }
      }
    }

    // Deduped, because one device commonly contributes several alerts and it must not be commanded several times.
    var $unique_affected {
      value = $affected_ids|unique
    }

    // Devices that will actually receive the command.
    var $targets {
      value = []
    }

    // Requested ids that are not part of this incident. Reported rather than obeyed - a stale UI selection must not become an unrelated restart.
    var $ignored_device_ids {
      value = []
    }

    // safe_array turns an omitted list into [null], so filter_empty is what actually distinguishes "no narrowing" from "narrow to nothing".
    var $narrow_list {
      value = ($input.device_ids|safe_array)|filter_empty
    }

    // A narrowing list is only a narrowing list when it has entries; an empty array means the same as omitting it.
    var $is_narrowed {
      value = ($narrow_list|count) > 0
    }

    conditional {
      if ($is_narrowed) {
        foreach ($narrow_list) {
          each as $requested_id {
            conditional {
              if (($unique_affected|in:$requested_id) == true) {
                array.push $targets {
                  value = $requested_id
                }
              }
              else {
                array.push $ignored_device_ids {
                  value = $requested_id
                }
              }
            }
          }
        }
      }
      else {
        var.update $targets {
          value = $unique_affected
        }
      }
    }

    // Deduped again: a client can repeat an id in the narrowing list, and each device should get one row.
    var $final_targets {
      value = $targets|unique
    }

    // A fan-out that would hit nothing is a client error worth surfacing, not a successful no-op.
    precondition (($final_targets|count) > 0) {
      error_type = "inputerror"
      error = "No target devices. This incident has no affected devices, or none of the supplied device_ids belong to it."
    }

    // Rows created, returned so the UI can render them straight into the command list without a re-read.
    var $created {
      value = []
    }

    foreach ($final_targets) {
      each as $device_id {
        // Name is fetched only so the response and the audit detail are readable; the write itself needs the id alone.
        db.get device {
          field_name = "id"
          field_value = $device_id
          output = ["id", "name", "serial"]
        } as $device

        // state stays "queued": this endpoint records intent, and the device agent moves it to sent/acked via the ingest group.
        db.add device_command {
          data = {
            created_at : "now"
            device_id  : $device_id
            command    : $input.command
            payload    : $input.payload
            state      : "queued"
            issued_by  : $auth.id
            incident_id: $input.incident_id
            note       : $input.note
          }
        } as $command_row

        array.push $created {
          value = {
            id         : $command_row.id
            device_id  : $device_id
            device_name: $device|get:"name":null
            serial     : $device|get:"serial":null
            command    : $input.command
            state      : "queued"
            created_at : $command_row.created_at
          }
        }
      }
    }

    // One audit row for the whole fan-out rather than one per device: the operator made one decision, and that is the thing worth reviewing.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "incident.command.issue"
        entity_type: "incident"
        entity_id  : $input.incident_id
        detail     : {
          command           : $input.command
          payload           : $input.payload
          note              : $input.note
          narrowed          : $is_narrowed
          device_ids        : $final_targets
          ignored_device_ids: $ignored_device_ids
          commands_created  : ($created|count)
          incident_state    : $incident.state
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    incident_id       : $input.incident_id
    command           : $input.command
    commands_created  : ($created|count)
    devices_targeted  : ($final_targets|count)
    devices_affected  : ($unique_affected|count)
    narrowed          : $is_narrowed
    ignored_device_ids: $ignored_device_ids
    commands          : $created
  }
  tags = ["nerve"]
  guid = "efAalg9RoTAmcn3S7F5XmANUvS4"
}
