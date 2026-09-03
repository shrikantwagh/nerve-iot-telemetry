// Second demo beat: "page me if any freezer sits above -15C for 10 minutes" becomes a populated alert_rule. The model fills a fixed schema and names its scope as CODES; Xano resolves those codes to ids and validates the result exactly as POST /alert-rules would, so nothing the model invents can reach the table.
query "ai/rule-from-text" verb=POST {
  api_group = "Nerve"
  auth = "user"
  description = "Synthesises an alert_rule from one English sentence. Claude fills a fixed JSON schema and names the scope as a device type code and a site code; Xano resolves those codes against the live fleet, validates the condition, metric key, thresholds and window the same way the manual rule endpoint would, and returns the proposal with a plain-English restatement so a human can catch a misread before saving. Saving requires operator role and is closed to the demo account."

  input {
    // The sentence a human typed. Kept verbatim on the saved rule as natural_language_source, which is what makes an AI-generated rule self-documenting.
    text text filters=trim

    // False returns the proposal for confirmation; true persists it. Defaulting to false is the whole point - a misread rule that pages an on-call engineer at 3am is worse than no rule.
    bool save?=false
  }

  stack {
    // Latency is logged on the insight by fn_claude, but the endpoint reports its own so the UI can show the round trip.
    var $started_ms {
      value = "now"|to_ms
    }

    // Role and demo status both come off the user row; the gates below only apply on the save path.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user not found."
    }

    // A sentence shorter than this cannot express a condition, and asking the model to try wastes an inference.
    precondition (($input.text|strlen) > 5) {
      error_type = "inputerror"
      error = "Describe the rule in a sentence of at least six characters."
    }

    // Ranks rather than string equality, so the gate reads as a threshold.
    var $role_levels {
      value = {viewer: 1, operator: 2, admin: 3}
    }

    // An unrecognised role scores 0 and is denied - failing closed is the only safe default.
    var $role_rank {
      value = $role_levels|get:$user.role|first_notnull:0
    }

    // Proposing is open to every role, including the demo account: it writes nothing but an ai_insight row. Persisting is an operator action, and it mutates fleet state, so the demo account is refused.
    conditional {
      if ($input.save == true) {
        precondition ($role_rank >= 2) {
          error_type = "accessdenied"
          error = "Operator role or higher is required to save an alert rule."
        }

        precondition ($user.demo_account == false) {
          error_type = "accessdenied"
          error = "The demo account is read-only."
        }
      }
    }

    // THE ENUMS, hardcoded from the alert_rule schema. A condition or severity outside these lists is a rejection: the column is a Postgres enum and an invalid value would fail at insert time with an unreadable error instead of a readable one here.
    var $condition_allow {
      value = ["gt", "lt", "outside_range", "rate_of_change", "flatline", "offline", "anomaly"]
    }

    // alert_rule.severity's enum, in worst-first order.
    var $severity_allow {
      value = ["critical", "warning", "info"]
    }

    // Conditions that compare a reading to a fixed number, and therefore cannot fire without a threshold. Gating on this is what stops a half-configured rule firing on a null comparison.
    var $needs_threshold {
      value = ["gt", "lt", "rate_of_change", "outside_range"]
    }

    // Conditions that have no metric of their own. offline is the absence of readings, so it is scoped to a device rather than to a metric key.
    var $no_metric_needed {
      value = ["offline"]
    }

    // Scope vocabulary, read live: the model is given real codes and its answer is resolved against this same list, so a hallucinated code is caught rather than stored as a dangling scope.
    db.query site {
      sort = {site.code: "asc"}
      return = {type: "list"}
    } as $sites

    // Device types also carry the metric_schema the metric-key vocabulary comes from.
    db.query device_type {
      sort = {device_type.code: "asc"}
      return = {type: "list"}
    } as $device_types

    // Rendered site vocabulary for the prompt.
    var $site_lines {
      value = []
    }

    foreach ($sites) {
      each as $site {
        array.push $site_lines {
          value = ($site.code|to_text) ~ " (" ~ ($site.name|to_text) ~ ")"
        }
      }
    }

    // Rendered type vocabulary, plus the metric keys those types declare.
    var $type_lines {
      value = []
    }

    // Every metric key the fleet is supposed to report. A rule on a key no type declares can never fire, so this list is a validation input, not just prompt decoration.
    var $metric_keys {
      value = []
    }

    // Metric descriptors, so the prompt can tell the model a unit and a nominal band and it can pick a sensible threshold.
    var $metric_lines {
      value = []
    }

    foreach ($device_types) {
      each as $dt {
        array.push $type_lines {
          value = ($dt.code|to_text) ~ " (" ~ ($dt.name|to_text) ~ ", category " ~ ($dt.category|to_text) ~ ")"
        }

        // Hoisted so foreach iterates a plain variable; safe_array so a type with no schema does not break the loop.
        var $schema {
          value = $dt.metric_schema|safe_array
        }

        foreach ($schema) {
          each as $metric {
            var $mkey {
              value = ($metric|get:"key"|first_notempty:"")|to_text
            }

            array.push $metric_keys {
              value = $mkey
            }

            array.push $metric_lines {
              value = $mkey ~ " on " ~ ($dt.code|to_text) ~ " [" ~ (($metric|get:"unit"|first_notempty:"")|to_text) ~ "] nominal " ~ (($metric|get:"nominal_min"|first_notempty:"?")|to_text) ~ " to " ~ (($metric|get:"nominal_max"|first_notempty:"?")|to_text)
            }
          }
        }
      }
    }

    // filter_empty drops the placeholders left by types with no schema; unique collapses keys shared across types.
    var $metric_key_list {
      value = ($metric_keys|filter_empty)|unique
    }

    // Full contract, stated once. Strict JSON because the reply is written into typed enum and decimal columns, not rendered as prose.
    var $synth_system {
      value = "You are Nerve's alert-rule compiler. You turn one English sentence from an operator into a populated alert_rule. Reply with STRICT JSON only - no prose, no explanation, no markdown fence. Use exactly these keys: name (a short human title, under 60 characters, no quotes), description (one sentence explaining what the rule watches for), condition (exactly one of gt, lt, outside_range, rate_of_change, flatline, offline, anomaly), metric_key (one of the metric keys listed in the vocabulary block, or null only when condition is offline), threshold (a number, required for gt, lt, rate_of_change and as the LOWER bound for outside_range; null otherwise), threshold_high (a number, required only for outside_range as the UPPER bound; null otherwise), window_seconds (an integer, how long the condition must hold before it counts, 0 if the sentence does not say), z_threshold (a number of standard deviations, used only by condition anomaly, 3 if the sentence does not say), severity (exactly one of critical, warning, info), cooldown_seconds (an integer, the minimum gap between repeat alerts, 900 if the sentence does not say), device_type_code (the CODE of the device type the rule is scoped to, taken verbatim from the vocabulary block, or null for every device type), site_code (the CODE of the site the rule is scoped to, taken verbatim from the vocabulary block, or null for every site). CONDITION SEMANTICS: gt fires when the metric rises above threshold; lt when it falls below threshold; outside_range when it leaves the band between threshold and threshold_high; rate_of_change when the absolute change between consecutive readings exceeds threshold; flatline when the metric stops changing at all, which usually means a stuck sensor rather than a stable machine; offline when a device stops reporting; anomaly when the reading deviates from that device's OWN learned baseline by more than z_threshold standard deviations, which is the right choice when the sentence describes something unusual rather than a fixed number. GROUNDING RULES: use ONLY the metric keys, device type codes and site codes given in the vocabulary block - never invent an identifier, and never return an id in place of a code. If the sentence names a scope that is not in the vocabulary, set that scope to null and say so in description rather than guessing a code, because a rule scoped to a nonexistent type silently never fires. If the sentence implies a paging or wake-someone-up urgency, use severity critical; if it describes something to look at later, use info; otherwise use warning. Prefer a wider scope with a correct metric over a narrow scope with a guessed one. Emit the JSON object and nothing else."
    }

    // The prompt carries the sentence and the live vocabulary, and nothing derived.
    var $synth_prompt {
      value = "SENTENCE: " ~ $input.text ~ " || DEVICE TYPE CODES -- " ~ ($type_lines|join:" || ") ~ " || SITE CODES -- " ~ ($site_lines|join:" || ") ~ " || METRIC KEYS -- " ~ ($metric_key_list|join:", ") ~ " || METRIC DETAIL (key on type [unit] nominal band) -- " ~ ($metric_lines|join:" || ")
    }

    function.run "Nerve/fn_claude" {
      input = {
        system     : $synth_system
        user_prompt: $synth_prompt
        max_tokens : 700
        kind       : "rule_synthesis"
        title      : "Rule from text: " ~ $input.text
        expect_json: true
      }
    } as $synth

    // Proposal fields are hoisted so the model path and the keyword path fill the SAME variables, leaving the validator below exactly one shape to check.
    var $p_name {
      value = null
    }

    // Free-text description stored on the rule.
    var $p_description {
      value = null
    }

    // Defaults to gt because it is the condition an unparsed "above/over" sentence almost always means; validated regardless.
    var $p_condition {
      value = "gt"
    }

    // Null is legal only for condition offline.
    var $p_metric_key {
      value = null
    }

    // Lower bound / single threshold.
    var $p_threshold {
      value = null
    }

    // Upper bound, outside_range only.
    var $p_threshold_high {
      value = null
    }

    // Sustain window in seconds. Recorded on the rule; see the caveat assembled below about how the current engine treats it.
    var $p_window_seconds {
      value = 0
    }

    // Standard deviations, anomaly only. 3 matches the alert_rule column default.
    var $p_z_threshold {
      value = 3
    }

    // Matches the column default.
    var $p_severity {
      value = "warning"
    }

    // Matches the column default: at most one alert per rule per 15 minutes, which is the anti-alert-fatigue setting.
    var $p_cooldown_seconds {
      value = 900
    }

    // Scope as the model named it: codes, not ids. Resolved below.
    var $p_dt_code {
      value = null
    }

    // Site scope, same.
    var $p_site_code {
      value = null
    }

    // True until a parsed model proposal replaces it. A silent empty text is a valid response from fn_claude, so both the flag and the json are checked.
    var $fallback_used {
      value = true
    }

    // Lower-cased once for every keyword test in the fallback path.
    var $q {
      value = $input.text|to_lower
    }

    conditional {
      if (($synth.fallback_used == false) && ($synth.json != null)) {
        var $proposal {
          value = $synth.json
        }

        var.update $fallback_used {
          value = false
        }

        var.update $p_name {
          value = $proposal|get:"name"
        }

        var.update $p_description {
          value = $proposal|get:"description"
        }

        var.update $p_condition {
          value = ($proposal|get:"condition"|first_notempty:"gt")|to_text
        }

        var.update $p_metric_key {
          value = $proposal|get:"metric_key"
        }

        var.update $p_threshold {
          value = $proposal|get:"threshold"
        }

        var.update $p_threshold_high {
          value = $proposal|get:"threshold_high"
        }

        var.update $p_window_seconds {
          value = ($proposal|get:"window_seconds"|first_notnull:0)|to_int
        }

        var.update $p_z_threshold {
          value = ($proposal|get:"z_threshold"|first_notnull:3)|to_decimal
        }

        var.update $p_severity {
          value = ($proposal|get:"severity"|first_notempty:"warning")|to_text
        }

        var.update $p_cooldown_seconds {
          value = ($proposal|get:"cooldown_seconds"|first_notnull:900)|to_int
        }

        var.update $p_dt_code {
          value = $proposal|get:"device_type_code"
        }

        var.update $p_site_code {
          value = $proposal|get:"site_code"
        }
      }
      else {
        // DETERMINISTIC SYNTHESISER. Crude by design: it never invents an identifier, because every value it can emit is either a literal from the enum lists above or a string it found in the live vocabulary.
        conditional {
          if (($q|icontains:"flatline") || ($q|icontains:"stuck") || ($q|icontains:"stops changing") || ($q|icontains:"frozen reading")) {
            var.update $p_condition {
              value = "flatline"
            }
          }
          elseif (($q|icontains:"offline") || ($q|icontains:"stops reporting") || ($q|icontains:"goes quiet") || ($q|icontains:"unreachable")) {
            var.update $p_condition {
              value = "offline"
            }
          }
          elseif (($q|icontains:"anomal") || ($q|icontains:"unusual") || ($q|icontains:"out of character") || ($q|icontains:"baseline")) {
            var.update $p_condition {
              value = "anomaly"
            }
          }
          elseif (($q|icontains:"below") || ($q|icontains:"under") || ($q|icontains:"drops") || ($q|icontains:"less than")) {
            var.update $p_condition {
              value = "lt"
            }
          }
          elseif (($q|icontains:"outside") || ($q|icontains:"out of range") || ($q|icontains:"between")) {
            var.update $p_condition {
              value = "outside_range"
            }
          }
          elseif (($q|icontains:"changes by") || ($q|icontains:"rate of change") || ($q|icontains:"spike")) {
            var.update $p_condition {
              value = "rate_of_change"
            }
          }
        }

        // "page me" and "wake" are the words operators use when they mean critical; nothing else in the sentence carries that signal.
        conditional {
          if (($q|icontains:"page") || ($q|icontains:"wake") || ($q|icontains:"urgent") || ($q|icontains:"critical") || ($q|icontains:"immediately")) {
            var.update $p_severity {
              value = "critical"
            }
          }
          elseif (($q|icontains:"note") || ($q|icontains:"later") || ($q|icontains:"fyi") || ($q|icontains:"informational")) {
            var.update $p_severity {
              value = "info"
            }
          }
        }

        // Direct metric-key hit: the sentence literally contains a declared key.
        foreach ($metric_key_list) {
          each as $mk {
            conditional {
              if (($p_metric_key == null) && ($q|icontains:$mk)) {
                var.update $p_metric_key {
                  value = $mk
                }
              }
            }
          }
        }

        // Second pass on the words humans actually use, mapped onto whichever declared key contains that stem. "freezer above -15" says temperature without ever saying temp_c.
        var $metric_hints {
          value = ["temp", "vibrat", "batter", "volt", "humid", "press", "speed", "load", "current", "power", "rpm", "torque"]
        }

        foreach ($metric_hints) {
          each as $hint {
            conditional {
              if (($p_metric_key == null) && ($q|icontains:$hint)) {
                foreach ($metric_key_list) {
                  each as $mk2 {
                    conditional {
                      if (($p_metric_key == null) && ($mk2|icontains:$hint)) {
                        var.update $p_metric_key {
                          value = $mk2
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Scope by whichever declared type code or type name appears in the sentence. "freezer" matches the FREEZER type's name, which is exactly how an operator would say it.
        foreach ($device_types) {
          each as $dt2 {
            conditional {
              if (($p_dt_code == null) && (($q|icontains:($dt2.code|to_text)) || ($q|icontains:($dt2.name|to_text)))) {
                var.update $p_dt_code {
                  value = $dt2.code
                }
              }
            }
          }
        }

        // Same for sites: "in Osaka" matches the site name, not the code.
        foreach ($sites) {
          each as $site2 {
            conditional {
              if (($p_site_code == null) && (($q|icontains:($site2.code|to_text)) || ($q|icontains:($site2.name|to_text)))) {
                var.update $p_site_code {
                  value = $site2.code
                }
              }
            }
          }
        }

        // Numbers, in the order they appear. The pattern is the PIPED value and the sentence is the argument - that is the documented direction for the regex filters, and getting it backwards silently matches nothing.
        var $number_matches {
          value = ("/-?[0-9]+(?:[.][0-9]+)?/"|regex_get_all_matches:$input.text)|flatten
        }

        // First number is the threshold. Left null when the sentence has none, which the validator below turns into a readable violation rather than a rule that fires on zero.
        conditional {
          if (($number_matches|count) > 0) {
            var.update $p_threshold {
              value = ($number_matches|first)|to_decimal
            }
          }
        }

        // Second number is the upper bound for a range sentence ("between 2 and 8").
        conditional {
          if ((($number_matches|count) > 1) && ($p_condition == "outside_range")) {
            var.update $p_threshold_high {
              value = (($number_matches|slice:1:1)|first)|to_decimal
            }
          }
        }

        // A second number in a duration sentence is the window. "for 10 minutes" is the demo sentence, so minutes are handled explicitly rather than assumed to be seconds.
        conditional {
          if ((($number_matches|count) > 1) && (($q|icontains:"minute") || ($q|icontains:" min"))) {
            var.update $p_window_seconds {
              value = ((($number_matches|slice:1:1)|first)|to_int) * 60
            }
          }
          elseif ((($number_matches|count) > 1) && ($q|icontains:"hour")) {
            var.update $p_window_seconds {
              value = ((($number_matches|slice:1:1)|first)|to_int) * 3600
            }
          }
        }

        // A name is required by the column, so one is always produced. The sentence itself is the most honest title available.
        var.update $p_name {
          value = "Rule from: " ~ (($input.text|substr:0:52)|trim)
        }

        // Marked as keyword-derived so a reviewer knows no model saw this.
        var.update $p_description {
          value = "Interpreted from an operator sentence without a language model (keyword synthesis)."
        }
      }
    }

    // VALIDATION, collected rather than thrown one at a time so a reviewer sees everything wrong with the proposal in one response.
    var $violations {
      value = []
    }

    // The softer half: values that were clamped or coerced rather than refused.
    var $warnings {
      value = []
    }

    // Condition first, because every threshold check below is relative to it.
    conditional {
      if (($condition_allow|in:$p_condition) == false) {
        array.push $violations {
          value = "condition '" ~ ($p_condition|to_text) ~ "' is not an alert_rule condition. Allowed: " ~ ($condition_allow|join:", ") ~ "."
        }
      }
    }

    // Severity is coerced rather than refused: an unrecognised urgency word should not lose the whole rule.
    conditional {
      if (($severity_allow|in:$p_severity) == false) {
        array.push $warnings {
          value = "severity '" ~ ($p_severity|to_text) ~ "' is not a valid severity and was set to warning."
        }

        var.update $p_severity {
          value = "warning"
        }
      }
    }

    // A name is NOT NULL on the table, so an empty one is a rejection rather than a coercion to something meaningless.
    conditional {
      if ($p_name|is_empty) {
        array.push $violations {
          value = "the rule needs a name and none could be derived from the sentence."
        }
      }
    }

    // Every condition except offline compares a named metric, so a missing key means the rule can never evaluate anything.
    conditional {
      if (($no_metric_needed|in:$p_condition) == false) {
        conditional {
          if ($p_metric_key|is_empty) {
            array.push $violations {
              value = "condition '" ~ ($p_condition|to_text) ~ "' needs a metric_key, and none was named. Known metric keys: " ~ ($metric_key_list|join:", ") ~ "."
            }
          }
          elseif ((($metric_key_list|count) > 0) && (($metric_key_list|in:$p_metric_key) == false)) {
            array.push $violations {
              value = "metric_key '" ~ ($p_metric_key|to_text) ~ "' is not declared by any device type, so a rule on it could never fire. Known metric keys: " ~ ($metric_key_list|join:", ") ~ "."
            }
          }
        }
      }
    }

    // Threshold gate, mirroring the rule engine: fn_evaluate_rules refuses to fire a threshold condition on a null threshold, so a rule saved without one is dead weight in the table.
    conditional {
      if (($needs_threshold|in:$p_condition) && ($p_threshold == null)) {
        array.push $violations {
          value = "condition '" ~ ($p_condition|to_text) ~ "' needs a numeric threshold and no number was found in the sentence."
        }
      }
    }

    // outside_range needs both bounds, and needs them the right way round, or the band it describes is empty.
    conditional {
      if ($p_condition == "outside_range") {
        conditional {
          if ($p_threshold_high == null) {
            array.push $violations {
              value = "condition 'outside_range' needs both threshold (lower bound) and threshold_high (upper bound); only one number was found."
            }
          }
          elseif (($p_threshold != null) && ($p_threshold_high <= $p_threshold)) {
            array.push $violations {
              value = "threshold_high (" ~ ($p_threshold_high|to_text) ~ ") must be greater than threshold (" ~ ($p_threshold|to_text) ~ ") for an outside_range rule."
            }
          }
        }
      }
    }

    // A zero or negative z_threshold would make an anomaly rule fire on every reading, which is the alert-fatigue failure this product exists to prevent.
    conditional {
      if (($p_condition == "anomaly") && ($p_z_threshold <= 0)) {
        array.push $warnings {
          value = "z_threshold must be positive; it was set to the column default of 3."
        }

        var.update $p_z_threshold {
          value = 3
        }
      }
    }

    // Window clamp. A negative window is meaningless and a window longer than a day belongs in a report, not an alert.
    conditional {
      if ($p_window_seconds < 0) {
        var.update $p_window_seconds {
          value = 0
        }
      }
      elseif ($p_window_seconds > 86400) {
        array.push $warnings {
          value = "window_seconds was clamped to 86400 (one day)."
        }

        var.update $p_window_seconds {
          value = 86400
        }
      }
    }

    // Cooldown clamp, same reasoning. A zero cooldown is legal but noisy, so it is allowed and flagged.
    conditional {
      if ($p_cooldown_seconds < 0) {
        var.update $p_cooldown_seconds {
          value = 0
        }
      }
      elseif ($p_cooldown_seconds > 86400) {
        array.push $warnings {
          value = "cooldown_seconds was clamped to 86400 (one day)."
        }

        var.update $p_cooldown_seconds {
          value = 86400
        }
      }
    }

    // SCOPE RESOLUTION. Codes are matched case-insensitively against the lists already loaded above rather than with a fresh db.get, both to save a query and because a model that returns "freezer" for code "FREEZER" should not lose its scope over capitalisation.
    var $dt_id {
      value = null
    }

    // Carried into the restatement, so the human confirms a name rather than an id.
    var $dt_label {
      value = null
    }

    conditional {
      if (($p_dt_code|is_empty) == false) {
        foreach ($device_types) {
          each as $dt3 {
            conditional {
              if (($dt_id == null) && ((($dt3.code|to_text)|to_lower) == (($p_dt_code|to_text)|to_lower))) {
                var.update $dt_id {
                  value = $dt3.id
                }

                var.update $dt_label {
                  value = ($dt3.code|to_text) ~ " (" ~ ($dt3.name|to_text) ~ ")"
                }
              }
            }
          }
        }

        // An unresolvable code is a rejection, not a dropped scope: silently widening a rule from one device type to the whole fleet would page an operator about machines they did not ask about.
        conditional {
          if ($dt_id == null) {
            array.push $violations {
              value = "device_type_code '" ~ ($p_dt_code|to_text) ~ "' does not match any device type. Known codes: " ~ ($type_lines|join:", ") ~ "."
            }
          }
        }
      }
    }

    // Site scope, resolved identically.
    var $site_id {
      value = null
    }

    // Human label for the restatement.
    var $site_label {
      value = null
    }

    conditional {
      if (($p_site_code|is_empty) == false) {
        foreach ($sites) {
          each as $site3 {
            conditional {
              if (($site_id == null) && ((($site3.code|to_text)|to_lower) == (($p_site_code|to_text)|to_lower))) {
                var.update $site_id {
                  value = $site3.id
                }

                var.update $site_label {
                  value = ($site3.code|to_text) ~ " (" ~ ($site3.name|to_text) ~ ")"
                }
              }
            }
          }
        }

        conditional {
          if ($site_id == null) {
            array.push $violations {
              value = "site_code '" ~ ($p_site_code|to_text) ~ "' does not match any site. Known codes: " ~ ($site_lines|join:", ") ~ "."
            }
          }
        }
      }
    }

    // One boolean gates the save. Everything above is inspection; nothing has been written yet.
    var $valid {
      value = ($violations|count) == 0
    }

    // PLAIN-ENGLISH RESTATEMENT, built from the VALIDATED values rather than from the model's prose. This is the point of the save=false default: a human reads what the rule will actually do and catches a misread before an on-call engineer does.
    var $condition_phrase {
      value = "meets its condition"
    }

    switch ($p_condition) {
      case ("gt") {
        var.update $condition_phrase {
          value = ($p_metric_key|to_text) ~ " rises above " ~ ($p_threshold|to_text)
        }
      } break

      case ("lt") {
        var.update $condition_phrase {
          value = ($p_metric_key|to_text) ~ " falls below " ~ ($p_threshold|to_text)
        }
      } break

      case ("outside_range") {
        var.update $condition_phrase {
          value = ($p_metric_key|to_text) ~ " leaves the band " ~ ($p_threshold|to_text) ~ " to " ~ ($p_threshold_high|to_text)
        }
      } break

      case ("rate_of_change") {
        var.update $condition_phrase {
          value = ($p_metric_key|to_text) ~ " changes by more than " ~ ($p_threshold|to_text) ~ " between consecutive readings"
        }
      } break

      case ("flatline") {
        var.update $condition_phrase {
          value = ($p_metric_key|to_text) ~ " stops changing between readings, which usually means a stuck sensor rather than a stable machine"
        }
      } break

      case ("offline") {
        var.update $condition_phrase {
          value = "the device stops reporting for longer than its device type's offline window"
        }
      } break

      case ("anomaly") {
        var.update $condition_phrase {
          value = ($p_metric_key|to_text) ~ " deviates from that device's own learned baseline by more than " ~ ($p_z_threshold|to_text) ~ " standard deviations"
        }
      } break

      default {
        var.update $condition_phrase {
          value = "meets its condition"
        }
      }
    }

    // Scope phrase, assembled from whichever scopes actually resolved. "every device in the fleet" is stated explicitly, because an unscoped rule is the one most likely to be a misread.
    var $scope_phrase {
      value = "every device in the fleet"
    }

    conditional {
      if (($dt_id != null) && ($site_id != null)) {
        var.update $scope_phrase {
          value = "devices of type " ~ $dt_label ~ " at site " ~ $site_label
        }
      }
      elseif ($dt_id != null) {
        var.update $scope_phrase {
          value = "devices of type " ~ $dt_label ~ " at every site"
        }
      }
      elseif ($site_id != null) {
        var.update $scope_phrase {
          value = "every device at site " ~ $site_label
        }
      }
    }

    // The restatement itself.
    var $restatement {
      value = "Raise a " ~ ($p_severity|to_text) ~ " alert on " ~ $scope_phrase ~ " when " ~ $condition_phrase ~ ". At most one alert per device per " ~ ($p_cooldown_seconds|to_text) ~ " seconds."
    }

    // CAVEATS are separate from the restatement on purpose: they describe what the ENGINE will do, which is not always what the sentence asked for. Hiding this would make the confirmation step worthless.
    var $caveats {
      value = []
    }

    // The honest one. window_seconds is stored on the rule but the current rule engine (fn_evaluate_rules) evaluates one reading at a time and never reads it, so a sustain window does not delay the first alert - the cooldown is what actually limits repeats.
    conditional {
      if ($p_window_seconds > 0) {
        array.push $caveats {
          value = "The sentence asks for the condition to hold for " ~ ($p_window_seconds|to_text) ~ " seconds. That window is stored on the rule, but the current rule engine evaluates each reading independently and does not yet enforce a sustain window, so the first breaching reading will alert. The " ~ ($p_cooldown_seconds|to_text) ~ "-second cooldown is what limits repeats."
        }
      }
    }

    // A fleet-wide rule is the most common misread of a sentence that named a scope the vocabulary did not have.
    conditional {
      if (($dt_id == null) && ($site_id == null)) {
        array.push $caveats {
          value = "This rule is scoped to the whole fleet. If the sentence meant one device type or one site, name it with a code from the fleet vocabulary and re-run."
        }
      }
    }

    // Anomaly rules need a warmed baseline before they can say anything, which surprises people on a fresh workspace.
    conditional {
      if ($p_condition == "anomaly") {
        array.push $caveats {
          value = "Anomaly rules compare against a per-device EWMA baseline that needs about 20 readings per metric before it produces a z-score, so this rule will stay quiet on newly provisioned devices."
        }
      }
    }

    // The proposal exactly as it would be inserted, ids resolved and clamps applied, so the response and the row can never disagree.
    var $proposal_out {
      value = {
        name                   : $p_name
        description            : $p_description
        condition              : $p_condition
        metric_key             : $p_metric_key
        threshold              : $p_threshold
        threshold_high         : $p_threshold_high
        window_seconds         : $p_window_seconds
        z_threshold            : $p_z_threshold
        severity               : $p_severity
        cooldown_seconds       : $p_cooldown_seconds
        enabled                : true
        device_type_id         : $dt_id
        device_type_code       : $p_dt_code
        site_id                : $site_id
        site_code              : $p_site_code
        ai_generated           : true
        natural_language_source: $input.text
      }
    }

    // Filled only on the save path, so a null rule_id in the response unambiguously means "nothing was written".
    var $rule_id {
      value = null
    }

    // Distinguishes "you asked me not to save" from "I could not save this".
    var $saved {
      value = false
    }

    // Persist only when the caller asked AND the proposal validated. Both gates, because save=true on an invalid proposal is a request to write a rule that cannot fire.
    conditional {
      if (($input.save == true) && $valid) {
        db.add alert_rule {
          data = {
            created_at             : "now"
            name                   : $p_name
            description            : $p_description
            device_type_id         : $dt_id
            site_id                : $site_id
            metric_key             : $p_metric_key
            condition              : $p_condition
            threshold              : $p_threshold
            threshold_high         : $p_threshold_high
            window_seconds         : $p_window_seconds
            z_threshold            : $p_z_threshold
            severity               : $p_severity
            enabled                : true
            cooldown_seconds       : $p_cooldown_seconds
            created_by             : $user.id
            natural_language_source: $input.text
            ai_generated           : true
            fire_count             : 0
          }
        } as $rule

        var.update $rule_id {
          value = $rule.id
        }

        var.update $saved {
          value = true
        }

        // The sentence, the proposal and who accepted it. An AI-generated rule that pages someone has to be traceable back to the human who confirmed it.
        function.run "Nerve/fn_audit" {
          input = {
            user_id    : $user.id
            action     : "alert_rule.create"
            entity_type: "alert_rule"
            entity_id  : $rule.id
            detail     : {
              source_text  : $input.text
              proposal     : $proposal_out
              restatement  : $restatement
              caveats      : $caveats
              warnings     : $warnings
              ai_generated : true
              fallback_used: $fallback_used
            }
            source     : "ui"
          }
        } as $audit
      }
    }

    // Measured, not estimated.
    var $latency_ms {
      value = ("now"|to_ms) - $started_ms
    }

    // One sentence the UI can show without re-deriving state from four booleans.
    var $status_note {
      value = "Proposal ready for confirmation."
    }

    conditional {
      if ($saved) {
        var.update $status_note {
          value = "Rule saved and enabled."
        }
      }
      elseif ($valid == false) {
        var.update $status_note {
          value = "The proposal was not saved because it did not validate: " ~ ($violations|join:" ")
        }
      }
    }
  }

  response = {
    success      : true
    valid        : $valid
    saved        : $saved
    rule_id      : $rule_id
    status_note  : $status_note
    proposal     : $proposal_out
    restatement  : $restatement
    caveats      : $caveats
    violations   : $violations
    warnings     : $warnings
    fallback_used: $fallback_used
    model        : $synth.model
    insight_id   : $synth.insight_id
    latency_ms   : $latency_ms
  }
  tags = ["nerve"]
  guid = "_BgSAs06mpnbyDSizZyxViRRvkU"
}
