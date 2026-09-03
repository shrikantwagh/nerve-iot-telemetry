// The predictive-maintenance queue. Ordered the way a planner actually works it: what is still undecided, soonest first.
query "predictions" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    // Omit to get the whole queue with open predictions first; supply one to look at a single lane.
    enum state? { values = ["open", "scheduled", "dismissed", "completed"] }

    // Narrow to one machine, for the device-detail page's maintenance panel.
    int device_id?

    // Narrow to one plant. maintenance_prediction has no site column, so this filters through the joined device.
    int site_id?

    // Cap per lane rather than true paging: the queue is a decision list, not an archive, and a planner who needs page 9 needs a different filter.
    int limit?=100
  }

  stack {
    // Two queries rather than one, because the required order - open first, then everything else - is not expressible as a column sort: state's alphabetical order (completed, dismissed, open, scheduled) is meaningless, and there is no rank column to sort on.
    var $open {
      value = []
    }

    // The already-decided lanes, appended after.
    var $others {
      value = []
    }

    // Lane one: still undecided. Skipped entirely when the caller asked for a specific non-open state.
    conditional {
      if ($input.state == null || $input.state == "open") {
        // The inner join is deliberate: a prediction whose device was deleted is unreadable and should not appear in a work queue. The site join is left, because a device can outlive a site row.
        db.query maintenance_prediction {
          join = {
            device: {table: "device", type: "inner", where: $db.maintenance_prediction.device_id == $db.device.id},
            site  : {table: "site", type: "left", where: $db.device.site_id == $db.site.id}
          }
          eval = {
            device_name  : $db.device.name
            device_serial: $db.device.serial
            device_status: $db.device.status
            health_score : $db.device.health_score
            site_id      : $db.device.site_id
            site_name    : $db.site.name
            site_code    : $db.site.code
          }
          where = $db.maintenance_prediction.state == "open" && ($db.maintenance_prediction.device_id ==? $input.device_id) && ($db.device.site_id ==? $input.site_id)
          sort = {maintenance_prediction.predicted_failure_at: "asc"}
          return = {type: "list", paging: {page: 1, per_page: $input.limit}}
        } as $open_rows

        var.update $open {
          value = $open_rows.items|safe_array
        }
      }
    }

    // Lane two: everything already acted on. `==?` is null-safe, so an absent state filter here means "any state that is not open" and a supplied one narrows to exactly it.
    conditional {
      if ($input.state != "open") {
        // Sorted by creation rather than by forecast date: once a prediction is scheduled or dismissed, what matters is when the decision was taken, not when the part was going to fail.
        db.query maintenance_prediction {
          join = {
            device: {table: "device", type: "inner", where: $db.maintenance_prediction.device_id == $db.device.id},
            site  : {table: "site", type: "left", where: $db.device.site_id == $db.site.id}
          }
          eval = {
            device_name  : $db.device.name
            device_serial: $db.device.serial
            device_status: $db.device.status
            health_score : $db.device.health_score
            site_id      : $db.device.site_id
            site_name    : $db.site.name
            site_code    : $db.site.code
          }
          where = $db.maintenance_prediction.state != "open" && ($db.maintenance_prediction.state ==? $input.state) && ($db.maintenance_prediction.device_id ==? $input.device_id) && ($db.device.site_id ==? $input.site_id)
          sort = {maintenance_prediction.created_at: "desc"}
          return = {type: "list", paging: {page: 1, per_page: $input.limit}}
        } as $other_rows

        var.update $others {
          value = $other_rows.items|safe_array
        }
      }
    }

    // Concatenation preserves each lane's own sort, which is the whole point of splitting the query.
    var $items {
      value = $open|merge:$others
    }

    // Surfaced separately so the UI can badge the queue count without filtering the list client-side.
    var $open_count {
      value = $open|count
    }
  }

  // No `output` restriction anywhere above, so every prediction column comes back - including `evidence`, which is what makes a forecast checkable rather than something the operator has to take on faith.
  response = {
    items      : $items
    count      : $items|count
    open_count : $open_count
    filters    : {
      state    : $input.state
      device_id: $input.device_id
      site_id  : $input.site_id
      limit    : $input.limit
    }
  }
  tags = ["nerve"]
  guid = "6CoXL2T0fIH78Bcc3G41LqRQCek"
}
