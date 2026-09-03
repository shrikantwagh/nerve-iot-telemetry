// One call replaces AWS IoT's thing-type / thing-group / policy / certificate walk: a device announces a serial and the type and site it belongs to, and comes back provisioned and chartable.
query "register" verb=POST {
  api_group = "NerveIngest"

  input {
    // The device's identity and the unique key on the device table.
    text serial filters=trim

    // Friendly label; fn_resolve_device falls back to the serial so the fleet grid never shows a blank row.
    text name?

    // device_type.code, not id - a device knows what kind of thing it is, not which row describes it.
    text device_type_code filters=trim

    // site.code, same reasoning. Site is the tenancy anchor every alert and incident hangs off.
    text site_code filters=trim

    // Reported on every register call so a fleet-wide firmware view stays current without a separate inventory sweep.
    text firmware_version?

    // Physical placement, e.g. "Aisle 4 / Freezer 12".
    text location_label?

    // Caller-supplied labels. Only written on create; see the note in fn_resolve_device about not clobbering an operator's curated tags.
    json tags?

    // Declared so a device that cannot set headers can still authenticate, and so the key shows up in the generated OpenAPI. Nerve/fn_api_key_auth reads it as the last of three transports.
    text api_key?
  }

  stack {
    // AUTHENTICATE FIRST. Deliberately ahead of the input preconditions below: an
    // unauthenticated caller must not be able to probe input validation, and a
    // 401 must not be distinguishable by which field it complained about.
    // (This was a pre-middleware until Xano refused it on the Free plan - see
    // function/nerve/fn_api_key_auth.xs for why enforcement lives here now.)
    function.run "Nerve/fn_api_key_auth" {
      input = {api_key: $input.api_key}
    } as $device_auth

    // An empty serial would provision an unaddressable device, so refuse before touching the database.
    precondition (($input.serial|strlen) > 0) {
      error_type = "inputerror"
      error = "serial is required."
    }

    // All the provisioning logic lives in the shared function so /register and the telemetry paths cannot drift on what "resolve a serial" means.
    function.run "Nerve/fn_resolve_device" {
      input = {
        serial           : $input.serial
        device_type_code : $input.device_type_code
        site_code        : $input.site_code
        name             : $input.name
        firmware_version : $input.firmware_version
        location_label   : $input.location_label
        tags             : $input.tags
        create_if_missing: true
      }
    } as $resolved

    // fn_resolve_device never throws; a dangling device_type_code or site_code comes back as an error string. Surfacing it as inputerror is the difference between "your codes are wrong" and a silent 500.
    precondition ($resolved.error == null) {
      error_type = "inputerror"
      error = $resolved.error
    }

    // Belt and braces: a null device with no error string would mean the function changed shape under us.
    precondition ($resolved.device != null) {
      error_type = "inputerror"
      error = "Device could not be resolved or created for serial " ~ $input.serial ~ "."
    }

    // Registration is rare and consequential, so unlike the telemetry paths it is always audited. source is "device" because no user is behind this call - $auth is unpopulated under API-key auth.
    function.run "Nerve/fn_audit" {
      input = {
        action     : "device.register"
        entity_type: "device"
        entity_id  : $resolved.device.id
        detail     : {
          serial          : $input.serial
          created         : $resolved.created
          device_type_code: $input.device_type_code
          site_code       : $input.site_code
          firmware_version: $input.firmware_version
        }
        source     : "device"
      }
    } as $audit
  }

  response = {device_id: $resolved.device.id, created: $resolved.created, serial: $resolved.device.serial}
  tags = ["nerve"]
  guid = "ApP3bet8CSuTra8qto1DUxDyt6k"
}
