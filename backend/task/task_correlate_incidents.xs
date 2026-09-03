// The alert-to-incident collapse, on a timer. Two minutes is the compromise: fast enough that a cascade becomes one incident while the operator is still reading the first alert, slow enough that a burst of alerts from one cause arrives in the same sweep rather than being split across two incidents.
task task_correlate_incidents {
  description = "Every 2 minutes, groups unattached firing alerts into incidents via Nerve/fn_correlate and lets it spend one Claude inference per newly created incident."
  active = true

  stack {
    // All the work lives in fn_correlate so the same logic backs POST /incidents/{id}/analyze. The 15-minute lookback matches the function's own default and is wider than this task's own 2-minute cadence on purpose: an alert that arrived while the previous sweep was running still gets correlated.
    function.run "Nerve/fn_correlate" {
      input = {lookback_seconds: 900, call_ai: true}
    } as $result

    // Bounded by construction: the candidate set is only firing alerts with no incident_id inside the window, so a quiet fleet costs one query and a noisy one is capped by the window, not by table size.
    debug.log {
      value = "task_correlate_incidents: touched " ~ ($result.incidents_touched|to_text) ~ " incident(s), created " ~ ($result.incidents_created|to_text) ~ ", grouped " ~ ($result.alerts_grouped|to_text) ~ " alert(s)."
    }

    // Only audit sweeps that changed something. A row every 2 minutes saying "nothing happened" would make the audit log unreadable, which is the one thing an audit log may not be.
    conditional {
      if ($result.incidents_touched > 0) {
        function.run "Nerve/fn_audit" {
          input = {
            action     : "incident.correlate"
            entity_type: "incident"
            detail     : $result
            source     : "task"
          }
        } as $audit
      }
    }
  }

  schedule = [{starts_on: 2026-09-03 00:00:00+0000, freq: 120}]
  tags = ["nerve"]
}
