// Manual device creation, for the devices that cannot announce themselves - a serial printed on a label, pre-staged before the hardware ships. Self-provisioning through /ingest/register is the normal path; this is the operator's escape hatch.
query "devices" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    // Unique across the fleet; the identity ingest matches on.
    text serial

    // Human label shown in the grid.
    text name

    // Supplies the metric_schema that makes this device chartable, so it is required rather than inferred.
    int device_type_id { table = "device_type" }

    int site_id { table = "site" }

    // Defaults to provisioning: a manually created device has demonstrably never reported, and claiming "online" would put a lie in the status tiles.
    enum status? { values = ["online", "degraded", "offline", "maintenance", "provisioning"] }

    text firmware_version?

    text location_label?

    text notes?

    // Free-form operator labels; the grid filters on them.
    json tags?

    date? install_date?

    // The gateway this device reports through. Drives cascade correlation, so it is worth setting even at creation time.
    int uplink_device_id?
  }

  stack {
    // Role and demo status are read from the row, not the token: a user demoted since their JWT was minted must lose write access immediately.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    // Creating fleet inventory is an operator action; viewers get the whole read surface and none of this.
    precondition ($user.role == "admin" || $user.role == "operator") {
      error_type = "accessdenied"
      error = "Operator or admin role required to create a device."
    }

    // The judges' one-click login must not be able to mutate the seeded demo fleet out from under the next judge.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Serials arrive from barcode scans and spreadsheets, both of which bring whitespace. Normalised before the uniqueness check so " NRV-1 " cannot slip past a row holding "NRV-1".
    var $serial {
      value = $input.serial|trim
    }

    precondition (($serial|strlen) > 0) {
      error_type = "inputerror"
      error = "serial is required and cannot be blank."
    }

    var $name {
      value = $input.name|trim
    }

    precondition (($name|strlen) > 0) {
      error_type = "inputerror"
      error = "name is required and cannot be blank."
    }

    // Checked explicitly rather than relying on a unique index, so the operator gets a sentence naming the conflict instead of a database error.
    db.has device {
      field_name = "serial"
      field_value = $serial
    } as $serial_taken

    precondition ($serial_taken == false) {
      error_type = "inputerror"
      error = "A device with serial '" ~ $serial ~ "' already exists."
    }

    // The FK columns would reject a bad id anyway; these reads exist to name which id was wrong.
    db.get device_type {
      field_name = "id"
      field_value = $input.device_type_id
      output = ["id", "code", "name", "category"]
    } as $device_type

    precondition ($device_type != null) {
      error_type = "inputerror"
      error = "Unknown device_type_id."
    }

    db.get site {
      field_name = "id"
      field_value = $input.site_id
      output = ["id", "code", "name"]
    } as $site

    precondition ($site != null) {
      error_type = "inputerror"
      error = "Unknown site_id."
    }

    // A dangling uplink would silently break cascade correlation, which reads uplink_device_id to collapse a gateway's downstream tree into one incident.
    conditional {
      if ($input.uplink_device_id != null) {
        db.get device {
          field_name = "id"
          field_value = $input.uplink_device_id
          output = ["id", "name"]
        } as $uplink

        precondition ($uplink != null) {
          error_type = "inputerror"
          error = "Unknown uplink_device_id."
        }
      }
    }

    // first_notempty rather than first_notnull so an empty-string status from a form also falls back.
    var $status {
      value = $input.status|first_notempty:"provisioning"
    }

    // auto_provisioned is hard-coded false: this row came from a human, and the distinction matters when auditing how a fleet grew. health_score and metrics_latest are left to their column defaults - nothing has been measured yet, and last_seen_at stays null so fn_compute_health treats it as never-seen.
    db.add device {
      data = {
        created_at      : "now"
        serial          : $serial
        name            : $name
        device_type_id  : $input.device_type_id
        site_id         : $input.site_id
        status          : $status
        firmware_version: $input.firmware_version
        location_label  : $input.location_label
        notes           : $input.notes
        tags            : $input.tags
        install_date    : $input.install_date
        uplink_device_id: $input.uplink_device_id
        auto_provisioned: false
      }
    } as $device

    // Inventory changes are exactly what someone asks about three weeks later.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "device.create"
        entity_type: "device"
        entity_id  : $device.id
        detail     : {
          serial        : $serial
          name          : $name
          device_type_id: $input.device_type_id
          site_id       : $input.site_id
          status        : $status
        }
        source     : "ui"
      }
    } as $audit
  }

  // Type and site are returned alongside the row so the client can render the new grid entry without a follow-up read.
  response = {
    device     : $device
    site       : $site
    device_type: $device_type
  }
  tags = ["nerve"]
}
