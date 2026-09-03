// The incident list is the product's front door. Datadog hands you a thousand alerts; this hands you a short list of things that have a hypothesis attached, newest first.
query "incidents" verb=GET {
  api_group = "Nerve"
  auth = "user"
  description = "Paginated incident list, unresolved first by default, with site and assignee names, size, age and the AI summary already attached so the list view needs no follow-up calls."

  input {
    // Page cursor. 1-based to match Xano's own paging envelope.
    int page?=1 filters=min:1

    // Bounded so a client cannot ask for the whole table and stall the enrichment loop below.
    int per_page?=25 filters=min:1|max:100

    // Explicit state filter. Supplying any value - including "resolved" - overrides the unresolved-only default.
    enum state? {
      values = ["open", "investigating", "mitigated", "resolved"]
    }

    // Severity of the incident, which is the worst severity among its member alerts.
    enum severity? {
      values = ["critical", "warning", "info"]
    }

    // Scope to one physical location.
    int site_id?

    // Scope to one operator's queue.
    int assigned_to?
  }

  stack {
    // Unresolved-by-default: an operator opening this list wants work, not history. Expressed as a null-safe exclusion rather than an IN list so an explicit state filter can still ask for resolved incidents.
    var $exclude_state {
      value = null
    }

    // Only exclude when the caller has not pinned a state of their own.
    conditional {
      if ($input.state == null) {
        var.update $exclude_state {
          value = "resolved"
        }
      }
    }

    // All five filters use the null-safe comparison operators, so one query serves every filter combination instead of a branching pile of queries.
    db.query incident {
      where = $db.incident.state ==? $input.state && $db.incident.state !=? $exclude_state && $db.incident.severity ==? $input.severity && $db.incident.site_id ==? $input.site_id && $db.incident.assigned_to ==? $input.assigned_to
      sort = {incident.opened_at: "desc"}
      return = {
        type  : "list"
        paging: {page: $input.page, per_page: $input.per_page, totals: true}
      }
    } as $page

    // One clock for the whole page, so two rows opened a second apart do not get ages computed against different "now"s.
    var $now_ms {
      value = "now"|to_ms
    }

    // Rows are enriched per row rather than by join: a join would have to alias site and user onto one row, and the loop is bounded by per_page.
    var $rows {
      value = []
    }

    foreach ($page.items) {
      each as $incident {
        // The list is read by a human, so it carries the site's name, not its id.
        db.get site {
          field_name = "id"
          field_value = $incident.site_id
          output = ["id", "name", "code"]
        } as $site

        // Null for an unassigned incident, which the UI renders as "unassigned" rather than as a blank name.
        db.get user {
          field_name = "id"
          field_value = $incident.assigned_to
          output = ["id", "name"]
        } as $assignee

        // Age is computed server-side so every client agrees on it without doing timezone maths.
        var $age_seconds {
          value = (($now_ms - ($incident.opened_at|to_ms)) / 1000)|floor
        }

        // A real question for the UI: an incident correlated while Anthropic was unreachable carries only deterministic text, and the badge should say so.
        var $has_ai_analysis {
          value = !($incident.ai_summary|is_empty)
        }

        // Flat row shape: everything the list view renders, nothing it does not.
        array.push $rows {
          value = {
            id                : $incident.id
            title             : $incident.title
            severity          : $incident.severity
            state             : $incident.state
            site_id           : $incident.site_id
            site_name         : $site|get:"name":null
            device_count      : $incident.device_count
            alert_count       : $incident.alert_count
            opened_at         : $incident.opened_at
            resolved_at       : $incident.resolved_at
            age_seconds       : $age_seconds
            assigned_to       : $incident.assigned_to
            assignee_name     : $assignee|get:"name":null
            ai_summary        : $incident.ai_summary
            ai_confidence     : $incident.ai_confidence
            ai_fallback_used  : $incident.ai_fallback_used
            has_ai_analysis   : $has_ai_analysis
            correlation_reason: $incident.correlation_reason
          }
        }
      }
    }
  }

  response = {
    items       : $rows
    page        : $page|get:"curPage":1
    per_page    : $input.per_page
    next_page   : $page|get:"nextPage":null
    items_total : $page|get:"itemsTotal":0
    page_total  : $page|get:"pageTotal":0
    default_view: $exclude_state == "resolved"
  }
  tags = ["nerve"]
  guid = "Uu0LBF5HK3qpKp70gD7St_v5qHs"
}
