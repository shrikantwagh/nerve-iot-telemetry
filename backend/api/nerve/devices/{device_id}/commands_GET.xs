// The read half of the command console: what was asked of this machine, by whom, and whether it ever answered. Newest first, because during an incident the only interesting command is the last one.
query "devices/{device_id}/commands" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    int device_id { table = "device" }

    // Optional lane filter - "what is still queued" is the common question mid-incident.
    enum state? { values = ["queued", "sent", "acked", "failed", "expired"] }

    int page?=1

    int per_page?=50
  }

  stack {
    // Any authenticated role may read command history; only operator and admin may write it. Existence is still checked so a bad device id is a 404 rather than a convincing empty list.
    db.has device {
      field_name = "id"
      field_value = $input.device_id
    } as $device_exists

    precondition ($device_exists) {
      error_type = "notfound"
      error = "Device not found."
    }

    // Left join on user: issued_by is null for commands raised by a task rather than a person, and an inner join would hide exactly those.
    db.query device_command {
      join = {
        issuer: {table: "user", type: "left", where: $db.device_command.issued_by == $db.user.id}
      }
      eval = {
        issued_by_name: $db.user.name
      }
      where = $db.device_command.device_id == $input.device_id && ($db.device_command.state ==? $input.state)
      sort = {device_command.created_at: "desc"}
      return = {type: "list", paging: {page: $input.page, per_page: $input.per_page, totals: true}}
    } as $commands
  }

  // Paged rather than capped, unlike /predictions: this is a history, so page 9 is a legitimate thing to want.
  response = {
    items    : $commands.items
    total    : $commands.itemsTotal
    page     : $commands.curPage
    pages    : $commands.pageTotal
    device_id: $input.device_id
  }
  tags = ["nerve"]
  guid = "gt1-haunbusqyoyLT__Zrp35St4"
}
