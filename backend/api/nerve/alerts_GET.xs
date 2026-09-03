// The triage queue. Defaults to state=firing because "what needs me right now" is the only question this screen exists to answer - an unfiltered alert list is the stale dashboard Nerve is replacing.
query "alerts" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    // "all" is an explicit escape hatch rather than the default; omitting state means firing.
    enum state? { values = ["firing", "acknowledged", "resolved", "all"] }

    // Severity mirrors alert.severity exactly, so the UI can hand its own value straight through.
    enum severity? { values = ["critical", "warning", "info"] }

    int device_id? { table = "device" }

    // Filtered through the joined device, because alert carries no site of its own.
    int site_id? { table = "site" }

    // Lets the incident view reuse this endpoint instead of a second alert reader.
    int incident_id? { table = "incident" }

    // Lower bound on fired_at, so the UI can poll a live window rather than re-reading the whole table.
    timestamp? since?

    int page?=1

    int per_page?=50
  }

  stack {
    // Default rather than reject: firing is what an operator means by "the alerts page".
    var $state_filter {
      value = $input.state|first_notempty:"firing"
    }

    // "all" means do not constrain state at all; the null-safe ==? below drops a null comparison entirely.
    conditional {
      if ($state_filter == "all") {
        var.update $state_filter {
          value = null
        }
      }
    }

    // One query serves every filter combination: ==? and >=? are ignored when their right-hand side is null, so no branching is needed. device is joined for display and site both for display and as a filter target.
    db.query alert {
      join = {
        device: {table: "device", type: "inner", where: $db.alert.device_id == $db.device.id}
        site  : {table: "site", type: "left", where: $db.device.site_id == $db.site.id}
      }
      eval = {
        device_name  : $db.device.name
        device_serial: $db.device.serial
        device_status: $db.device.status
        site_id      : $db.device.site_id
        site_name    : $db.site.name
      }
      where = ($db.alert.state ==? $state_filter) && ($db.alert.severity ==? $input.severity) && ($db.alert.device_id ==? $input.device_id) && ($db.alert.incident_id ==? $input.incident_id) && ($db.device.site_id ==? $input.site_id) && ($db.alert.fired_at >=? $input.since)
      sort = {alert.fired_at: "desc"}
      return = {type: "list", paging: {page: $input.page, per_page: $input.per_page, totals: true}}
    } as $alerts
  }

  response = $alerts
  tags = ["nerve"]
}
