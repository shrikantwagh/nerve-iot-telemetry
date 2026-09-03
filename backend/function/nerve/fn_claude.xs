// The single Anthropic wrapper every Nerve AI feature reuses. Server-side by design: the key never reaches the browser, and every inference is logged to ai_insight with model, tokens and latency.
function "Nerve/fn_claude" {
  description = "Calls the Anthropic Messages API, logs the inference to ai_insight, and degrades to a well-formed empty result instead of throwing so a demo never dead-ends on a missing key or a 429."

  input {
    // System prompt - the role and the output contract given to the model.
    text system

    // The user turn: the evidence the model is asked to reason over.
    text user_prompt

    // Output ceiling. Generous by default because triage answers carry a remediation list.
    int max_tokens?=1500

    // Which ai_insight.kind this call is logged under. Must be one of the table's enum values.
    text kind

    // Optional provenance so an insight can be shown next to the thing it is about.
    int device_id?

    // Optional provenance for incident-scoped inferences.
    int incident_id?

    // Human-readable label stored on the insight row.
    text title?

    // When true, strip any markdown fence and attempt to decode the reply as JSON.
    bool expect_json?=false
  }

  stack {
    // Stamp the start so latency is measured, not estimated - the ai_insight row is the audit trail.
    var $started_ms {
      value = "now"|to_ms
    }

    // Model is env-driven so it can be rolled forward without touching any caller.
    var $model {
      value = $env.ANTHROPIC_MODEL|first_notempty:"claude-sonnet-5"
    }

    // Fallback-shaped defaults up front, so the response object is identical whether or not the call happens.
    var $text {
      value = ""
    }

    // Parsed JSON payload, populated only when expect_json is set and decoding succeeds.
    var $json {
      value = null
    }

    // Assume fallback until a 200 proves otherwise - this is what tells callers to run their deterministic path.
    var $fallback_used {
      value = true
    }

    // Non-fatal reason string; ends up on the ai_insight row for debugging without breaking the caller.
    var $error {
      value = null
    }

    // Token counters default to 0 so the insight row is always numerically sane.
    var $input_tokens {
      value = 0
    }

    // Output token counter, same reasoning.
    var $output_tokens {
      value = 0
    }

    // Distinguishes "the model was not asked for JSON" from "the model returned unparseable JSON".
    var $parse_failed {
      value = false
    }

    // Placeholders for the HTTP outcome, declared here so they are readable after the conditional.
    var $status {
      value = 0
    }

    // Parsed response body, kept separate from $status for the same reason.
    var $raw {
      value = null
    }

    // A missing key is a configuration state, not an exception. Detect it before spending a request.
    var $can_call {
      value = !($env.ANTHROPIC_API_KEY|is_empty)
    }

    // Built as a variable rather than inline: filter chains bind greedily and the concatenated key would be swallowed by the next push.
    var $headers {
      value = []|push:("x-api-key: " ~ $env.ANTHROPIC_API_KEY)|push:"anthropic-version: 2023-06-01"|push:"Content-Type: application/json"
    }

    // Only reach out when there is a key to reach out with.
    conditional {
      if ($can_call) {
        // 45s ceiling: long enough for a triage answer with a remediation list, short enough that a task run cannot hang.
        api.request {
          url = "https://api.anthropic.com/v1/messages"
          method = "POST"
          params = {
            model     : $model
            max_tokens: $input.max_tokens
            system    : $input.system
            messages  : [{role: "user", content: $input.user_prompt}]
          }
          headers = $headers
          timeout = 45
        } as $res

        // Copy out of the step result so the values survive past this block.
        var.update $status {
          value = $res.status
        }

        // Body is only trusted after the status check below.
        var.update $raw {
          value = $res.response
        }
      }
    }

    // Three outcomes, kept flat: success, HTTP failure, no key. Nested if-inside-else is not supported in XanoScript.
    conditional {
      if ($status == 200) {
        // Anthropic returns `content` as an array of blocks; the assistant prose is the first block's `text`.
        var $blocks {
          value = ($raw|get:"content":[])|safe_array
        }

        // Empty-string default keeps callers from having to null-check the happy path.
        var.update $text {
          value = ($blocks|first)|get:"text":""
        }

        // Token accounting comes from the response envelope, defaulted because usage is not contractually guaranteed.
        var.update $input_tokens {
          value = ($raw|get:"usage.input_tokens":0)|to_int
        }

        // Output side of the same accounting.
        var.update $output_tokens {
          value = ($raw|get:"usage.output_tokens":0)|to_int
        }

        // Only here is the result genuinely model-generated.
        var.update $fallback_used {
          value = false
        }
      }
      elseif ($can_call) {
        // 429 / 5xx / 400: record it and let the caller apply its own deterministic analysis.
        var.update $error {
          value = "Anthropic HTTP " ~ ($status|to_text)
        }
      }
      else {
        // No key configured. The product still has to work for a judge with a fresh workspace.
        var.update $error {
          value = "ANTHROPIC_API_KEY is not set - deterministic fallback used."
        }
      }
    }

    // Models habitually wrap strict JSON in a ```json fence; strip it before decoding rather than blaming the model.
    conditional {
      if ($input.expect_json == true && !($text|is_empty)) {
        var $cleaned {
          value = ((($text|trim)|replace:"```json":"")|replace:"```":"")|trim
        }

        // json_decode on malformed text must not take the whole ingest path down with it.
        try_catch {
          try {
            var.update $json {
              value = $cleaned|json_decode
            }
          }
          catch {
            var.update $json {
              value = null
            }
          }
        }

        // Report an honest parse failure instead of faking a structured answer.
        conditional {
          if (($json|is_null) == true) {
            var.update $parse_failed {
              value = true
            }
          }
        }
      }
    }

    // Measured, not guessed - this is the number the ai_insight table exists to hold.
    var $latency_ms {
      value = ("now"|to_ms) - $started_ms
    }

    // Every call is logged, including the fallbacks. An unlogged inference is an unauditable one.
    db.add ai_insight {
      data = {
        created_at   : "now"
        kind         : $input.kind
        device_id    : $input.device_id
        incident_id  : $input.incident_id
        title        : $input.title
        body         : $text
        model        : $model
        input_tokens : $input_tokens
        output_tokens: $output_tokens
        latency_ms   : $latency_ms
        fallback_used: $fallback_used
        error        : $error
      }
    } as $insight
  }

  response = {
    text         : $text
    json         : $json
    fallback_used: $fallback_used
    parse_failed : $parse_failed
    model        : $model
    insight_id   : $insight.id
    latency_ms   : $latency_ms
    error        : $error
  }
  tags = ["nerve"]
}
