// The Fleet grid. Filters are all optional and widen rather than narrow when omitted, so the same endpoint serves the unfiltered grid and a deep-linked "offline freezers in Osaka" view.
query "devices" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    // Narrow to one site. Omitted means every site.
    int site_id?

    // Narrow to one device type. Omitted means every type.
    int device_type_id?

    // Mirrors the device.status enum; declared as an enum so a typo is a 400 rather than a silently empty grid.
    enum status? { values = ["online", "degraded", "offline", "maintenance", "provisioning"] }

    // Free text, matched as a substring against name and serial.
    text q?

    // health = worst first, which is the ordering an operator actually wants on open.
    enum sort? { values = ["health", "name", "last_seen"] }

    int page?=1

    int per_page?=25
  }

  stack {
    // A hostile or careless per_page is the easiest way to turn a grid request into an instance-wide stall, so it is capped here rather than trusted.
    precondition ($input.per_page > 0 && $input.per_page <= 100) {
      error_type = "inputerror"
      error = "per_page must be between 1 and 100."
    }

    // An empty-string q arrives from a cleared search box and must widen, not match nothing, so it is normalised to null before it reaches the null-safe operator below.
    var $q {
      value = $input.q|first_notempty:null
    }

    // Echoed in the response so the client can confirm which ordering the server actually applied rather than assuming its own default.
    var $sort_applied {
      value = "health"
    }

    // Paged result envelope; filled by exactly one arm of the switch below.
    var $devices {
      value = null
    }

    // `sort` will not accept a variable (the language server requires an object literal), so the ordering is switched by repeating the query rather than by building a sort spec. The where clause, join and paging are identical in every arm - only the sort object differs.
    switch ($input.sort) {
      case ("name") {
        var.update $sort_applied {
          value = "name"
        }

        // ==? and includes? are the null-safe forms: when the input is null the condition is dropped instead of comparing against null, which is what makes an omitted filter widen the result set.
        db.query device {
          join = {
            site       : {table: "site", type: "left", where: $db.device.site_id == $db.site.id}
            device_type: {table: "device_type", type: "left", where: $db.device.device_type_id == $db.device_type.id}
          }
          eval = {
            site_name           : $db.site.name
            site_code           : $db.site.code
            device_type_name    : $db.device_type.name
            device_type_code    : $db.device_type.code
            device_type_category: $db.device_type.category
          }
          where = $db.device.site_id ==? $input.site_id && $db.device.device_type_id ==? $input.device_type_id && $db.device.status ==? $input.status && ($db.device.name includes? $q || $db.device.serial includes? $q)
          sort = {device.name: "asc"}
          return = {type: "list", paging: {page: $input.page, per_page: $input.per_page, totals: true}}
        } as $by_name

        var.update $devices {
          value = $by_name
        }
      } break

      case ("last_seen") {
        var.update $sort_applied {
          value = "last_seen"
        }

        // Descending: the question this ordering answers is "what reported most recently", and its mirror image is the offline list.
        db.query device {
          join = {
            site       : {table: "site", type: "left", where: $db.device.site_id == $db.site.id}
            device_type: {table: "device_type", type: "left", where: $db.device.device_type_id == $db.device_type.id}
          }
          eval = {
            site_name           : $db.site.name
            site_code           : $db.site.code
            device_type_name    : $db.device_type.name
            device_type_code    : $db.device_type.code
            device_type_category: $db.device_type.category
          }
          where = $db.device.site_id ==? $input.site_id && $db.device.device_type_id ==? $input.device_type_id && $db.device.status ==? $input.status && ($db.device.name includes? $q || $db.device.serial includes? $q)
          sort = {device.last_seen_at: "desc"}
          return = {type: "list", paging: {page: $input.page, per_page: $input.per_page, totals: true}}
        } as $by_last_seen

        var.update $devices {
          value = $by_last_seen
        }
      } break

      default {
        // Also the null case: no sort supplied means the operator opened the grid cold, and worst-health-first is the only ordering that puts something actionable on the first page.
        db.query device {
          join = {
            site       : {table: "site", type: "left", where: $db.device.site_id == $db.site.id}
            device_type: {table: "device_type", type: "left", where: $db.device.device_type_id == $db.device_type.id}
          }
          eval = {
            site_name           : $db.site.name
            site_code           : $db.site.code
            device_type_name    : $db.device_type.name
            device_type_code    : $db.device_type.code
            device_type_category: $db.device_type.category
          }
          where = $db.device.site_id ==? $input.site_id && $db.device.device_type_id ==? $input.device_type_id && $db.device.status ==? $input.status && ($db.device.name includes? $q || $db.device.serial includes? $q)
          sort = {device.health_score: "asc"}
          return = {type: "list", paging: {page: $input.page, per_page: $input.per_page, totals: true}}
        } as $by_health

        var.update $devices {
          value = $by_health
        }
      }
    }
  }

  // No `output` projection on the query above, deliberately: the grid renders metrics_latest inline, so the denormalized last reading has to come back with the row - that column is the whole reason the grid is one query instead of N.
  response = {
    items      : $devices.items
    items_total: $devices.itemsTotal
    page       : $devices.curPage
    page_total : $devices.pageTotal
    per_page   : $input.per_page
    sort       : $sort_applied
    filters    : {
      site_id       : $input.site_id
      device_type_id: $input.device_type_id
      status        : $input.status
      q             : $q
    }
  }
  tags = ["nerve"]
  guid = "-aTayVnZ9lsVUvjbYvClR2su_18"
}
