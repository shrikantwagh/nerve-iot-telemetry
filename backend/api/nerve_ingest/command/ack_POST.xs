// Closes the loop that read-only dashboards leave open: a command issued from the incident view is only real once the device says what happened to it.
query "command/ack" verb=POST {
  api_group = "NerveIngest"

  input {
    // The queued command the device is reporting on.
    int command_id { table = "device_command" }

    // Only the two outcomes a device can report. queued/sent are set by the issuer and expired by the sweep, so they are not offered here.
    enum state { values = ["acked", "failed"] }

    // Free-form device response - exit codes, firmware version reached, failure text. Stored as-is for the incident timeline.
    json result?

    // Optional device-supplied note, kept separate from result so a human-readable reason survives even when result is machine junk.
    text note?

    // Declared so a device that cannot set headers can still authenticate; mw_api_key_auth reads it as the last of three transports.
    text api_key?
  }

  stack {
    // Fetched rather than blind-patched, because the response has to tell the device which device the command belonged to and the guards below need the current state.
    db.get device_command {
      field_name = "id"
      field_value = $input.command_id
    } as $command

    // A device acking a command that does not exist usually means it is replaying a stale queue after a restart.
    precondition ($command != null) {
      error_type = "notfound"
      error = "Unknown command_id."
    }

    // An expired command has already been written off; letting a late ack resurrect it would make the incident timeline lie about when the device actually responded.
    precondition ($command.state != "expired") {
      error_type = "inputerror"
      error = "Command has expired and can no longer be acknowledged."
    }

    // Built as a variable object so an omitted note does not overwrite the note the issuer left on the row.
    var $command_data {
      value = {}
    }

    var.update $command_data {
      value = $command_data|set:"state":$input.state
    }

    // Stamped for both outcomes: "when did the device answer" is the useful question, and it is equally useful when the answer was "it failed".
    var.update $command_data {
      value = $command_data|set:"acked_at":"now"
    }

    // Written even when null, so a re-ack that carries no result correctly clears a stale one.
    var.update $command_data {
      value = $command_data|set:"result":$input.result
    }

    conditional {
      if ($input.note != null) {
        var.update $command_data {
          value = $command_data|set:"note":$input.note
        }
      }
    }

    db.patch device_command {
      field_name = "id"
      field_value = $command.id
      data = $command_data
    } as $updated

    // Low volume and consequential - a command that ran on real hardware - so unlike the telemetry paths this is always audited. source is "device" because no user is behind the call; $auth is unpopulated under API-key auth.
    function.run "Nerve/fn_audit" {
      input = {
        action     : "command.ack"
        entity_type: "device_command"
        entity_id  : $updated.id
        detail     : {
          device_id: $command.device_id
          command  : $command.command
          state    : $input.state
          result   : $input.result
        }
        source     : "device"
      }
    } as $audit

    // The command console is watching this channel; without the event an operator sits on a spinner until they reload.
    api.realtime_event {
      channel = "device:" ~ ($command.device_id|to_text)
      data = {
        type      : "command_ack"
        command_id: $updated.id
        device_id : $command.device_id
        command   : $command.command
        state     : $input.state
        result    : $input.result
      }
      auth_table = "user"
      auth_id = null
    }
  }

  response = {ok: true, command_id: $updated.id, device_id: $command.device_id, state: $updated.state}
  tags = ["nerve"]
}
