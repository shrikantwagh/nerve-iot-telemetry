// The AI's own paper trail. Surfacing model, tokens, latency and fallback_used is a product feature, not debug output: an operator who cannot see what the AI cost and whether it actually ran has no reason to trust it.
query "ai/insights" verb=GET {
  api_group = "Nerve"
  auth = "user"
  description = "Paginated ai_insight feed, filterable by kind, device and incident. Every row carries its own provenance - model, input/output tokens, latency and whether the answer was model-generated or the deterministic fallback."

  input {
    // Page of the feed, newest first.
    int page?=1

    // Rows per page; clamped in the stack rather than with an input filter so the ceiling is visible in the response.
    int per_page?=25

    // Restricted to the ai_insight.kind enum by the input type itself, so an unknown kind is a 400 before any query runs.
    enum kind? {
      values = ["fleet_digest", "predictive_maintenance", "anomaly_explanation", "incident_triage", "postmortem", "rule_synthesis", "nl_query"]
    }

    // Scope the feed to one device - the device detail page's "what has the AI said about this thing" panel.
    int device_id? {
      table = "device"
    }

    // Scope the feed to one incident - the incident view's inference history, including superseded hypotheses.
    int incident_id? {
      table = "incident"
    }

    // Set true to look only at the inferences that degraded to the deterministic path, which is how a demo operator notices a missing key or a rate limit.
    bool only_fallback?=false
  }

  stack {
    // Read-only feed, but the token still has to resolve to a live user.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user not found."
    }

    // Page floor, so a 0 or negative page does not produce an empty feed that looks like "no insights".
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

    // Insight bodies are prose and can be long; 100 rows is the point where a page stops being a page.
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

    // Null unless only_fallback was asked for, so the null-safe operator below drops the clause entirely rather than filtering on false.
    var $fallback_filter {
      value = null
    }

    conditional {
      if ($input.only_fallback == true) {
        var.update $fallback_filter {
          value = true
        }
      }
    }

    // Every filter is null-safe (==?), so an omitted input removes its clause instead of matching null. created_at descending is the only ordering an inference feed wants.
    db.query ai_insight {
      where = $db.ai_insight.kind ==? $input.kind && $db.ai_insight.device_id ==? $input.device_id && $db.ai_insight.incident_id ==? $input.incident_id && $db.ai_insight.fallback_used ==? $fallback_filter
      sort = {ai_insight.created_at: "desc"}
      return = {type: "list", paging: {page: $page, per_page: $per_page, totals: true}}
    } as $insights

    // Cost and reliability roll-ups over the returned page. Cheap to compute here and it saves the UI from summing token columns client-side.
    var $rows {
      value = $insights.items|safe_array
    }

    // Total tokens on this page, so "what has the AI cost me" is answerable without an external billing console.
    var $input_tokens {
      value = 0
    }

    // Output side of the same accounting.
    var $output_tokens {
      value = 0
    }

    // How many of these answers were NOT model-generated. A high number is the signal that the key or the quota is the problem, not the prompt.
    var $fallback_count {
      value = 0
    }

    // Latency accumulator; averaged after the loop.
    var $latency_total {
      value = 0
    }

    foreach ($rows) {
      each as $row {
        math.add $input_tokens {
          value = ($row.input_tokens|first_notnull:0)
        }

        math.add $output_tokens {
          value = ($row.output_tokens|first_notnull:0)
        }

        math.add $latency_total {
          value = ($row.latency_ms|first_notnull:0)
        }

        conditional {
          if ($row.fallback_used == true) {
            math.add $fallback_count {
              value = 1
            }
          }
        }
      }
    }

    // Guarded division: an empty page must report 0, not blow up on a divide by zero.
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

    // Grouped under a single key so the frontend reads provenance as one object rather than five loose fields.
    var $page_stats {
      value = {
        returned       : $rows|count
        input_tokens   : $input_tokens
        output_tokens  : $output_tokens
        total_tokens   : $input_tokens + $output_tokens
        fallback_count : $fallback_count
        avg_latency_ms : $avg_latency_ms
      }
    }
  }

  response = {
    items     : $rows
    total     : $insights.itemsTotal
    page      : $insights.curPage
    page_total: $insights.pageTotal
    per_page  : $per_page
    page_stats: $page_stats
  }
  tags = ["nerve"]
  guid = "uJSukuwwYABnXhhkD_oSp6emcgo"
}
