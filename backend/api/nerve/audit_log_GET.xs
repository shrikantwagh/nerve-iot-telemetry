// The answer to "who changed this, and when". Newest first, paged, and filterable - an audit log you cannot narrow is an audit log nobody reads.
query "audit-log" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
    // 1-based, matching Xano's paging convention.
    int page?=1

    // Clamped in the stack rather than trusted; an unbounded per_page is a denial-of-service handed to the caller.
    int per_page?=50

    // Exact action slug, e.g. "api_key.create". Exact rather than substring so a filter means one thing.
    text action?

    // Narrow to a single actor. Null actions (device- and task-originated) are excluded when this is set, which is the intent.
    int user_id? { table = "user" }
  }

  stack {
    // Role read fresh from the row, so a demotion takes effect immediately.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    // Valid token, deleted account.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "The account for this token no longer exists."
    }

    // The audit log records every actor's actions, so reading it is an admin capability - an operator seeing it would be an information leak, not a convenience.
    precondition ($user.role == "admin") {
      error_type = "accessdenied"
      error = "Admin role required."
    }

    // Working copy of the page size.
    var $per_page {
      value = $input.per_page
    }

    // Explicit clamp both ways. The scalar min/max filter aliases are rejected by the language server, so the bounds are written as conditionals.
    conditional {
      if ($input.per_page > 200) {
        var.update $per_page {
          value = 200
        }
      }
      elseif ($input.per_page < 1) {
        var.update $per_page {
          value = 1
        }
      }
    }

    // Both filters use the parenthesised-OR form: a null input satisfies its own clause, so one where clause covers all four filter combinations without branching.
    db.query audit_log {
      where = (($input.action == null) || ($db.audit_log.action == $input.action)) && (($input.user_id == null) || ($db.audit_log.user_id == $input.user_id))
      sort = {audit_log.created_at: "desc"}
      return = {type: "list", paging: {page: $input.page, per_page: $per_page, totals: true}}
    } as $entries
  }

  response = $entries
  tags = ["nerve"]
  guid = "vcpcUimXzZ5MBak585dZoajVbQc"
}
