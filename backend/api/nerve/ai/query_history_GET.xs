// The Ask console's history rail. It doubles as the proof the NL-to-query compiler works: every question ever asked, the plan it compiled to, and whether that plan survived validation.
query "ai/query-history" verb=GET {
  api_group = "Nerve"
  auth = "user"
  description = "Recent nl_query_log rows, newest first, with the question, the generated plan, the written answer, the row count and the success and fallback flags. Optionally scoped to the calling user or to failures only."

  input {
    // Page of the history, newest first.
    int page?=1

    // Rows per page; clamped in the stack.
    int per_page?=20

    // True for the personal "your recent questions" rail; false for the shared workspace history.
    bool only_mine?=false

    // True to review only the questions whose plan was rejected or whose execution failed - the fastest way to see where the compiler is losing.
    bool only_failed?=false
  }

  stack {
    // Read-only, but only_mine needs a resolved identity and the token needs to point at a live row.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user not found."
    }

    // Page floor: page 0 would return nothing and read as "no history".
    var $page {
      value = $input.page
    }

    conditional {
      if ($page < 1) {
        var.update $page {
          value = 1
        }
      }
    }

    // History rows carry a plan and a rows_preview blob, so the page ceiling is deliberately low.
    var $per_page {
      value = $input.per_page
    }

    conditional {
      if ($per_page < 1) {
        var.update $per_page {
          value = 1
        }
      }
      elseif ($per_page > 100) {
        var.update $per_page {
          value = 100
        }
      }
    }

    // Left null unless scoping was asked for, so the null-safe operator drops the clause instead of matching user_id == null (which would return the task-generated rows).
    var $user_filter {
      value = null
    }

    conditional {
      if ($input.only_mine == true) {
        var.update $user_filter {
          value = $auth.id
        }
      }
    }

    // Same pattern: null means "both outcomes", false means "failures only". It cannot be defaulted to true, because true would hide nothing.
    var $success_filter {
      value = null
    }

    conditional {
      if ($input.only_failed == true) {
        var.update $success_filter {
          value = false
        }
      }
    }

    // created_at descending is the only ordering a history rail wants; the two filters are null-safe so an omitted input removes its clause.
    db.query nl_query_log {
      where = $db.nl_query_log.user_id ==? $user_filter && $db.nl_query_log.success ==? $success_filter
      sort = {nl_query_log.created_at: "desc"}
      return = {type: "list", paging: {page: $page, per_page: $per_page, totals: true}}
    } as $history

    // Hoisted so the roll-up loop and the response read the same array.
    var $rows {
      value = $history.items|safe_array
    }

    // Compiler health over the returned page: how many plans validated, and how many answers were model-written rather than deterministic.
    var $success_count {
      value = 0
    }

    // A high fallback count on a page of successes means the plans are fine and the API key is not.
    var $fallback_count {
      value = 0
    }

    // Latency accumulator for the average below.
    var $latency_total {
      value = 0
    }

    foreach ($rows) {
      each as $row {
        conditional {
          if ($row.success == true) {
            math.add $success_count {
              value = 1
            }
          }
        }

        conditional {
          if ($row.fallback_used == true) {
            math.add $fallback_count {
              value = 1
            }
          }
        }

        math.add $latency_total {
          value = ($row.latency_ms|first_notnull:0)
        }
      }
    }

    // Guarded so an empty history reports 0 rather than dividing by zero.
    var $avg_latency_ms {
      value = 0
    }

    conditional {
      if (($rows|count) > 0) {
        var.update $avg_latency_ms {
          value = (($latency_total / ($rows|count))|round:0)
        }
      }
    }

    // One object, so the UI renders "12 of 20 answered, 3 fell back, 1.4s average" without arithmetic.
    var $page_stats {
      value = {
        returned      : $rows|count
        success_count : $success_count
        fallback_count: $fallback_count
        avg_latency_ms: $avg_latency_ms
      }
    }
  }

  response = {
    items     : $rows
    total     : $history.itemsTotal
    page      : $history.curPage
    page_total: $history.pageTotal
    per_page  : $per_page
    page_stats: $page_stats
  }
  tags = ["nerve"]
  guid = "MIcrQJN26baKeRYY_Z5uzAWxuXw"
}
