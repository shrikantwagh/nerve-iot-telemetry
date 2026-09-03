// Commands are first-class in Nerve because the tool you diagnose in should be the tool you fix in. This is the write half: a queued row the device collects and acks, never a direct call to hardware.
query "devices/{device_id}/commands" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    int device_id { table = "device" }

    // Exactly the device_command.command enum. Declared as an enum rather than text so an unsupported verb is a 400 from the input layer, not a row the device will never understand.
    enum command { values = ["restart", "firmware_update", "calibrate", "set_config", "return_to_dock", "enter_maintenance", "clear_fault"] }

    // Command arguments: the firmware version, the config keys, the dock id. Shape is per-command by design, which is why the column is json.
    json payload?

    // Why the operator issued it. Shown in the device timeline next to the command.
    text note?
  }

  stack {
    // Role and demo flag are on the user row, not the token.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Viewers can watch the fleet; only operators and admins can touch it. This is the endpoint where that distinction actually matters - restart and firmware_update are physical actions.
    precondition (($user.role == "admin") || ($user.role == "operator")) {
      error_type = "accessdenied"
      error = "Issuing device commands requires the operator or admin role."
    }

    // The demo login is what judges use. It must be able to show the command console without being able to reboot the demo fleet mid-presentation.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Read rather than db.has: the name and status go into the audit detail and the note default, and a command for a deleted device must not be queued for a collector that will never come.
    db.get device {
      field_name = "id"
      field_value = $input.device_id
      output = ["id", "name", "serial", "status", "site_id", "device_type_id"]
    } as $device

    precondition ($device != null) {
      error_type = "notfound"
      error = "Device not found."
    }

    // queued is the only state this endpoint may write. sent, acked and failed are the device's and the ack endpoint's to set, so the row's state is always a claim someone can substantiate.
    // No device.status write either: `enter_maintenance` becomes real when the machine confirms it, not when a human asks.
    db.add device_command {
      data = {
        created_at: "now"
        device_id : $input.device_id
        command   : $input.command
        payload   : $input.payload
        state     : "queued"
        issued_by : $auth.id
        note      : $input.note|first_notempty:($input.command ~ " issued by " ~ $user.name)
      }
    } as $command

    // Commands are the most consequential thing a user can do through this API, so the audit detail carries the full payload rather than a summary of it.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "device.command.issue"
        entity_type: "device_command"
        entity_id  : $command.id
        detail     : {
          device_id     : $input.device_id
          device_name   : $device.name
          device_serial : $device.serial
          device_status : $device.status
          command       : $input.command
          payload       : $input.payload
          note          : $input.note
        }
        source     : "ui"
      }
    } as $audit
  }

  response = $command
  tags = ["nerve"]
  guid = "y1hUJZanTdXlBlWXyWqYP9J6VNQ"
}
